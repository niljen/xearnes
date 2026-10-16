// Modèles GPU sur RunPod (un « pod » = un endpoint serverless), avec un état et un budget de réveils par pod.
// Niveaux : Gratuit -> 8B ; Pro et Ultra -> 14B (puis 8B) ; Legend -> 20B (puis 14B, puis 8B). Oracle reste le dernier recours.
// Un pod n'est utilisé que si son endpoint ET sa clé sont configurés : sinon il est ignoré (comportement d'avant).

export const PODS = {
  small: {
    name: "8b",
    model: "mistralai/Ministral-3-8B-Instruct-2512",
    idVars: ["RUNPOD_ENDPOINT_8B", "RUNPOD_ENDPOINT_ID"], // l'ancien nom reste accepté
    keyVars: ["RUNPOD_KEY_8B", "RUNPOD_API_KEY"],
    capVars: ["RUNPOD_DAILY_WAKES_8B", "RUNPOD_DAILY_WAKES"],
    extra: {},
    minTokens: 0,
  },
  mid: {
    name: "14b",
    model: "mistralai/Ministral-3-14B-Instruct-2512",
    idVars: ["RUNPOD_ENDPOINT_14B"],
    keyVars: ["RUNPOD_KEY_14B"],
    capVars: ["RUNPOD_DAILY_WAKES_14B"],
    extra: {},
    minTokens: 0,
  },
  large: {
    name: "20b",
    model: "openai/gpt-oss-20b",
    idVars: ["RUNPOD_ENDPOINT_20B"],
    keyVars: ["RUNPOD_KEY_20B"],
    capVars: ["RUNPOD_DAILY_WAKES_20B"],
    extra: { reasoning_effort: "low" }, // modèle à raisonnement : peu de réflexion pour rester rapide
    minTokens: 1200, // le raisonnement consomme des jetons avant la réponse
  },
};

export const TIER_CHAIN = {
  free: ["small"],
  pro: ["mid", "small"],
  ultra: ["mid", "small"],
  legend: ["large", "mid", "small"],
};

// Longueur maximale des réponses par niveau (jetons). Oracle reste à 600 pour tout le monde.
export const TIER_MAX_TOKENS = { free: 600, pro: 900, ultra: 1500, legend: 2500 };

const DEFAULTS = { firstTokenMs: 8000, idleMs: 60000, wakeEveryMs: 120000, pollAfterMs: 90000, dailyWakes: 6 };
const mem = {}; // mémoire par instance (secours quand KV n'est pas disponible)

const pick = (env, names) => {
  for (const n of names) if (env && env[n]) return env[n];
  return "";
};

// Configuration d'un pod, ou null s'il n'est pas configuré.
export function podConfig(env, key) {
  const p = PODS[key];
  if (!p) return null;
  const id = pick(env, p.idVars);
  const apiKey = pick(env, p.keyVars);
  if (!id || !apiKey) return null;
  const base = (env.RUNPOD_BASE_URL ? env.RUNPOD_BASE_URL + "/" + id : "https://api.runpod.ai/v2/" + id).replace(/\/$/, "");
  return {
    key,
    name: p.name,
    model: p.model,
    id,
    apiKey,
    base,
    extra: p.extra,
    minTokens: p.minTokens,
    cap: Number(pick(env, p.capVars)) || DEFAULTS.dailyWakes,
    idleMs: Number(env.RUNPOD_IDLE_MS) || DEFAULTS.idleMs,
    pollAfterMs: Number(env.RUNPOD_POLL_AFTER_MS) || DEFAULTS.pollAfterMs,
    firstTokenMs: Number(env.RUNPOD_FIRST_TOKEN_MS) || DEFAULTS.firstTokenMs,
  };
}

// ── État partagé d'un pod (KV pour toutes les instances du Worker ; mémoire locale sinon) ──
export async function loadPod(env, cfg) {
  const fresh = { wakeJobId: "", wakeAt: 0, warmUntil: 0, lastWake: 0 };
  if (env.WAKE_KV) {
    try {
      const raw = await env.WAKE_KV.get("pod:" + cfg.name);
      if (raw) return { ...fresh, ...JSON.parse(raw) };
      return fresh;
    } catch {
      return fresh;
    }
  }
  return mem[cfg.name] || fresh;
}

