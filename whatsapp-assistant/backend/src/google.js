// Synchronisation optionnelle : RDV -> Google Calendar, autres catégories -> Google Tasks.
// Activée seulement si GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN sont renseignés.
import { config } from './config.js';
import { CATEGORIES, updateItem } from './db.js';
import { addDays } from './tz.js';

const g = config.google;
let token = null, tokenExp = 0;

async function accessToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OAuth Google ${res.status}`);
  const j = await res.json();
  token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Google API ${res.status} ${(await res.text()).slice(0, 150)}`);
  return res.status === 204 ? {} : res.json();
}

const CAL = () => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(g.calendarId)}/events`;
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

function eventBody(item) {
  const [date, time] = item.due_local.split('T');
  const [h, m] = time.split(':').map(Number);
  const endMin = h * 60 + m + 60;
  const endDate = endMin >= 1440 ? addDays(date, 1) : date;
  const end = `${endDate}T${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}:00`;
  return {
    summary: item.title,
    description: [item.contact && `Contact : ${item.contact}`, item.notes].filter(Boolean).join('\n') || undefined,
    start: { dateTime: `${item.due_local}:00`, timeZone: config.timezone },
    end: { dateTime: end, timeZone: config.timezone },
  };
}
function taskBody(item) {
  return {
    title: `${CATEGORIES[item.category].emoji} ${item.title}`,
    notes: [item.contact && `Contact : ${item.contact}`, item.due_local && `Échéance : ${item.due_local.replace('T', ' ')}`, item.notes].filter(Boolean).join('\n') || undefined,
    due: item.due_local ? `${item.due_local.slice(0, 10)}T00:00:00.000Z` : undefined, // Google Tasks ne conserve que la date
    status: item.status === 'done' ? 'completed' : 'needsAction',
  };
}

async function remove(ref) {
  const [kind, id] = ref.split(':');
  await call('DELETE', kind === 'event' ? `${CAL()}/${id}` : `${TASKS}/${id}`);
}

/** Pousse un élément vers Google (création ou mise à jour). Ne lève jamais : journalise seulement. */
export async function syncItem(item) {
  if (!g.enabled || !item) return;
  try {
    const wantEvent = item.category === 'rdv' && !!item.due_local;
    let ref = item.google_ref;
    if (ref && ref.startsWith('event:') !== wantEvent) { await remove(ref); ref = null; }
    let saved;
    if (wantEvent) {
      const body = eventBody(item);
      saved = ref ? await call('PATCH', `${CAL()}/${ref.slice(6)}`, body) : null;
      saved ||= await call('POST', CAL(), body);
    } else {
      const body = taskBody(item);
      saved = ref ? await call('PATCH', `${TASKS}/${ref.slice(5)}`, body) : null;
      saved ||= await call('POST', TASKS, body);
    }
    const newRef = `${wantEvent ? 'event' : 'task'}:${saved.id}`;
    if (newRef !== item.google_ref) updateItem(item.id, { google_ref: newRef });
  } catch (e) { console.warn(`[google] synchronisation de #${item.id} impossible : ${e.message}`); }
}

export async function unsyncItem(item) {
  if (!g.enabled || !item?.google_ref) return;
  try { await remove(item.google_ref); } catch (e) { console.warn(`[google] suppression de #${item.id} impossible : ${e.message}`); }
}
