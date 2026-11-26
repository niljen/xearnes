// Cerebras (gpt-oss-120b) pour les questions difficiles : rapide, sans démarrage à froid.
// Règles : jamais pour une donnée personnelle ni une question d'identité (décidé dans worker.js) ;
// la ville de Youssef est retirée des instructions avant l'envoi (décision de Youssef et de son père) ;
// portée réglable : CEREBRAS_SCOPE = "allowlist" (par défaut : seulement les comptes de WS_ALLOWED), "subscribers" ou "all".
import { allowedEmails } from "./workspace.js";

const DEFAULT_MODEL = "gpt-oss-120b";
const DEFAULT_TIMEOUT_MS = 30000;

export function cerebrasEligible(env, email, tier) {
  if (!env || !env.CEREBRAS_API_KEY) return false;
  const scope = String(env.CEREBRAS_SCOPE || "allowlist").toLowerCase();
  if (scope === "all") return true;
  if (scope === "subscribers") return tier && tier !== "free";
  return !!email && allowedEmails(env).includes(String(email).toLowerCase());
}

// Retire la ville des instructions système (« de Malmö », « från Malmö », « from Malmö »…). Les messages de l'utilisateur ne sont pas modifiés.
export function stripCity(messages) {
  return messages.map((m) => {
    if (m.role !== "system" || typeof m.content !== "string") return m;
    // « ö » n'est pas une lettre pour \b en JavaScript : on vérifie avec \p{L} (drapeau u)
    let c = m.content.replace(/\s+(?:de|du|från|fra|from|aus|di|desde|in|i|à)\s+Malm[öo](?!\p{L})/giu, "");
    c = c.replace(/,?\s*(?<!\p{L})Malm[öo](?!\p{L})/giu, "");
    return { ...m, content: c };
  });
}

// Renvoie le texte de la réponse, ou null (erreur, délai dépassé, réponse vide) : le Worker passe alors à RunPod ou Oracle.
export async function askCerebras(env, messages, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env.CEREBRAS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  try {
    const r = await fetch((env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1") + "/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.CEREBRAS_API_KEY },
      body: JSON.stringify({
        model: env.CEREBRAS_MODEL || DEFAULT_MODEL,
        messages: stripCity(messages),
        temperature: 0.3,
        max_completion_tokens: Math.max(maxTokens || 600, 1500), // le raisonnement consomme des jetons avant la réponse
        reasoning_effort: "low",
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
