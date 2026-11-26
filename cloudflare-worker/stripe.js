// Webhook Stripe : écrit le niveau d'abonnement dans SUBSCRIPTIONS (clé = email en minuscules), lu ensuite par auth.js.
// L'email n'est pas dans les événements « subscription » : on le retient depuis « checkout.session.completed »
// et on garde l'état par client Stripe (clé « stripe:<client> », qui ne peut pas être confondue avec un email).
// Les deux événements peuvent arriver dans n'importe quel ordre ; le niveau est écrit dès qu'on a les deux.

const enc = new TextEncoder();
const GRACE_MS = 2 * 86400000; // marge si le renouvellement tarde un peu

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Signature Stripe : en-tête « t=...,v1=... » ; HMAC-SHA256 de « t.corps » ; 5 minutes de tolérance. Sans secret : toujours refusé.
export async function verifyStripeSignature(body, header, secret, nowMs = Date.now()) {
  if (!secret || !header) throw new Error("no_secret_or_header");
  let t = "";
  const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !v1.length || !/^\d+$/.test(t)) throw new Error("bad_header");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expect = hex(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + body)));
  if (!v1.some((s) => safeEqual(expect, s))) throw new Error("bad_signature");
  if (Math.abs(nowMs / 1000 - Number(t)) > 300) throw new Error("too_old");
  return JSON.parse(body);
}

// Le niveau se reconnaît à l'identifiant du prix (price_...) ou du produit (prod_...) : les deux sont dans l'événement Stripe.
export function priceToTier(price, env) {
  const ids = typeof price === "string" ? [price] : [price && price.id, price && typeof price.product === "string" ? price.product : price && price.product && price.product.id];
  const is = (want) => !!want && ids.includes(want);
  if (is(env.STRIPE_PRICE_LEGEND)) return "legend";
  if (is(env.STRIPE_PRICE_ULTRA)) return "ultra";
  if (is(env.STRIPE_PRICE_PRO)) return "pro";
  // Secours : le prix mensuel en SEK (les identifiants peuvent changer entre le bac à sable et le mode réel)
  if (price && typeof price === "object" && String(price.currency || "").toLowerCase() === "sek") {
    const a = Number(price.unit_amount);
    if (a === 50000) return "legend";
    if (a === 35000) return "ultra";
    if (a === 20000) return "pro";
  }
  return "free";
}

async function readPart(env, customer, part) {
  try {
    const raw = await env.SUBSCRIPTIONS.get("stripe:" + customer + ":" + part);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const RANK = { pro: 1, ultra: 2, legend: 3 };

// Écrit le niveau de l'email : le plus haut parmi tous ses abonnements actifs (chaque lien de paiement crée un nouveau client Stripe,
// donc une même personne peut avoir plusieurs abonnements ; annuler un ancien ne doit pas la faire retomber à « gratuit »).
async function applyState(env, st, customer) {
  if (!st.email) return;
  const ids = new Set([customer]);
  try {
    const l = await env.SUBSCRIPTIONS.list({ prefix: "stripe-email:" + st.email + ":" });
    for (const k of l.keys || []) ids.add(k.name.slice(("stripe-email:" + st.email + ":").length));
  } catch {}
  let best = null;
  for (const id of ids) {
    const sub = await readPart(env, id, "sub");
    const active = (sub.status === "active" || sub.status === "trialing") && RANK[sub.tier];
    if (!active) continue;
    if (!best || RANK[sub.tier] > RANK[best.tier] || (RANK[sub.tier] === RANK[best.tier] && (sub.periodEnd || 0) > (best.periodEnd || 0))) best = sub;
  }
  if (!best && st.status === undefined && ids.size === 1) return; // email connu mais pas encore d'abonnement : rien à écrire
  const value = best ? { tier: best.tier, expires: (best.periodEnd || 0) + GRACE_MS } : { tier: "free", expires: 0 };
  await env.SUBSCRIPTIONS.put(st.email, JSON.stringify(value));
}

// ── E-mails de résiliation (Stripe n'en envoie pas) : envoyés par Resend, une seule fois par abonnement et par étape ──
const PLAN_NAME = { pro: "Pro", ultra: "Super", legend: "Ultimate" };
function fmtDate(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
export function cancelMail(kind, plan, endMs) {
  const p = PLAN_NAME[plan] || "Xearnes";
  const day = endMs ? fmtDate(endMs) : "";
  if (kind === "scheduled") {
    return {
      s: "Xearnes: din prenumeration är uppsagd / your subscription is cancelled",
      b: [
        "Hej! Din prenumeration Xearnes " + p + " är uppsagd. Den fortsätter till " + (day || "slutet av den betalda perioden") + " och upphör sedan. Inga fler betalningar dras.",
        "Vill du fortsätta ändå kan du återuppta prenumerationen via ”Hantera min prenumeration” i Xearnes innan dess.",
        "",
        "Hi! Your Xearnes " + p + " subscription is cancelled. It stays active until " + (day || "the end of the paid period") + " and then stops. No further payments will be taken.",
        "If you change your mind, you can resume it from “Manage my subscription” in Xearnes before then.",
        "",
        "Bonjour ! Ton abonnement Xearnes " + p + " est résilié. Il reste actif jusqu'au " + (day || "la fin de la période payée") + ", puis il s'arrête. Aucun autre paiement ne sera prélevé.",
        "",
        "Frågor / Questions : xearnes.ai@gmail.com",
        "The Xearnes team",
      ].join("\n"),
    };
  }
  return {
    s: "Xearnes: din prenumeration har upphört / your subscription has ended",
    b: [
      "Hej! Din prenumeration Xearnes " + p + " har nu upphört. Du kan fortfarande använda den gratis chatten, och du kan prenumerera igen när du vill.",
      "",
      "Hi! Your Xearnes " + p + " subscription has now ended. You can still use the free chat, and you can subscribe again at any time.",
      "",
      "Bonjour ! Ton abonnement Xearnes " + p + " est terminé. Tu peux toujours utiliser le chat gratuit et te réabonner quand tu veux.",
      "",
      "Frågor / Questions : xearnes.ai@gmail.com",
      "The Xearnes team",
    ].join("\n"),
  };
}
async function sendCancelMail(env, customer, subId, kind, plan, endMs) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !subId) return;
  const key = "stripe-mail:" + subId + ":" + kind + (kind === "scheduled" ? ":" + (endMs || 0) : "");
  if (await env.SUBSCRIPTIONS.get(key)) return; // déjà envoyé
  const to = (await readPart(env, customer, "email")).email;
  if (!to) return;
  const m = cancelMail(kind, plan, endMs);
  try {
    const r = await fetch((env.RESEND_BASE_URL || "https://api.resend.com") + "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RESEND_API_KEY },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: m.s, text: m.b }),
    });
    if (r.ok) await env.SUBSCRIPTIONS.put(key, "1", { expirationTtl: 400 * 86400 });
  } catch {}
}

