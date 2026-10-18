// Xearnes AI Worker — Cloudflare Edge
// Proxy vers Ollama auto-hébergé sur Oracle Cloud (Gemma 3 1B), via Cloudflare Tunnel
// NOTE : l'URL du tunnel change si le service cloudflared redémarre côté serveur —
// dans ce cas, mettre à jour le secret OLLAMA_URL (npx wrangler secret put OLLAMA_URL) puis redéployer.
// Le tunnel ne mène plus à Ollama directement mais à une porte nginx qui n'accepte que POST /api/chat avec le secret OLLAMA_AUTH_KEY.

const OLLAMA_URL = ""; // fourni par le secret OLLAMA_URL (jamais écrit dans le dépôt public)
const OLLAMA_MODEL = "gemma3:4b"; // modèle par défaut (choix de Youssef)
const OLLAMA_FALLBACK_MODEL = "gemma3:1b"; // secours si le premier ne répond pas
const OLLAMA_NONSTREAM_TIMEOUT_MS = 120000; // sans streaming, la réponse n'arrive qu'une fois terminée : on attend plus longtemps
const OLLAMA_HEADERS_TIMEOUT_MS = 45000; // si pas de début de réponse après 45 s, on bascule sur le secours

import { handleAuthRequest, handleAuthVerify, handleAuthMe, tierFromRequest } from "./auth.js";
import { handleStripeWebhook } from "./stripe.js";
import { TIER_CHAIN, TIER_MAX_TOKENS, podConfig, loadPod, savePod, isWarm, maybeWake, askPod } from "./pods.js";

// ── RunPod Serverless (GPU) : voir pods.js. Les modèles et leur ordre dépendent du niveau de l'abonné (auth.js). ──

