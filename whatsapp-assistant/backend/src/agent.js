// Agent : message WhatsApp (texte ou transcription) -> intention structurée -> action -> réponse.
import { config } from './config.js';
import { chatJSON, transcribe, AIError } from './ai.js';
import { CATEGORIES, STATUSES, createItem, updateItem, deleteItem, getItem, listItems, getSetting } from './db.js';
import { nowLocal, todayLocal, addDays, weekdayOf, humanDate, localToUtc, LOCAL_RE } from './tz.js';
import { syncItem, unsyncItem } from './google.js';
import { downloadMedia } from './openwa.js';

const SYSTEM = `Tu es le moteur de compréhension d'un assistant personnel WhatsApp (rappels, tâches, rendez-vous, relances clients).
Tu reçois un message de l'utilisateur et tu réponds UNIQUEMENT par un objet JSON, sans texte autour.

Schéma :
{
  "action": "create" | "list" | "complete" | "reschedule" | "delete" | "chat",
  "items": [ { "title": string, "category": "sport_perso" | "tache" | "rdv" | "relance", "due": "YYYY-MM-DDTHH:mm" | null, "contact": string | null, "notes": string | null } ],
  "range": { "from": "YYYY-MM-DDTHH:mm", "to": "YYYY-MM-DDTHH:mm" } | null,
  "category": "sport_perso" | "tache" | "rdv" | "relance" | null,
  "ids": [number],
  "new_due": "YYYY-MM-DDTHH:mm" | null,
  "status": "todo" | "waiting" | "done" | null,
  "reply": string | null
}

Règles :
- "create" : l'utilisateur veut enregistrer un ou plusieurs éléments. Remplis "items".
  - Catégories : "relance" = relancer/recontacter/rappeler un client ou une personne à propos d'un dossier ; "rdv" = rendez-vous, visite, réunion, appel planifié ; "sport_perso" = sport, santé, famille, vie personnelle ; "tache" = tout le reste.
  - "title" : court, à l'infinitif ou nominal, sans la date (ex. "Faire du sport", "Relancer David pour l'appartement", "Visite").
  - "contact" : nom de la personne concernée s'il y en a une, sinon null.
  - "due" : date et heure LOCALES de l'utilisateur, calculées à partir de la date actuelle fournie. Si aucune heure n'est donnée, utilise l'heure par défaut fournie. "ce soir" = 20:00, "midi" = 12:00, "matin" = 09:00, "après-midi" = 15:00. Un jour de semaine sans précision = sa prochaine occurrence strictement future. Si aucune date n'est exprimée, due = null.
- "list" : l'utilisateur demande son programme, ses tâches, ses RDV ou ses relances. Remplis "range" (bornes locales, "to" exclusif ; aujourd'hui = de 00:00 aujourd'hui à 00:00 demain ; "cette semaine" = d'aujourd'hui 00:00 au lundi suivant 00:00) et "category" si une catégorie précise est demandée (sinon null).
- "complete" / "reschedule" / "delete" : l'utilisateur parle d'éléments existants. Choisis leurs identifiants dans la liste "Éléments en cours" et mets-les dans "ids". Pour "reschedule", remplis "new_due". Pour "complete", "status" vaut "done" (ou "waiting" si l'utilisateur dit qu'il attend une réponse du client). "c'est fait", "ok fait" sans autre précision désigne le dernier rappel envoyé. Si aucun élément ne correspond clairement, utilise "chat" et demande une précision dans "reply".
- "chat" : salutation, remerciement, question hors sujet ou demande ambiguë. Mets une réponse brève en français dans "reply".
- N'invente jamais d'identifiant. Les champs inutiles valent null ou [].`;

