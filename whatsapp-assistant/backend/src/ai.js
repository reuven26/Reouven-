// LLM (Groq / OpenAI / Anthropic / serveur compatible OpenAI) + transcription Whisper.
import { config } from './config.js';

export class AIError extends Error {}

function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AIError('Réponse du modèle illisible.');
  try { return JSON.parse(s.slice(start, end + 1)); } catch { throw new AIError('Réponse du modèle illisible.'); }
}

async function post(url, headers, body, timeout = 45000) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new AIError(`Fournisseur IA injoignable (${e.message}).`); }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new AIError('Clé API IA refusée (vérifiez le .env).');
    if (res.status === 429) throw new AIError('Quota du fournisseur IA atteint, réessayez dans un instant.');
    throw new AIError(`Erreur du fournisseur IA (${res.status}) ${detail}`);
  }
  return res.json();
}

/** Appelle le LLM et renvoie un objet JSON. */
export async function chatJSON(system, user) {
  const { provider, baseUrl, apiKey, model, ready } = config.llm;
  if (!ready) throw new AIError(`Aucune clé API configurée pour ${provider}. Renseignez-la dans .env puis relancez « docker compose up -d ».`);
  if (provider === 'anthropic' && !config.llm.custom) {
    const data = await post(`${baseUrl}/messages`, {
      'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
    }, JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }));
    return extractJson(data.content?.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
  const data = await post(`${baseUrl}/chat/completions`, {
    'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }, JSON.stringify({
    model, temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }));
  return extractJson(data.choices?.[0]?.message?.content);
}

const EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/amr': 'amr' };

/** Transcrit une note vocale (Whisper via Groq ou OpenAI). */
export async function transcribe(buffer, mimetype = 'audio/ogg') {
  const { provider, baseUrl, apiKey, model, ready } = config.stt;
  if (!ready) throw new AIError(`Transcription indisponible : ajoutez une clé ${provider === 'openai' ? 'OPENAI_API_KEY' : 'GROQ_API_KEY'} dans .env pour les notes vocales.`);
  const type = mimetype.split(';')[0].trim();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `note.${EXT[type] || 'ogg'}`);
  form.append('model', model);
  form.append('response_format', 'json');
  const data = await post(`${baseUrl}/audio/transcriptions`, { authorization: `Bearer ${apiKey}` }, form, 90000);
  const text = String(data.text || '').trim();
  if (!text) throw new AIError("Je n'ai rien entendu dans cette note vocale.");
  return text;
}