// Questions simples (salutations, calculs courts, blagues) : inutile de payer le GPU.
const HARD_RE = /(?<![\p{L}])(pourquoi|comment|explique|expliquer|raconte|écris|ecris|poème|poeme|histoire|différence|difference|why|how|explain|write|story|poem|varför|hur|förklara|skriv|berätta|hvorfor|forklar)(?![\p{L}])/iu;
// Données personnelles : un message qui en contient ne quitte jamais notre serveur Oracle (il ne part pas chez RunPod).
// On bloque plutôt que de masquer : plus sûr qu'un filtre qui ne retire qu'une partie.
const PII_RE = new RegExp(
  [
    "[\\w.+-]+@[\\w-]+\\.[\\w.-]+", // email
    "(?:\\+|00)?\\d[\\d\\s().-]{7,}\\d", // téléphone / longs numéros
    "(?<![\\p{L}])(?:je m'appelle|je m appelle|my name is|i am called|jag heter|mitt namn är|mitt namn ar|mon nom est)(?![\\p{L}])",
    "(?<![\\p{L}])(?:j'ai|j ai|i am|i'm|jag är|jag ar)\\s+\\d{1,2}\\s*(?:ans|years|år|ar)(?![\\p{L}])",
    "(?<![\\p{L}])(?:j'habite|j habite|i live (?:in|at)|jag bor)(?![\\p{L}])",
    "(?<![\\p{L}])(?:mon adresse|my address|min adress|mon école|mon ecole|my school|min skola)(?![\\p{L}])",
    "\\d+\\s*(?:rue|avenue|boulevard|street|road|gatan|vägen|vagen)(?![\\p{L}])",
  ].join("|"),
  "iu"
);
function hasPersonalInfo(messages) {
  return messages.some((m) => m.role === "user" && typeof m.content === "string" && PII_RE.test(m.content));
}
// Score de difficulté : on ne réveille le GPU (payant) que si la question le mérite. Seuil : 2 points.
const SV_RE = /[åäö]|(?<![\p{L}])(och|inte|jag|varför|hur|vad|förklara|skriv|berätta|kan du)(?![\p{L}])/iu;
const REASON_RE = /(calcul|räkna|compare|jämför|différence|difference|\d+\s*[+×*\/x-]\s*\d+)/iu; // pas \"combien / how many\" : ce sont des questions de faits simples
const CHAT_RE = /^(salut|bonjour|bonsoir|coucou|hello|hi|hey|hej|hejsan|merci|thanks|thank you|tack|ça va|ca va|how are you|hur mår du)/iu;
function difficultyScore(messages) {
  const users = messages.filter((m) => m.role === "user" && typeof m.content === "string");
  const t = (users.length ? users[users.length - 1].content : "").trim();
  let score = 0;
  if (SV_RE.test(t)) score += 2; // le suédois est le point faible du petit modèle d'Oracle
  if (HARD_RE.test(t)) score += 1;
  if (t.length > 60) score += 1;
  if (REASON_RE.test(t)) score += 1;
  if (users.length >= 2) score += 1; // la personne reste : on investit
  if (t.length < 25 && CHAT_RE.test(t)) score -= 2;
  return score;
}
// Questions sur l'identité de l'IA ("qui es-tu", "qui t'a créé", "quel modèle", "es-tu ChatGPT"...) : elles vont toujours sur
// Oracle (petit modèle), jamais sur RunPod. C'est toujours le modèle qui répond lui-même : rien n'est écrit à l'avance.
const IDENTITY_RE = new RegExp(
  [
    "qui es tu", "qui est tu", "tu es qui", "t es qui", "tu es quoi", "c est quoi ton nom", "comment tu t appelles", "tu t appelles comment", "presente toi", "parle moi de toi",
    "qui t ?a (?:cree|fait|programme|entraine|developpe|invente|construit)", "qui est ton (?:createur|developpeur|inventeur)", "ton createur",
    "tu as ete (?:cree|fait|entraine) par", "tu es (?:fait|cree|entraine|developpe|programme) par",
    "quel(?:le)? (?:modele|ia|intelligence artificielle) (?:es tu|tu es)", "tu es quel(?:le)? (?:modele|ia)",
    "tu es (?:chatgpt|gpt|gemma|gemini|google|openai|mistral|claude|llama|copilot|siri|alexa)",
    "quelle (?:entreprise|societe|compagnie) (?:t a|ta|te) (?:cree|entraine|fait|developpe)",
    "vem ar du", "vad heter du", "berätta om dig", "beratta om dig", "presentera dig",
    "vem (?:skapade|byggde|gjorde|programmerade|tranade|utvecklade) dig", "vem har (?:skapat|byggt|gjort|tranat|utvecklat) dig", "vem ar din (?:skapare|utvecklare)",
    "vilken (?:modell|ai) ar du", "vilket foretag (?:skapade|byggde|har tranat|tranade|har skapat|utvecklade) dig",
    "ar du (?:chatgpt|gpt|gemma|gemini|google|openai|mistral|claude|llama|copilot|siri|alexa)", "var du gjord av",
    "who are you", "what is your name", "what s your name", "introduce yourself", "tell me about yourself",
    "who (?:made|created|built|trained|developed|programmed|invented) you", "who is your (?:creator|maker|developer)", "your (?:creator|maker)",
    "(?:which|what) (?:model|ai) are you", "(?:which|what) company (?:made|created|built|trained|developed) you",
    "are you (?:chatgpt|gpt|gemma|gemini|google|openai|mistral|claude|llama|copilot|siri|alexa)", "(?:were you|are you) (?:made|created|built|trained) by",
  ].join("|")
);
function plainText(t) {
  return String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function isIdentityQuestion(messages) {
  const users = messages.filter((m) => m.role === "user" && typeof m.content === "string");
  return users.length > 0 && IDENTITY_RE.test(plainText(users[users.length - 1].content));
}
function isHard(messages) {
  return difficultyScore(messages) >= 2;
}

const ALLOWED_ORIGINS = [
  "https://xearnes.com",
  "https://www.xearnes.com",
  "https://niljen.github.io",
];

// Réponse complète déjà obtenue (RunPod) : même format que le chemin Oracle.
function reply(text, wantsStream, corsHeaders, source, extra) {
  const h = { ...corsHeaders, "X-Xearnes-Source": source, ...(extra || {}) };
  if (wantsStream) return new Response(text, { status: 200, headers: { ...h, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
    { status: 200, headers: { ...h, "Content-Type": "application/json; charset=utf-8" } }
  );
}

// Compteurs de statistiques (sans contenu des messages) : combien de réponses du GPU, d'échecs, de questions difficiles restées sur Oracle.
function bump(env, ctx, name) {
  if (!env || !env.WAKE_KV) return;
  const key = "stats:" + new Date().toISOString().slice(0, 10) + ":" + name;
  const p = env.WAKE_KV.get(key)
    .then((v) => env.WAKE_KV.put(key, String((Number(v) || 0) + 1), { expirationTtl: 60 * 86400 }))
    .catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (origin && !allowed) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    // ── Connexion par code envoyé par email (voir auth.js) ──
    const path = new URL(request.url).pathname;
    // ── Webhook Stripe (signature vérifiée dans stripe.js) ──
    if (path === "/stripe-webhook" && request.method === "POST") return handleStripeWebhook(request, env);
    if (path.startsWith("/auth/")) {
      const json = (r) => new Response(JSON.stringify(r.json), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      try {
        if (path === "/auth/me" && request.method === "GET") return json(await handleAuthMe(request, env));
        if (request.method === "POST" && (path === "/auth/request" || path === "/auth/verify")) {
          const b = await request.json().catch(() => ({}));
          return json(path === "/auth/request" ? await handleAuthRequest(b, request, env) : await handleAuthVerify(b, env));
        }
      } catch {
        return json({ status: 500, json: { error: "auth_error" } });
      }
      return new Response("Not found", { status: 404, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
    }

    const wantsStream = body.stream === true;
    const messages = body.messages || [];

    // Niveau de l'abonné : un jeton signé (obtenu avec le code reçu par email) donne le niveau lu côté serveur ; sinon gratuit.
    const { tier } = await tierFromRequest(request, env);
    const score = difficultyScore(messages);
    const pii = hasPersonalInfo(messages);
    const ident = isIdentityQuestion(messages);
    // Mode code : l'appli ajoute « MODE CODE ACTIVÉ » au prompt quand il est débloqué. Toutes les questions de code vont
    // sur le 8B (choix de Youssef : 12/13 au banc de code, rapide et peu coûteux), quel que soit le niveau de l'abonné.
    const codeMode = messages.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("MODE CODE ACTIVÉ"));
    // « Plus de détails » (abonnés) ou document/présentation (tous) : l'appli ajoute « MODE DÉTAILLÉ ACTIVÉ » ou « MODE DOCUMENT ACTIVÉ » ; la réponse peut être plus longue.
    const detailMode = messages.some((m) => m.role === "system" && typeof m.content === "string" && (m.content.includes("MODE DÉTAILLÉ ACTIVÉ") || m.content.includes("MODE DOCUMENT ACTIVÉ")));

    // Diagnostic (sans contenu des messages) : pourquoi cette réponse vient d'Oracle ou de RunPod
    const dbg = ["tier=" + tier, "score=" + score, "pii=" + (pii ? 1 : 0), "ident=" + (ident ? 1 : 0), "code=" + (codeMode ? 1 : 0)];
    const dh = { "X-Xearnes-Route": dbg.join(",") };

    // ── Niveau 1 : RunPod, selon le niveau : Legend 20B > 14B > 8B ; Pro/Ultra 14B > 8B ; Gratuit 8B ──
    // Jamais pour une donnée personnelle ni pour une question d'identité. Les abonnés ont un seuil de difficulté plus bas.
    // Code : le 8B pour tous ; Legend a le 20B (13/13 au banc de code) avec le 8B en secours.
    const codeChain = tier === "legend" ? ["large", "small"] : ["small"];
    const chain = (codeMode ? codeChain : TIER_CHAIN[tier] || TIER_CHAIN.free).map((k) => podConfig(env, k)).filter(Boolean);
    if (chain.length && !pii && !ident && (codeMode || score >= (tier === "free" ? 2 : 1))) {
      // 1. Réveiller le meilleur modèle du niveau s'il dort (budget par modèle et par jour), sans faire attendre le visiteur
      const top = chain[0];
      const stTop = await loadPod(env, top);
      if (!(await isWarm(env, top, stTop))) {
        if (await maybeWake(env, top, stTop, ctx)) { dbg.push("wake=" + top.name); bump(env, ctx, "wakes_sent:" + top.name); }
      }
      // 2. Répondre avec le premier modèle chaud de la chaîne
      for (const cfg of chain) {
        const st = cfg === top ? stTop : await loadPod(env, cfg);
        if (!(await isWarm(env, cfg, st))) continue;
        const room = codeMode ? 1500 : detailMode ? 1200 : 0; // le code et les réponses détaillées ont besoin de place
        const text = await askPod(cfg, messages, Math.max(TIER_MAX_TOKENS[tier], room));
        if (text) {
          st.warmUntil = Date.now() + cfg.idleMs;
          if (ctx && ctx.waitUntil) ctx.waitUntil(savePod(env, cfg, st));
          bump(env, ctx, "answers:" + cfg.name);
          return reply(text, wantsStream, corsHeaders, "runpod", { "X-Xearnes-Pod": cfg.name, "X-Xearnes-Tier": tier });
        }
        bump(env, ctx, "failures:" + cfg.name);
        st.warmUntil = 0; // n'a pas répondu à temps : on ne le croit plus chaud
        if (ctx && ctx.waitUntil) ctx.waitUntil(savePod(env, cfg, st));
      }
      bump(env, ctx, "hard_on_oracle");
    }

    // ── Niveau 2 : Oracle (Ollama), comme avant ──
    const ollamaUrl = (env && env.OLLAMA_URL) || OLLAMA_URL;
    if (!ollamaUrl) {
      return new Response(JSON.stringify({ error: "Oracle not configured" }), {
        status: 502,
        headers: { ...corsHeaders, ...dh, "Content-Type": "application/json" },
      });
    }
    const ollamaHeaders = { "Content-Type": "application/json" };
    if (env && env.OLLAMA_AUTH_KEY) ollamaHeaders["X-Xearnes-Key"] = env.OLLAMA_AUTH_KEY;
    const models = [(env && env.OLLAMA_MODEL) || OLLAMA_MODEL];
    const fb = (env && env.OLLAMA_FALLBACK_MODEL) || OLLAMA_FALLBACK_MODEL;
    if (fb && fb !== models[0]) models.push(fb); // modèle de secours, plus petit et déjà chargé en mémoire

    let res = null;
    let lastErr = "";
    for (const model of models) {
      const ollamaBody = {
        model,
        messages,
        stream: wantsStream,
        options: {
          num_predict: codeMode ? 1200 : detailMode ? 1000 : 600, // plafond de longueur (le prompt demande 2-5 phrases, donc rarement atteint ; le code est plus long)
          temperature: 0.3, // moins de réponses absurdes avec un petit modèle qu'avec la valeur par défaut ~0.8
        },
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(env && env.OLLAMA_HEADERS_TIMEOUT_MS) || (wantsStream ? OLLAMA_HEADERS_TIMEOUT_MS : OLLAMA_NONSTREAM_TIMEOUT_MS));
      try {
        const r = await fetch(ollamaUrl, {
          method: "POST",
          headers: ollamaHeaders,
          body: JSON.stringify(ollamaBody),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (r.ok) { res = r; break; }
        lastErr = "Ollama HTTP " + r.status;
      } catch (e) {
        clearTimeout(timer);
        lastErr = "Ollama unreachable: " + e.message;
      }
    }
    if (!res) {
      return new Response(JSON.stringify({ error: lastErr }), {
        status: 502, // erreur retryable côté front
        headers: { ...corsHeaders, ...dh, "Content-Type": "application/json" },
      });
    }

    // ── Mode streaming : on relaie les morceaux de texte au fur et à mesure ──
    if (wantsStream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        const reader = res.body.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); // garde la ligne incomplète pour la suite
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                const chunk = (obj.message && obj.message.content) || "";
                if (chunk) await writer.write(encoder.encode(chunk));
              } catch {}
            }
          }
        } catch {} finally {
          try { await writer.close(); } catch {}
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: { ...corsHeaders, ...dh, "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // ── Mode normal : une seule réponse complète (comportement d'origine) ──
    const data = await res.json();
    const content = (data.message && data.message.content) || "";

    const openaiFormat = {
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    };

    return new Response(JSON.stringify(openaiFormat), {
      status: 200,
      headers: { ...corsHeaders, ...dh, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
