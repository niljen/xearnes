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

export function priceToTier(priceId, env) {
  if (!priceId) return "free";
  if (priceId === env.STRIPE_PRICE_LEGEND) return "legend";
  if (priceId === env.STRIPE_PRICE_ULTRA) return "ultra";
  if (priceId === env.STRIPE_PRICE_PRO) return "pro";
  return "free";
}

async function readState(env, customer) {
  try {
    const raw = await env.SUBSCRIPTIONS.get("stripe:" + customer);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Écrit le niveau quand on connaît l'email et l'état de l'abonnement
async function applyState(env, st) {
  if (!st.email || st.status === undefined) return;
  const active = (st.status === "active" || st.status === "trialing") && st.tier && st.tier !== "free";
  const value = active ? { tier: st.tier, expires: (st.periodEnd || 0) + GRACE_MS } : { tier: "free", expires: 0 };
  await env.SUBSCRIPTIONS.put(st.email, JSON.stringify(value));
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
    const st = await readState(env, customer);

    if (event.type === "checkout.session.completed") {
      const email = String((obj.customer_details && obj.customer_details.email) || obj.customer_email || "").trim().toLowerCase();
      if (email) st.email = email;
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const item = obj.items && obj.items.data && obj.items.data[0];
      st.tier = priceToTier(item && item.price && item.price.id, env);
      st.status = event.type === "customer.subscription.deleted" ? "canceled" : String(obj.status || "");
      // Selon la version de l'API Stripe, la fin de période est sur l'abonnement ou sur la ligne
      const end = obj.current_period_end || (item && item.current_period_end) || 0;
      st.periodEnd = end * 1000;
    } else {
      return new Response("OK");
    }
    await env.SUBSCRIPTIONS.put("stripe:" + customer, JSON.stringify(st));
    await applyState(env, st);
    return new Response("OK");
  } catch {
    return new Response("Error", { status: 500 }); // Stripe réessaie
  }
}