function context() {
  const now = nowLocal();
  const open = listItems({ status: 'open', from: addDays(todayLocal(), -30), includeUndated: true, limit: 40 });
  const lines = open.map((i) => `#${i.id} [${i.category}] ${i.title}${i.contact ? ` (contact : ${i.contact})` : ''} — ${i.due_local || 'sans date'} — ${i.status}`);
  const last = getSetting('last_reminded_id');
  return [
    `Date et heure actuelles : ${weekdayOf(now)} ${now} (fuseau ${config.timezone})`,
    `Heure par défaut : ${config.defaultTime}`,
    `Dernier rappel envoyé : ${last ? '#' + last : 'aucun'}`,
    `Éléments en cours :\n${lines.length ? lines.join('\n') : '(aucun)'}`,
  ].join('\n');
}

const line = (i, { withDay = true } = {}) => {
  const c = CATEGORIES[i.category];
  const when = i.due_local ? (withDay ? humanDate(i.due_local) : i.due_local.slice(11).replace(':', 'h')) : 'sans date';
  const state = i.status === 'done' ? ' ✔️' : i.status === 'waiting' ? ' ⏳' : '';
  return `${c.emoji} ${withDay ? '' : when + ' — '}${i.title}${withDay ? ` — ${when}` : ''}${state}`;
};

function validLocal(s) {
  return typeof s === 'string' && LOCAL_RE.test(s) && localToUtc(s) ? s.slice(0, 16) : null;
}

async function doCreate(intent) {
  const created = [];
  for (const raw of (intent.items || []).slice(0, 10)) {
    if (!raw?.title) continue;
    const item = createItem({
      title: raw.title,
      category: CATEGORIES[raw.category] ? raw.category : 'tache',
      due_local: validLocal(raw.due),
      contact: raw.contact || null,
      notes: raw.notes || null,
    }, 'whatsapp');
    created.push(item);
    syncItem(item);
  }
  if (!created.length) return "Je n'ai pas compris quoi enregistrer. Pouvez-vous reformuler ?";
  const out = created.map((i) => {
    const c = CATEGORIES[i.category];
    const when = i.due_local ? `🗓 ${humanDate(i.due_local)}\n⏰ Je vous le rappellerai à ce moment-là.` : '🗓 Sans date (pas de rappel automatique).';
    return `✅ Enregistré — ${c.emoji} ${c.label}\n*${i.title}*${i.contact ? `\n👤 ${i.contact}` : ''}\n${when}`;
  });
  const past = created.some((i) => i.due_at && new Date(i.due_at) < new Date());
  return out.join('\n\n') + (past ? "\n\n⚠️ Cette date est déjà passée : dites-moi « reporte à … » si ce n'est pas voulu." : '');
}

export function formatAgenda(items, title) {
  if (!items.length) return `${title}\n\nRien de prévu. 🎉`;
  const byDay = new Map();
  for (const i of items) {
    const k = i.due_local ? i.due_local.slice(0, 10) : 'sans date';
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(i);
  }
  const blocks = [...byDay].map(([day, list]) => {
    const head = day === 'sans date' ? 'Sans date' : humanDate(day, { withTime: false });
    return `*${head[0].toUpperCase()}${head.slice(1)}*\n${list.map((i) => (i.due_local ? line(i, { withDay: false }) : `${CATEGORIES[i.category].emoji} ${i.title}`)).join('\n')}`;
  });
  return `${title}\n\n${blocks.join('\n\n')}`;
}

function doList(intent) {
  const today = todayLocal();
  const from = validLocal(intent.range?.from) || `${today}T00:00`;
  let to = validLocal(intent.range?.to) || `${addDays(today, 1)}T00:00`;
  if (to <= from) to = `${addDays(from.slice(0, 10), 1)}T00:00`;
  const category = CATEGORIES[intent.category] ? intent.category : undefined;
  const items = listItems({ from, to, category, status: 'open' });
  const lastDay = addDays(to.slice(0, 10), to.slice(11) === '00:00' ? -1 : 0);
  const span = from.slice(0, 10) === lastDay ? humanDate(from, { withTime: false }) : `${humanDate(from, { withTime: false }) === "aujourd'hui" ? "d'aujourd'hui" : `du ${humanDate(from, { withTime: false })}`} au ${humanDate(lastDay, { withTime: false })}`;
  const what = category ? `${CATEGORIES[category].emoji} ${category === 'relance' ? 'Relances' : category === 'rdv' ? 'RDV' : CATEGORIES[category].label}` : '📋 Programme';
  return formatAgenda(items, `${what} — ${span}`);
}

