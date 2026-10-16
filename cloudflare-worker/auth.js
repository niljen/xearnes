// Vérification de l'email par code + jeton signé + niveau d'abonnement.
// Principe : l'email d'un abonné ne suffit jamais. Il faut recevoir un code à 6 chiffres sur cette adresse.
// Le navigateur garde ensuite un jeton signé (valable 30 jours) ; le niveau est relu dans KV à chaque requête
// (une résiliation prend donc effet tout de suite, et le navigateur ne peut pas se donner un niveau lui-même).

const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(data));
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparaison à temps constant
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const normEmail = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

// ── Jeton signé : base64url(charge).signature ──
export async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return body + "." + sig;
}

export async function verifyToken(token, secret) {
  if (!token || !secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expect = b64url(await hmac(secret, parts[0]));
  if (!safeEqual(expect, parts[1])) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (!p || !p.e || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// ── Niveau d'abonnement lu dans KV (clé = email en minuscules). Valeurs : free / pro / ultra / legend ──
export async function tierFor(env, email) {
  if (!env.SUBSCRIPTIONS || !email) return "free";
  try {
    const raw = await env.SUBSCRIPTIONS.get(normEmail(email));
    if (!raw) return "free";
    const sub = JSON.parse(raw);
    if (sub.expires && sub.expires < Date.now()) return "free";
    return ["pro", "ultra", "legend"].includes(sub.tier) ? sub.tier : "free";
  } catch {
    return "free";
  }
}

// Niveau de la requête : jeton valide dans l'en-tête Authorization, sinon gratuit.
export async function tierFromRequest(request, env) {
  const h = request.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const p = await verifyToken(tok, env.TOKEN_SECRET);
  if (!p) return { tier: "free", email: "" };
  return { tier: await tierFor(env, p.e), email: p.e };
}

// ── Limites par KV (compteurs avec durée de vie) ──
async function bumpLimit(env, key, ttl) {
  if (!env.WAKE_KV) return 0;
  try {
    const n = (Number(await env.WAKE_KV.get(key)) || 0) + 1;
    await env.WAKE_KV.put(key, String(n), { expirationTtl: Math.max(ttl, 60) });
    return n;
  } catch {
    return 0;
  }
}

// ── Envoi du code par email (Resend). Sans configuration : l'appel échoue proprement, le code n'est jamais renvoyé au navigateur. ──
export async function sendCodeEmail(env, to, code, lang) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  const t = {
    fr: { s: "Ton code Xearnes", b: `Ton code de connexion Xearnes : ${code}\n\nIl est valable 10 minutes. Si tu n'as rien demandé, ignore ce message.` },
    sv: { s: "Din Xearnes-kod", b: `Din inloggningskod för Xearnes: ${code}\n\nKoden gäller i 10 minuter. Om du inte har bett om den kan du ignorera det här mejlet.` },
    en: { s: "Your Xearnes code", b: `Your Xearnes sign-in code: ${code}\n\nIt is valid for 10 minutes. If you did not ask for it, ignore this message.` },
  }[lang] || null;
  const m = t || { s: "Your Xearnes code", b: `Your Xearnes sign-in code: ${code}\n\nIt is valid for 10 minutes.` };
  try {
    const r = await fetch((env.RESEND_BASE_URL || "https://api.resend.com") + "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: m.s, text: m.b }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const CODE_TTL_S = 600;
const MAX_TRIES = 5;
const TOKEN_DAYS = 30;

// POST /auth/request {email, lang}
export async function handleAuthRequest(body, request, env) {
  const email = normEmail(body && body.email);
  if (!validEmail(email)) return { status: 400, json: { error: "invalid_email" } };
  if (!env.TOKEN_SECRET || !env.WAKE_KV) return { status: 503, json: { error: "auth_not_configured" } };
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const eh = await sha256Hex(email);
  // Limites : 5 codes par heure et par email, 20 par heure et par adresse IP
  if ((await bumpLimit(env, "rl:email:" + eh, 3600)) > 5) return { status: 429, json: { error: "too_many_requests" } };
  if ((await bumpLimit(env, "rl:ip:" + (await sha256Hex(ip)), 3600)) > 20) return { status: 429, json: { error: "too_many_requests" } };
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  const code = String(n).padStart(6, "0");
  const rec = { h: await sha256Hex(code + ":" + env.TOKEN_SECRET + ":" + email), tries: 0 };
  await env.WAKE_KV.put("code:" + eh, JSON.stringify(rec), { expirationTtl: CODE_TTL_S });
  const sent = await sendCodeEmail(env, email, code, (body && body.lang) || "fr");
  if (!sent) return { status: 503, json: { error: "email_not_sent" } };
  // Même réponse que l'email ait un abonnement ou non : on ne révèle rien
  return { status: 200, json: { ok: true } };
}

// POST /auth/verify {email, code} -> {token, tier}
export async function handleAuthVerify(body, env) {
  const email = normEmail(body && body.email);
  const code = String((body && body.code) || "").trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return { status: 400, json: { error: "invalid_input" } };
  if (!env.TOKEN_SECRET || !env.WAKE_KV) return { status: 503, json: { error: "auth_not_configured" } };
  const key = "code:" + (await sha256Hex(email));
  const raw = await env.WAKE_KV.get(key);
  if (!raw) return { status: 400, json: { error: "code_expired" } };
  const rec = JSON.parse(raw);
  if (rec.tries >= MAX_TRIES) { await env.WAKE_KV.delete(key); return { status: 429, json: { error: "too_many_tries" } }; }
  const given = await sha256Hex(code + ":" + env.TOKEN_SECRET + ":" + email);
  if (!safeEqual(given, rec.h)) {
    rec.tries++;
    await env.WAKE_KV.put(key, JSON.stringify(rec), { expirationTtl: CODE_TTL_S });
    return { status: 400, json: { error: "wrong_code" } };
  }
  await env.WAKE_KV.delete(key); // un code ne sert qu'une fois
  const token = await signToken({ e: email, exp: Date.now() + TOKEN_DAYS * 86400000 }, env.TOKEN_SECRET);
  return { status: 200, json: { token, tier: await tierFor(env, email) } };
}

// GET /auth/me (Authorization: Bearer ...) -> {tier}
export async function handleAuthMe(request, env) {
  const { tier } = await tierFromRequest(request, env);
  return { status: 200, json: { tier } };
}
