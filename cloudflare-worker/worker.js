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

// ── Niveau 1 optionnel : RunPod Serverless (GPU), avec repli sur Oracle ──
// Actif seulement si les variables RUNPOD_ENDPOINT_ID et RUNPOD_API_KEY (secret) sont définies.
// Sans elles, le Worker se comporte exactement comme avant (Oracle seulement).
const RUNPOD_MODEL_DEFAULT = "mistralai/Ministral-3-8B-Instruct-2512"; // le plus petit modèle qui passe nos tests (choix de Youssef : plus de technologie, pas de masse)
const RUNPOD_FIRST_TOKEN_MS = 8000; // au-delà, on bascule sur Oracle
const RUNPOD_IDLE_MS_DEFAULT = 60000; // doit correspondre au "idle timeout" de l'endpoint RunPod (60 s)
const RUNPOD_WAKE_EVERY_MS = 2 * 60 * 1000; // au plus un réveil toutes les 2 min
const RUNPOD_POLL_AFTER_MS_DEFAULT = 90000; // le démarrage à froid dure ~2 min : inutile de demander avant
const RUNPOD_DAILY_WAKES_DEFAULT = 6; // plafond de réveils par jour (budget 7 $/mois)
// Mémoire par instance du Worker, perdue au redémarrage (sans risque : on retombe sur Oracle).
// /health n'est PAS fiable pour savoir si le GPU est chaud : on suit nos propres réveils et réponses.
const runpod = { wakeJobId: "", wakeAt: 0, warmUntil: 0, lastWake: 0, memWakes: {} };

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
function isHard(messages) {
  return difficultyScore(messages) >= 2;
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

// État partagé entre toutes les instances du Worker (Cloudflare en lance plusieurs) via KV ; sans KV, mémoire locale.
async function loadState(env) {
  if (env && env.WAKE_KV) {
    try {
      const raw = await env.WAKE_KV.get("runpod_state");
      if (raw) Object.assign(runpod, JSON.parse(raw));
    } catch {}
  }
}
async function saveState(env) {
  if (env && env.WAKE_KV) {
    try {
      await env.WAKE_KV.put(
        "runpod_state",
        JSON.stringify({ wakeJobId: runpod.wakeJobId, wakeAt: runpod.wakeAt, warmUntil: runpod.warmUntil, lastWake: runpod.lastWake }),
        { expirationTtl: 3600 }
      );
    } catch {}
  }
}

// Le GPU est-il chaud ? Oui s'il vient de répondre (idle timeout), ou si notre dernier réveil est terminé
// depuis moins longtemps que l'idle timeout. On interroge /status (gratuit) du job de réveil.
async function runpodIsWarm(env) {
  const now = Date.now();
  if (now < runpod.warmUntil) return true;
  if (!runpod.wakeJobId) return false;
  const pollAfter = Number(env.RUNPOD_POLL_AFTER_MS) || RUNPOD_POLL_AFTER_MS_DEFAULT;
  if (now - runpod.wakeAt < pollAfter) return false;
  try {
    const r = await fetch(runpodBase(env) + "/status/" + runpod.wakeJobId, {
      headers: { Authorization: "Bearer " + env.RUNPOD_API_KEY },
      signal: AbortSignal.timeout(2000),
    });
    const j = await r.json();
    if (j.status === "COMPLETED") {
      const idle = Number(env.RUNPOD_IDLE_MS) || RUNPOD_IDLE_MS_DEFAULT;
      const doneAt = runpod.wakeAt + (j.delayTime || 0) + (j.executionTime || 0);
      runpod.wakeJobId = "";
      runpod.warmUntil = doneAt + idle;
      await saveState(env);
      return Date.now() < runpod.warmUntil;
    }
    if (j.status === "FAILED" || j.status === "CANCELLED" || j.status === "TIMED_OUT") { runpod.wakeJobId = ""; await saveState(env); }
  } catch {}
  return false;
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

// Plafond de réveils par jour : Cloudflare KV si disponible (partagé entre toutes les instances), sinon mémoire locale.
async function wakeBudgetLeft(env) {
  const cap = Number(env.RUNPOD_DAILY_WAKES) || RUNPOD_DAILY_WAKES_DEFAULT;
  const day = new Date().toISOString().slice(0, 10);
  if (env.WAKE_KV) {
    try {
      const n = Number(await env.WAKE_KV.get("wakes:" + day)) || 0;
      if (n >= cap) return false;
      await env.WAKE_KV.put("wakes:" + day, String(n + 1), { expirationTtl: 172800 });
      return true;
    } catch {
      return false; // dans le doute on ne réveille pas
    }
  }
  const n = runpod.memWakes[day] || 0;
  if (n >= cap) return false;
  runpod.memWakes = { [day]: n + 1 };
  return true;
}

// Réveille un worker froid sans attendre : une toute petite requête, ignorée par le visiteur. Garde l'identifiant du job.
async function wakeRunpod(env) {
  try {
    const r = await fetch(runpodBase(env) + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.RUNPOD_API_KEY },
      body: JSON.stringify({ input: { prompt: "Bonjour", sampling_params: { max_tokens: 1 } } }),
    });
    const j = await r.json();
    if (j && j.id) { runpod.wakeJobId = j.id; runpod.wakeAt = Date.now(); }
  } catch {}
  await saveState(env);
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

    // Diagnostic (sans contenu des messages) : pourquoi cette réponse vient d'Oracle ou de RunPod
    const dbg = [
      "cfg=" + (env && env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY ? 1 : 0),
      "score=" + difficultyScore(messages),
      "pii=" + (hasPersonalInfo(messages) ? 1 : 0),
    ];
    const dh = { "X-Xearnes-Route": dbg.join(",") };

    // ── Niveau 1 : RunPod (si configuré, question difficile, sans donnée personnelle) ──
    if (env && env.RUNPOD_ENDPOINT_ID && env.RUNPOD_API_KEY && isHard(messages) && !hasPersonalInfo(messages)) {
      await loadState(env);
      const warm = await runpodIsWarm(env);
      dbg.push("warm=" + (warm ? 1 : 0), "job=" + (runpod.wakeJobId ? 1 : 0));
      if (warm) {
        const text = await tryRunpod(env, messages, wantsStream);
        if (text) {
          runpod.warmUntil = Date.now() + (Number(env.RUNPOD_IDLE_MS) || RUNPOD_IDLE_MS_DEFAULT);
          if (ctx && ctx.waitUntil) ctx.waitUntil(saveState(env));
          bump(env, ctx, "runpod_answers");
          return reply(text, wantsStream, corsHeaders, "runpod");
        }
        bump(env, ctx, "runpod_failures");
        runpod.warmUntil = 0; // n'a pas répondu à temps : on ne le croit plus chaud
        if (ctx && ctx.waitUntil) ctx.waitUntil(saveState(env));
      } else if (!runpod.wakeJobId && Date.now() - runpod.lastWake > RUNPOD_WAKE_EVERY_MS && (await wakeBudgetLeft(env))) {
        dbg.push("wake=sent");
        bump(env, ctx, "wakes_sent");
        runpod.lastWake = Date.now();
        await saveState(env); // les autres instances voient tout de suite qu'un réveil est en cours
        const wake = wakeRunpod(env);
        if (ctx && ctx.waitUntil) ctx.waitUntil(wake);
      }
    }

    if (env && env.RUNPOD_ENDPOINT_ID && isHard(messages) && !hasPersonalInfo(messages)) bump(env, ctx, "hard_questions");

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
          num_predict: 600, // plafond de longueur (le prompt demande 2-5 phrases, donc rarement atteint)
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
