// Réception des webhooks OpenWA : signature HMAC, déduplication, liste blanche stricte.
import crypto from 'node:crypto';
import { config } from './config.js';
import { claimEvent, setSetting } from './db.js';
import { phoneOf, isBotMessage, sendText, setCachedStatus, cachedSession, getSession } from './openwa.js';
import { handleMessage } from './agent.js';

/** Vérifie X-OpenWA-Signature: sha256=<hex> (HMAC-SHA256 du corps brut), en temps constant. */
export function verifySignature(rawBody, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.openwa.webhookSecret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Décide si un message doit être traité. Seul ALLOWED_PHONE_NUMBER est accepté :
 *  - message reçu d'un autre compte : l'expéditeur doit être ce numéro, en conversation individuelle ;
 *  - message écrit depuis le compte lié lui-même (« note à soi-même ») : le compte lié doit être ce
 *    numéro ET la conversation doit être celle avec lui-même. Les messages du bot (🤖) sont ignorés.
 */
export async function authorize(d) {
  if (!d || typeof d !== 'object') return 'payload vide';
  if (d.isGroup || d.isStatusBroadcast || (d.kind && d.kind !== 'individual')) return 'groupe/statut/canal';
  if (/@(g\.us|broadcast|newsletter)$/.test(String(d.chatId || ''))) return 'groupe/statut/canal';
  const allowed = config.allowedPhone;
  if (d.fromMe) {
    if (isBotMessage(d)) return 'message du bot';
    const me = String(cachedSession()?.phone || (await getSession())?.phone || '').replace(/\D/g, '');
    if (me !== allowed) return 'compte lié différent du numéro autorisé';
    if ((await phoneOf(d.chatId)) !== allowed) return 'message sortant vers un tiers';
    return null;
  }
  const sender = await phoneOf(d.from, d.senderPhone);
  return sender && sender === allowed ? null : 'expéditeur non autorisé';
}

const queue = [];
let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const d = queue.shift();
    try {
      const reply = await handleMessage(d);
      if (reply) await sendText(d.chatId, reply);
    } catch (e) { console.error('[webhook] traitement impossible :', e.message); }
  }
  busy = false;
}

/** Traite un webhook déjà authentifié. Renvoie un libellé pour les journaux. */
export async function processWebhook(payload, headerKey) {
  const { event, data } = payload || {};
  if (event?.startsWith('session.')) {
    setCachedStatus(data?.status || (event === 'session.authenticated' ? 'ready' : event === 'session.disconnected' ? 'disconnected' : null));
    getSession().catch(() => {});
    return 'session';
  }
  if (event !== 'message.received' && event !== 'message.sent') return 'ignoré (évènement)';
  const reason = await authorize(data);
  if (reason) return `ignoré (${reason})`;
  // Livraison « au moins une fois » : on déduplique sur l'identifiant du message
  if (!claimEvent(`msg:${data.id || payload.idempotencyKey || headerKey}`)) return 'doublon';
  // Messages anciens rejoués à la reconnexion : on ne les exécute pas
  if (data.timestamp && Date.now() / 1000 - data.timestamp > 600) return 'ignoré (message trop ancien)';
  setSetting('owner_chat_id', data.chatId);
  queue.push(data);
  drain();
  return 'accepté';
}