export async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.SUBSCRIPTIONS) return new Response("Not configured", { status: 503 });
  const body = await request.text();
  let event;
  try {
    event = await verifyStripeSignature(body, request.headers.get("stripe-signature") || "", env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    const obj = (event.data && event.data.object) || {};
    const customer = typeof obj.customer === "string" ? obj.customer : "";
    if (!customer) return new Response("OK");
    // L'email et l'abonnement sont gardés dans deux entrées séparées : les deux événements arrivent presque en même temps,
    // et une entrée unique était écrasée par celui qui écrit en dernier (constaté au premier essai).
    if (event.type === "checkout.session.completed") {
      const email = String((obj.customer_details && obj.customer_details.email) || obj.customer_email || "").trim().toLowerCase();
      if (email) {
        await env.SUBSCRIPTIONS.put("stripe:" + customer + ":email", JSON.stringify({ email }));
        await env.SUBSCRIPTIONS.put("stripe-email:" + email + ":" + customer, "1");
      }
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const item = obj.items && obj.items.data && obj.items.data[0];
      // Selon la version de l'API Stripe, la fin de période est sur l'abonnement ou sur la ligne
      const end = obj.current_period_end || (item && item.current_period_end) || 0;
      const sub = {
        tier: priceToTier(item && item.price, env),
        status: event.type === "customer.subscription.deleted" ? "canceled" : String(obj.status || ""),
        periodEnd: end * 1000,
      };
      // Formule inconnue sur un abonnement encore actif : on garde la formule connue avant plutôt que de faire retomber le client à « gratuit »
      if (sub.tier === "free" && event.type !== "customer.subscription.deleted") {
        const prev = await readPart(env, customer, "sub");
        if (prev && RANK[prev.tier]) sub.tier = prev.tier;
      }
      await env.SUBSCRIPTIONS.put("stripe:" + customer + ":sub", JSON.stringify(sub));
      // Confirmation de résiliation : demandée (fin de période) ou effective
      const pa = (event.data && event.data.previous_attributes) || {};
      const asked = event.type === "customer.subscription.updated" &&
        ((obj.cancel_at_period_end === true && pa.cancel_at_period_end === false) || (obj.cancel_at && "cancel_at" in pa && !pa.cancel_at));
      if (asked) await sendCancelMail(env, customer, obj.id, "scheduled", sub.tier, obj.cancel_at ? obj.cancel_at * 1000 : sub.periodEnd);
      if (event.type === "customer.subscription.deleted") await sendCancelMail(env, customer, obj.id, "ended", sub.tier, 0);
    } else {
      return new Response("OK");
    }
    // On relit les deux entrées : même si l'autre événement vient d'arriver, rien n'est perdu
    const st = { ...(await readPart(env, customer, "email")), ...(await readPart(env, customer, "sub")) };
    await applyState(env, st, customer);
    return new Response("OK");
  } catch {
    return new Response("Error", { status: 500 }); // Stripe réessaie
  }
}