export async function savePod(env, cfg, st) {
  if (env.WAKE_KV) {
    try {
      await env.WAKE_KV.put("pod:" + cfg.name, JSON.stringify(st), { expirationTtl: 3600 });
    } catch {}
  } else {
    mem[cfg.name] = st;
  }
}

// Le GPU est-il chaud ? Oui s'il vient de répondre (idle timeout), ou si le dernier réveil est terminé depuis moins longtemps
// que l'idle timeout. /health de RunPod n'est pas fiable : on interroge /status du job de réveil (gratuit).
export async function isWarm(env, cfg, st) {
  const now = Date.now();
  if (now < st.warmUntil) return true;
  if (!st.wakeJobId || now - st.wakeAt < cfg.pollAfterMs) return false;
  try {
    const r = await fetch(cfg.base + "/status/" + st.wakeJobId, { headers: { Authorization: "Bearer " + cfg.apiKey }, signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    if (j.status === "COMPLETED") {
      st.warmUntil = st.wakeAt + (j.delayTime || 0) + (j.executionTime || 0) + cfg.idleMs;
      st.wakeJobId = "";
      await savePod(env, cfg, st);
      return Date.now() < st.warmUntil;
    }
    if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(j.status)) {
      st.wakeJobId = "";
      await savePod(env, cfg, st);
    }
  } catch {}
  return false;
}

// Budget de réveils par jour et par pod (KV, partagé ; sinon mémoire locale). Dans le doute, on ne réveille pas.
export async function wakeBudgetLeft(env, cfg) {
  const day = new Date().toISOString().slice(0, 10);
  const key = "wakes:" + day + ":" + cfg.name;
  if (env.WAKE_KV) {
    try {
      const n = Number(await env.WAKE_KV.get(key)) || 0;
      if (n >= cfg.cap) return false;
      await env.WAKE_KV.put(key, String(n + 1), { expirationTtl: 172800 });
      return true;
    } catch {
      return false;
    }
  }
  mem["wakes:" + cfg.name] = mem["wakes:" + cfg.name] || {};
  const n = mem["wakes:" + cfg.name][day] || 0;
  if (n >= cfg.cap) return false;
  mem["wakes:" + cfg.name] = { [day]: n + 1 };
  return true;
}

// Peut-on réveiller ce pod maintenant ? (pas de réveil en cours, pas plus d'un toutes les 2 minutes, budget du jour)
export async function maybeWake(env, cfg, st, ctx) {
  if (st.wakeJobId || Date.now() - st.lastWake < DEFAULTS.wakeEveryMs) return false;
  if (!(await wakeBudgetLeft(env, cfg))) return false;
  st.lastWake = Date.now();
  await savePod(env, cfg, st); // les autres instances voient tout de suite qu'un réveil est en cours
  const wake = (async () => {
    try {
      const r = await fetch(cfg.base + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
        body: JSON.stringify({ input: { prompt: "Bonjour", sampling_params: { max_tokens: 1 } } }),
      });
      const j = await r.json();
      if (j && j.id) { st.wakeJobId = j.id; st.wakeAt = Date.now(); }
    } catch {}
    await savePod(env, cfg, st);
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(wake);
  else await wake;
  return true;
}

// Demande au pod (route compatible OpenAI). Renvoie le texte, ou null si trop lent / en erreur / vide.
// On attend la réponse entière côté Worker pour pouvoir encore basculer sur Oracle en cas de problème.
export async function askPod(cfg, messages, maxTokens) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), cfg.firstTokenMs);
  try {
    const r = await fetch(cfg.base + "/openai/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.3,
        max_tokens: Math.max(maxTokens || 600, cfg.minTokens),
        messages,
        ...cfg.extra,
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
            if (!gotFirst) { gotFirst = true; clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), 60000); }
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
