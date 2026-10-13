// Xearnes AI Worker — Cloudflare Edge
// Proxy vers Ollama auto-hébergé sur Oracle Cloud (Gemma 3 1B), via Cloudflare Tunnel
// NOTE : l'URL du tunnel change si le service cloudflared redémarre côté serveur —
// dans ce cas, mettre à jour OLLAMA_URL ci-dessous puis redéployer.

const OLLAMA_URL = "https://saskatchewan-validation-style-essential.trycloudflare.com/api/chat";
const OLLAMA_MODEL = "gemma3:4b"; // modèle par défaut (choix de Youssef)
const OLLAMA_FALLBACK_MODEL = "gemma3:1b"; // secours si le premier ne répond pas
const OLLAMA_HEADERS_TIMEOUT_MS = 45000; // si pas de début de réponse après 45 s, on bascule sur le secours

// ── Niveau 1 optionnel : RunPod Serverless (GPU), avec repli sur Oracle ──
// Actif seulement si les variables RUNPOD_ENDPOINT_ID et RUNPOD_API_KEY (secret) sont définies.
// Sans elles, le Worker se comporte exactement comme avant (Oracle seulement).
const RUNPOD_MODEL_DEFAULT = "mistralai/Ministral-3-8B-Instruct-2512"; // le plus petit modèle qui passe nos tests (choix de Youssef : plus de technologie, pas de masse)
const RUNPOD_FIRST_TOKEN_MS = 8000; // au-delà, on bascule sur Oracle
const RUNPOD_WAKE_EVERY_MS = 2 * 60 * 1000; // au plus un réveil toutes les 2 min
let runpodLastWake = 0; // mémoire par instance du Worker, perdue au redémarrage (sans risque : on retombe sur Oracle)
let runpodHealth = { at: 0, warm: false };

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
function isHard(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const t = (last && typeof last.content === "string" ? last.content : "").trim();
  return t.length > 60 || HARD_RE.test(t);
}

const ALLOWED_ORIGINS = [
  "https://xearnes.com",
  "https://www.xearnes.com",
  "https://niljen.github.io",
];

// Réponse complète déjà obtenue (RunPod) : même format que le chemin Oracle.
function reply(text, wantsStream, corsHeaders, source) {
  const h = { ...corsHeaders, "X-Xearnes-Source": source };
  if (wantsStream) return new Response(text, { status: 200, headers: { ...h, "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }),
    { status: 200, headers: { ...h, "Content-Type": "application/json; charset=utf-8" } }
  );
}

function runpodBase(env) {
  return (env.RUNPOD_BASE_URL || "https://api.runpod.ai/v2/" + env.RUNPOD_ENDPOINT_ID).replace(/\/$/, "");
}

// Demande à RunPod (route compatible OpenAI). Renvoie le texte, ou null si trop lent / en erreur / vide.
// On attend la réponse entière côté Worker : le délai ne couvre que le premier mot, mais on ne peut
// plus changer de niveau une fois qu'on a commencé à répondre au visiteur.
async function tryRunpod(env, messages, wantsStream) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), RUNPOD_FIRST_TOKEN_MS);
  try {
    const r = await fetch(runpodBase(env) + "/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RUNPOD_API_KEY },
      body: JSON.stringify({
        model: env.RUNPOD_MODEL || RUNPOD_MODEL_DEFAULT,
        stream: true,
        temperature: 0.3,
        max_tokens: 600,
        messages,
      }),
    });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", gotFirst = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const d = JSON.parse(p).choices?.[0]?.delta?.content;
          if (d) {
            text += d;
            if (!gotFirst) { gotFirst = true; clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 30000); }
          }
        } catch {}
      }
    }
    return /[\p{L}\p{N}]{2}/u.test(text) ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// /health est gratuit et ne réveille pas le worker : on y lit s'il y a déjà un worker prêt.
async function runpodIsWarm(env) {
  if (Date.now() - runpodHealth.at < 15000) return runpodHealth.warm;
  let warm = false;
  try {
    const r = await fetch(runpodBase(env) + "/health", {
      headers: { Authorization: "Bearer " + env.RUNPOD_API_KEY },
      signal: AbortSignal.timeout(2000),
    });
    const w = (await r.json()).workers || {};
    warm = (w.idle || 0) + (w.ready || 0) + (w.running || 0) > 0;
  } catch {}
  runpodHealth = { at: Date.now(), warm };
  return warm;
}

// Réveille un worker froid sans attendre : une toute petite requête, ignorée par le visiteur.
async function wakeRunpod(env) {
  try {
    await fetch(runpodBase(env) + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RUNPOD_API_KEY },
      body: JSON.stringify({ input: { prompt: "Bonjour", sampling_params: { max_tokens: 1 } } }),
    });
  } catch {}
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }
    if (origin && !allowed) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
    }

    const wantsStream = body.stream === true;
    const messages = body.messages || [];

    // ── Niveau 1 : RunPod (si configuré, question difficile, worker chaud) ──
    if (env && env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY && isHard(messages) && !hasPersonalInfo(messages)) {
      if (await runpodIsWarm(env)) {
        const text = await tryRunpod(env, messages, wantsStream);
        if (text) return reply(text, wantsStream, corsHeaders, "runpod");
      } else if (Date.now() - runpodLastWake > RUNPOD_WAKE_EVERY_MS) {
        runpodLastWake = Date.now();
        const wake = wakeRunpod(env);
        if (ctx && ctx.waitUntil) ctx.waitUntil(wake);
      }
    }

    // ── Niveau 2 : Oracle (Ollama), comme avant ──
    const ollamaUrl = (env && env.OLLAMA_URL) || OLLAMA_URL;
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
          num_predict: 600, // plafond de longueur (le prompt demande 2-5 phrases, donc rarement atteint)
          temperature: 0.3, // moins de réponses absurdes avec un petit modèle qu'avec la valeur par défaut ~0.8
        },
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(env && env.OLLAMA_HEADERS_TIMEOUT_MS) || OLLAMA_HEADERS_TIMEOUT_MS);
      try {
        const r = await fetch(ollamaUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
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
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
