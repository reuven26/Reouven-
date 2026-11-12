// Client de l'API REST OpenWA (https://github.com/rmyndharis/OpenWA) — auth par en-tête X-API-Key.
import { config } from './config.js';

const { url, apiKey, sessionName, webhookSecret, callbackUrl } = config.openwa;
export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'session.status', 'session.authenticated', 'session.disconnected'];
export const BOT_PREFIX = '🤖';

export class OpenWAError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body, { raw = false, timeout = 20000 } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = Array.isArray(j.message) ? j.message.join(', ') : j.message || msg; } catch { /* corps non JSON */ }
    throw new OpenWAError(res.status, msg);
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const state = { sessionId: null, session: null, webhookOk: false, lastError: null };
const sentIds = new Set(); // ids des messages envoyés par le bot (anti-boucle)

const asList = (r) => (Array.isArray(r) ? r : r?.data || r?.items || []);

export async function ensureSession() {
  const sessions = asList(await api('GET', '/api/sessions'));
  let s = sessions.find((x) => x.name === sessionName);
  if (!s) s = await api('POST', '/api/sessions', { name: sessionName });
  state.sessionId = s.id;
  if (['created', 'disconnected', 'failed'].includes(s.status) || !s.engineLoaded) {
    try { s = await api('POST', `/api/sessions/${s.id}/start`); } catch (e) {
      if (e.status !== 409 && e.status !== 400) throw e; // déjà en cours de démarrage
    }
  }
  state.session = s;
  return s;
}

/** Enregistre (ou remet à niveau) le webhook signé HMAC vers ce backend. */
export async function ensureWebhook() {
  const id = state.sessionId;
  const hooks = asList(await api('GET', `/api/sessions/${id}/webhooks`));
  const mine = hooks.filter((h) => h.url === callbackUrl);
  const body = { url: callbackUrl, events: WEBHOOK_EVENTS, secret: webhookSecret, retryCount: 3 };
  if (mine.length) {
    // Le secret n'est jamais relu par l'API : on le réécrit pour garantir qu'il correspond au .env
    await api('PUT', `/api/sessions/${id}/webhooks/${mine[0].id}`, body);
    for (const dup of mine.slice(1)) await api('DELETE', `/api/sessions/${id}/webhooks/${dup.id}`);
  } else {
    await api('POST', `/api/sessions/${id}/webhooks`, body);
  }
  state.webhookOk = true;
}

/** Boucle d'amorçage : session + webhook, réessaie tant qu'OpenWA n'est pas prêt. */
export async function bootstrap() {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureSession();
      await ensureWebhook();
      state.lastError = null;
      console.log(`[openwa] session "${sessionName}" (${state.sessionId}) prête, webhook HMAC enregistré -> ${callbackUrl}`);
      return;
    } catch (e) {
      state.lastError = e.message;
      if (attempt === 1 || attempt % 10 === 0) console.warn(`[openwa] amorçage en attente (${e.message})`);
      await new Promise((r) => setTimeout(r, Math.min(3000 * attempt, 15000)));
    }
  }
}

export async function getSession({ refresh = true } = {}) {
  if (!state.sessionId) return null;
  if (refresh) {
    try { state.session = await api('GET', `/api/sessions/${state.sessionId}`); state.lastError = null; }
    catch (e) { state.lastError = e.message; }
  }
  return state.session;
}
export const cachedSession = () => state.session;
export const setCachedStatus = (status) => { if (state.session && status) state.session = { ...state.session, status }; };
export const bridgeState = () => ({ sessionId: state.sessionId, webhookOk: state.webhookOk, lastError: state.lastError });

export async function getQr() {
  try { return (await api('GET', `/api/sessions/${state.sessionId}/qr`)).qrCode; }
  catch (e) { if (e.status === 400 || e.status === 409) return null; throw e; }
}
export const startSession = () => api('POST', `/api/sessions/${state.sessionId}/start`);
export const logoutSession = () => api('POST', `/api/sessions/${state.sessionId}/logout`);
export const pairingCode = (phoneNumber) => api('POST', `/api/sessions/${state.sessionId}/pairing-code`, { phoneNumber });

/** Envoie un message texte. Tous les messages du bot commencent par 🤖 (anti-boucle en « note à soi-même »). */
export async function sendText(chatId, text) {
  const res = await api('POST', `/api/sessions/${state.sessionId}/messages/send-text`, { chatId, text: `${BOT_PREFIX} ${text}` });
  const id = res?.messageId || res?.id;
  if (id) { sentIds.add(id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); }
  return res;
}
export const isBotMessage = (d) => sentIds.has(d.id) || String(d.body || '').trimStart().startsWith(BOT_PREFIX);

export async function downloadMedia(chatId, messageId) {
  const res = await api('GET', `/api/sessions/${state.sessionId}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`, null, { raw: true, timeout: 60000 });
  return { buffer: Buffer.from(await res.arrayBuffer()), mimetype: res.headers.get('content-type') || 'audio/ogg' };
}

const phoneCache = new Map();
/** JID -> chiffres du numéro. Résout les identifiants de confidentialité @lid via OpenWA. */
export async function phoneOf(jid, hint) {
  if (hint) return String(hint).replace(/\D/g, '');
  const s = String(jid || '');
  const [user, domain] = s.split('@');
  if (domain === 'c.us' || domain === 's.whatsapp.net') return user.split(':')[0].replace(/\D/g, '');
  if (domain !== 'lid') return '';
  if (phoneCache.has(s)) return phoneCache.get(s);
  try {
    const r = await api('GET', `/api/sessions/${state.sessionId}/contacts/${encodeURIComponent(s)}/phone`);
    const phone = String(r?.phone || r?.phoneNumber || r?.number || '').replace(/\D/g, '');
    if (phone) phoneCache.set(s, phone);
    return phone;
  } catch { return ''; }
}