function targets(intent) {
  return [...new Set((intent.ids || []).map(Number))].map((id) => getItem(id)).filter(Boolean);
}

function doComplete(intent) {
  const items = targets(intent);
  if (!items.length) return "Je n'ai pas trouvé l'élément concerné. Précisez son titre, ou demandez « mon programme » pour voir la liste.";
  const status = intent.status === 'waiting' ? 'waiting' : 'done';
  const done = items.map((i) => { const u = updateItem(i.id, { status }); syncItem(u); return u; });
  return `${status === 'done' ? '✔️ Terminé' : '⏳ En attente'} :\n${done.map((i) => `• ${i.title}`).join('\n')}`;
}

function doReschedule(intent) {
  const items = targets(intent);
  const due = validLocal(intent.new_due);
  if (!items.length) return "Je n'ai pas trouvé l'élément à reporter. Précisez son titre.";
  if (!due) return "À quelle date voulez-vous le reporter ?";
  const moved = items.map((i) => { const u = updateItem(i.id, { due_local: due, status: i.status === 'done' ? 'todo' : i.status }); syncItem(u); return u; });
  return `🔁 Reporté à ${humanDate(due)} :\n${moved.map((i) => `• ${i.title}`).join('\n')}`;
}

function doDelete(intent) {
  const items = targets(intent);
  if (!items.length) return "Je n'ai pas trouvé l'élément à supprimer. Précisez son titre.";
  for (const i of items) { deleteItem(i.id); unsyncItem(i); }
  return `🗑 Supprimé :\n${items.map((i) => `• ${i.title}`).join('\n')}`;
}

const HELP = `Je peux enregistrer vos rappels, tâches, RDV et relances. Exemples :
• « Rappelle-moi dans deux semaines de faire du sport »
• « Relance David demain à 14h pour l'appartement »
• « Ajoute un RDV visite jeudi à 10h »
• « Quel est mon programme aujourd'hui ? »
• « Quelles sont mes relances de la semaine ? »
• « C'est fait » / « Reporte la visite à vendredi 11h »`;

/** Traite un texte de l'utilisateur et renvoie la réponse à envoyer. */
export async function handleText(text) {
  const intent = await chatJSON(SYSTEM, `${context()}\n\nMessage de l'utilisateur :\n"""${text.slice(0, 2000)}"""`);
  switch (intent.action) {
    case 'create': return doCreate(intent);
    case 'list': return doList(intent);
    case 'complete': return doComplete(intent);
    case 'reschedule': return doReschedule(intent);
    case 'delete': return doDelete(intent);
    default: return (typeof intent.reply === 'string' && intent.reply.trim()) || HELP;
  }
}

/** Point d'entrée : message OpenWA déjà autorisé -> texte de réponse (ou null pour ne rien répondre). */
export async function handleMessage(msg) {
  try {
    let text = String(msg.body || '').trim();
    let prefix = '';
    if (msg.type === 'voice' || msg.type === 'audio') {
      let buffer, mimetype = msg.media?.mimetype || 'audio/ogg';
      if (msg.media?.data) buffer = Buffer.from(msg.media.data, 'base64');
      else ({ buffer, mimetype } = await downloadMedia(msg.chatId, msg.id));
      text = await transcribe(buffer, mimetype);
      prefix = `🎙 « ${text} »\n\n`;
    } else if (msg.type && msg.type !== 'text' && !text) {
      return 'Je comprends les messages texte et les notes vocales. 🙂';
    }
    if (!text) return null;
    return prefix + (await handleText(text));
  } catch (e) {
    if (e instanceof AIError) return `⚠️ ${e.message}`;
    console.error('[agent]', e);
    return "⚠️ Une erreur est survenue pendant le traitement de votre message. Réessayez dans un instant.";
  }
}
export { STATUSES };
