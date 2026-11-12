// Planificateur intégré : rappels à l'échéance + résumé quotidien.
import { config } from './config.js';
import { CATEGORIES, dueReminders, markReminded, listItems, getSetting, setSetting, purgeEvents } from './db.js';
import { sendText, cachedSession, getSession } from './openwa.js';
import { formatAgenda } from './agent.js';
import { nowLocal, todayLocal, addDays, humanDate } from './tz.js';

/** Conversation où écrire au propriétaire : la dernière utilisée, sinon son numéro. */
export const ownerChat = () => getSetting('owner_chat_id') || `${config.allowedPhone}@c.us`;

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const due = dueReminders();
    const briefingDue = config.briefingTime && nowLocal().slice(11) >= config.briefingTime && getSetting('briefing_date') !== todayLocal();
    if (!due.length && !briefingDue) return;
    if (cachedSession()?.status !== 'ready' && (await getSession())?.status !== 'ready') return; // WhatsApp non connecté : on réessaiera

    for (const item of due) {
      const c = CATEGORIES[item.category];
      const lateMin = Math.round((Date.now() - new Date(item.due_at).getTime()) / 60000);
      const late = lateMin > 10 ? `\n(prévu ${humanDate(item.due_local)})` : '';
      await sendText(ownerChat(), `⏰ *Rappel* — ${c.emoji} ${c.label}\n*${item.title}*${item.contact ? `\n👤 ${item.contact}` : ''}${late}\n\nRépondez « fait » pour le clôturer ou « reporte à … » pour le décaler.`);
      markReminded(item.id);
      setSetting('last_reminded_id', item.id);
    }

    if (briefingDue) {
      const today = todayLocal();
      const items = listItems({ from: `${today}T00:00`, to: `${addDays(today, 1)}T00:00`, status: 'open' });
      const overdue = listItems({ to: `${today}T00:00`, status: 'open' });
      if (items.length || overdue.length) {
        let text = formatAgenda(items, "☀️ Bonjour ! Votre programme d'aujourd'hui");
        if (overdue.length) text += `\n\n⚠️ En retard (${overdue.length}) :\n${overdue.slice(0, 8).map((i) => `• ${i.title}`).join('\n')}`;
        await sendText(ownerChat(), text);
      }
      setSetting('briefing_date', today);
    }
  } catch (e) {
    console.warn(`[scheduler] ${e.message}`);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setInterval(tick, 30_000);
  setInterval(purgeEvents, 6 * 3600_000);
  setTimeout(tick, 5_000);
  console.log(`[scheduler] actif (vérification toutes les 30 s, fuseau ${config.timezone}${config.briefingTime ? `, résumé quotidien à ${config.briefingTime}` : ''})`);
}
