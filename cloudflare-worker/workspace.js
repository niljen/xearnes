// Xearnes Workspace : routes privées pour l'espace de travail des agents.
//  /ws/*     : fichiers et historiques des projets, stockés sur le serveur Oracle (le Worker relaie, avec la clé d'accès d'Oracle)
//  /ws-llm   : appel d'un modèle (GPU RunPod ou Oracle) pour un agent, avec un plafond d'appels par jour
// Accès : jeton de connexion valide ET adresse email dans la liste WS_ALLOWED. Tout le reste reçoit 401 ou 403.
import { tierFromRequest } from "./auth.js";
import { podConfig, loadPod, savePod, isWarm, maybeWake, askPod } from "./pods.js";

const MAX_BODY = 400 * 1024;
const MAX_MESSAGES = 40;
const MAX_CHARS = 120000;
const DEFAULT_DAILY_CALLS = 150;
const MODELS = ["large", "mid", "small", "oracle"];

export function allowedEmails(env) {
  return String((env && env.WS_ALLOWED) || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// -> { ok:true, email } | { ok:false, status, error }
export async function checkAccess(request, env) {
  const { email } = await tierFromRequest(request, env);
  if (!email) return { ok: false, status: 401, error: "login_required" };
  if (!allowedEmails(env).includes(email)) return { ok: false, status: 403, error: "not_allowed" };
  return { ok: true, email };
}

function j(status, obj, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function readLimited(request) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return null;
  return buf;
}

async function proxy(request, env, cors, path) {
  if (!env.OLLAMA_URL) return j(502, { error: "oracle_not_configured" }, cors);
  if (!["GET", "PUT", "POST", "DELETE"].includes(request.method)) return j(405, { error: "method" }, cors);
  let body;
  if (request.method === "PUT" || request.method === "POST") {
    body = await readLimited(request);
    if (body === null) return j(413, { error: "too_large" }, cors);
  }
  const url = new URL(request.url);
  const target = new URL(env.OLLAMA_URL).origin + path + url.search;
  const headers = { "Content-Type": request.headers.get("Content-Type") || "application/json" };
  if (env.OLLAMA_AUTH_KEY) headers["X-Xearnes-Key"] = env.OLLAMA_AUTH_KEY;
  try {
    const r = await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return j(502, { error: "oracle_unreachable" }, cors);
  }
}

async function dailyCallAllowed(env) {
  const cap = Number(env.WS_DAILY_CALLS) || DEFAULT_DAILY_CALLS;
  if (!env.WAKE_KV) return true;
  const key = "wsllm:" + new Date().toISOString().slice(0, 10);
  try {
    const n = Number(await env.WAKE_KV.get(key)) || 0;
    if (n >= cap) return false;
    await env.WAKE_KV.put(key, String(n + 1), { expirationTtl: 172800 });
    return true;
  } catch {
    return false; // dans le doute on ne dépense pas
  }
}

function cleanMessages(arr) {
  if (!Array.isArray(arr) || !arr.length || arr.length > MAX_MESSAGES) return null;
  let total = 0;
  const out = [];
  for (const m of arr) {
    if (!m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string") return null;
    total += m.content.length;
    out.push({ role: m.role, content: m.content });
  }
  return total > MAX_CHARS ? null : out;
}

async function llm(request, env, ctx, cors) {
  let b;
  try { b = await request.json(); } catch { return j(400, { error: "bad_json" }, cors); }
  const model = String(b.model || "");
  const messages = cleanMessages(b.messages);
  if (!MODELS.includes(model) || !messages) return j(400, { error: "bad_request" }, cors);
  const maxTokens = Math.max(200, Math.min(3000, Number(b.max_tokens) || 1500));

  if (model === "oracle") {
    if (!env.OLLAMA_URL) return j(502, { error: "oracle_not_configured" }, cors);
    if (!(await dailyCallAllowed(env))) return j(429, { error: "daily_limit" }, cors);
    const headers = { "Content-Type": "application/json" };
    if (env.OLLAMA_AUTH_KEY) headers["X-Xearnes-Key"] = env.OLLAMA_AUTH_KEY;
    try {
      const r = await fetch(env.OLLAMA_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: env.WS_ORACLE_MODEL || env.OLLAMA_MODEL || "gemma3:4b", messages, stream: false, options: { num_predict: maxTokens, temperature: 0.3 } }),
        signal: AbortSignal.timeout(110000),
      });
      if (!r.ok) return j(502, { ok: false, status: "failed", error: "oracle_http_" + r.status }, cors);
      const d = await r.json();
      const text = d && d.message && d.message.content ? String(d.message.content).trim() : "";
      if (!text) return j(200, { ok: false, status: "failed" }, cors);
      return j(200, { ok: true, text, model: "oracle" }, cors);
    } catch {
      return j(502, { ok: false, status: "failed", error: "oracle_unreachable" }, cors);
    }
  }

  const cfg0 = podConfig(env, model);
  if (!cfg0) return j(200, { ok: false, status: "unavailable" }, cors);
  const cfg = { ...cfg0, firstTokenMs: 25000 }; // les requêtes d'agents sont longues : on laisse plus de temps avant le premier mot
  const st = await loadPod(env, cfg);
  if (!(await isWarm(env, cfg, st))) {
    await maybeWake(env, cfg, st, ctx); // réveil limité par le budget quotidien du pod ; l'appli réessaie toutes les quelques secondes
    return j(200, { ok: false, status: "warming", pod: cfg.name }, cors);
  }
  if (!(await dailyCallAllowed(env))) return j(429, { error: "daily_limit" }, cors);
  const text = await askPod(cfg, messages, maxTokens);
  if (!text) {
    st.warmUntil = 0;
    if (ctx && ctx.waitUntil) ctx.waitUntil(savePod(env, cfg, st)); else await savePod(env, cfg, st);
    return j(200, { ok: false, status: "failed", pod: cfg.name }, cors);
  }
  st.warmUntil = Date.now() + cfg.idleMs;
  if (ctx && ctx.waitUntil) ctx.waitUntil(savePod(env, cfg, st)); else await savePod(env, cfg, st);
  return j(200, { ok: true, text, model: cfg.name }, cors);
}

// Renvoie une Response si le chemin concerne le Workspace, sinon null.
export async function handleWorkspace(request, env, ctx, cors) {
  const path = new URL(request.url).pathname;
  const isLlm = path === "/ws-llm";
  const isFiles = path === "/ws" || path.startsWith("/ws/");
  if (!isLlm && !isFiles) return null;
  const acc = await checkAccess(request, env);
  if (!acc.ok) return j(acc.status, { error: acc.error }, cors);
  if (isLlm) {
    if (request.method !== "POST") return j(405, { error: "method" }, cors);
    return llm(request, env, ctx, cors);
  }
  return proxy(request, env, cors, path);
}
