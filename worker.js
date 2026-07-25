// Xearnes Cloudflare Worker — VERSION-17
// Tier gratuit → Phi-4 14B fine-tuné sur RunPod Serverless
// Added: /koko route for Koko AI with web_search tool
// KV binding requis : SUBSCRIPTIONS (dans Cloudflare dashboard → Workers → KV)
// Variables d'environnement : CLAUDE_API_KEY, STRIPE_WEBHOOK_SECRET

const ALLOWED_ORIGINS = [
  "https://niljen.github.io",
  "http://localhost:3000",
  "http://localhost:3001",
  "null", // fichiers ouverts en local (file://)
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Rate limiting simple par IP (requêtes par minute)
const _rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const key = ip;
  const entry = _rateLimitMap.get(key) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  _rateLimitMap.set(key, entry);
  return entry.count > 30; // max 30 requêtes/minute
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Vérification d'origine
    const origin = request.headers.get("Origin") || "";
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Accès refusé", { status: 403 });
    }

    // Rate limiting
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ error: { message: "Trop de requêtes. Attends une minute." } }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const url = new URL(request.url);

    // ── Vérification abonnement ──
    if (url.pathname === "/check-sub") {
      const email = url.searchParams.get("email") || "";
      if (!email) return json({ tier: "free" });
      const data = await env.SUBSCRIPTIONS.get(email.toLowerCase());
      if (!data) return json({ tier: "free" });
      const sub = JSON.parse(data);
      if (sub.expires && sub.expires < Date.now()) return json({ tier: "free" });
      return json({ tier: sub.tier || "free" });
    }

    // ── Webhook Stripe ──
    if (url.pathname === "/stripe-webhook" && request.method === "POST") {
      const body = await request.text();
      const sig = request.headers.get("stripe-signature") || "";

      // Vérification signature Stripe
      let event;
      try {
        event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        return new Response("Signature invalide", { status: 400 });
      }

      const obj = event.data.object;
      const email = (obj.customer_email || obj.metadata?.email || "").toLowerCase();
      if (!email) return new Response("OK");

      if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
        const priceId = obj.items?.data?.[0]?.price?.id || "";
        const tier = priceToTier(priceId, env);
        const expires = (obj.current_period_end || 0) * 1000;
        if (obj.status === "active") {
          await env.SUBSCRIPTIONS.put(email, JSON.stringify({ tier, expires }));
        }
      }

      if (event.type === "customer.subscription.deleted") {
        await env.SUBSCRIPTIONS.put(email, JSON.stringify({ tier: "free", expires: 0 }));
      }

      return new Response("OK");
    }

    // ── Proxy Claude (existant) ──
    if (request.method === "POST" && url.pathname === "/") {
      const body = await request.json();

      // Tier gratuit → Xearnes Phi-4 fine-tuné sur RunPod Serverless
      if (body._tier === "free" && env.RUNPOD_API_KEY) {
        const messages = [
          { role: "system", content: body.system || "" },
          ...(body.messages || [])
        ];
        const runpodBody = {
          input: {
            model: "niljen/xearnes-phi4",
            messages,
            max_tokens: body.max_tokens || 2500,
            temperature: 0.7,
          }
        };
        const response = await fetch("https://api.runpod.ai/v2/reg74qzhf20zsd/runsync", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.RUNPOD_API_KEY}`,
          },
          body: JSON.stringify(runpodBody),
        });
        const data = await response.json();
        const text = data.output?.choices?.[0]?.message?.content || data.error || JSON.stringify(data);
        return new Response(JSON.stringify({
          content: [{ type: "text", text }],
          stop_reason: "end_turn"
        }), {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/json" },
        });
      }

      // Tiers payants → Claude
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
      };
      if (body.tools && body.tools.some(t => t.type && t.type.startsWith("web_search"))) {
        headers["anthropic-beta"] = "web-search-2025-03-05";
      }
      // Enlever le champ _tier avant d'envoyer à Claude
      delete body._tier;
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Koko AI avec web_search ──
    if (request.method === "POST" && url.pathname === "/koko") {
      const { messages, systemPrompt } = await request.json();

      // Appel Claude avec outil web_search
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          system: systemPrompt,
          tools: [{
            type: "web_search_20260209",
            name: "web_search",
            max_uses: 5,
          }],
          messages,
        }),
      });

      const data = await response.json();

      // Extraire le texte final de la réponse (après les recherches)
      let finalText = "";
      if (data.content) {
        for (const block of data.content) {
          if (block.type === "text") finalText += block.text;
        }
      }

      return new Response(JSON.stringify({ text: finalText, raw: data }), {
        status: response.status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function priceToTier(priceId, env) {
  // Configure tes Price IDs Stripe ici après les avoir créés
  if (priceId === (env.STRIPE_PRICE_LEGEND || "")) return "legend";
  if (priceId === (env.STRIPE_PRICE_ULTRA || "")) return "ultra";
  if (priceId === (env.STRIPE_PRICE_PRO || "")) return "pro";
  return "free";
}

async function verifyStripeSignature(body, sig, secret) {
  const parts = sig.split(",").reduce((acc, p) => {
    const [k, v] = p.split("=");
    acc[k] = v;
    return acc;
  }, {});
  const ts = parts.t;
  const v1 = parts.v1;
  const signed = `${ts}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const hex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex !== v1) throw new Error("Signature incorrecte");
  if (Math.abs(Date.now() / 1000 - parseInt(ts)) > 300) throw new Error("Trop vieux");
  return JSON.parse(body);
}
