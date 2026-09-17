// Xearnes AI Worker — Cloudflare Edge
// Proxy vers Ollama auto-hébergé sur Oracle Cloud (Gemma 2 2B), via Cloudflare Tunnel
// NOTE : l'URL du tunnel change si le service cloudflared redémarre côté serveur —
// dans ce cas, mettre à jour OLLAMA_URL ci-dessous puis redéployer.

const OLLAMA_URL = "https://saskatchewan-validation-style-essential.trycloudflare.com/api/chat";
const OLLAMA_MODEL = "gemma2:2b";

const ALLOWED_ORIGINS = [
  "https://xearnes.com",
  "https://www.xearnes.com",
  "https://niljen.github.io",
];

export default {
  async fetch(request, env) {
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

    const ollamaBody = {
      model: OLLAMA_MODEL,
      messages: body.messages || [],
      stream: wantsStream,
      options: {
        num_predict: 400, // limite la longueur de réponse — plus rapide en CPU
      },
    };

    let res;
    try {
      res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ollamaBody),
      });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: "Ollama HTTP " + res.status }), {
          status: 502, // erreur retryable côté front
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: "Ollama unreachable: " + e.message }), {
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
