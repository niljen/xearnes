// Voix Kokoro (service sur le serveur Oracle, derrière le portail nginx à clé). Le texte ne part que vers notre serveur en Suède.
// POST /tts {text, lang, speed} -> audio/wav. Une phrase par demande (l'appli découpe), 400 caractères au plus.
// Limites : par jour pour tout le site (TTS_DAILY, 4000 par défaut) et par adresse IP (TTS_PER_IP, 400 par défaut).

const LANGS = new Set(["en", "fr", "es", "it", "pt"]);
const MAX_CHARS = 400;

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Incrémente un compteur du jour et dit s'il reste de la place. Dans le doute (KV indisponible), on refuse.
async function take(env, key, cap) {
  if (!env.WAKE_KV) return false;
  try {
    const n = Number(await env.WAKE_KV.get(key)) || 0;
    if (n >= cap) return false;
    await env.WAKE_KV.put(key, String(n + 1), { expirationTtl: 172800 });
    return true;
  } catch {
    return false;
  }
}

export async function handleTts(request, env, corsHeaders) {
  const err = (status, code) =>
    new Response(JSON.stringify({ error: code }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (!env.OLLAMA_URL || !env.OLLAMA_AUTH_KEY) return err(503, "tts_not_configured");
  let body;
  try {
    body = await request.json();
  } catch {
    return err(400, "bad_request");
  }
  const text = String((body && body.text) || "").replace(/\s+/g, " ").trim();
  const lang = String((body && body.lang) || "");
  const speed = Math.min(1.5, Math.max(0.6, Number(body && body.speed) || 1));
  if (!LANGS.has(lang)) return err(400, "lang_not_supported");
  if (!text || text.length > MAX_CHARS) return err(400, "bad_text");

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!(await take(env, "tts:" + day, Number(env.TTS_DAILY) || 4000))) return err(429, "tts_daily_limit");
  if (!(await take(env, "tts-ip:" + day + ":" + (await sha(ip)), Number(env.TTS_PER_IP) || 400))) return err(429, "tts_ip_limit");

  try {
    const r = await fetch(new URL(env.OLLAMA_URL).origin + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Xearnes-Key": env.OLLAMA_AUTH_KEY },
      body: JSON.stringify({ text, lang, speed }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) return err(502, "tts_failed");
    return new Response(r.body, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch {
    return err(502, "tts_unreachable");
  }
}
