// Conversions fuseau horaire sans dépendance. Format local : "YYYY-MM-DDTHH:mm".
import { config } from './config.js';

const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}
function wall(date, tz) {
  const p = {};
  for (const { type, value } of partsFmt(tz).formatToParts(date)) p[type] = value;
  return p;
}
function offsetMs(date, tz) {
  const p = wall(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** "2026-11-13T14:00" (heure murale dans tz) -> Date UTC. Renvoie null si invalide. */
export function localToUtc(local, tz = config.timezone) {
  const m = LOCAL_RE.exec(String(local || ''));
  if (!m) return null;
  const [dh, dm] = config.defaultTime.split(':').map(Number);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] !== undefined ? +m[4] : dh, m[5] !== undefined ? +m[5] : dm);
  if (Number.isNaN(guess)) return null;
  let utc = guess - offsetMs(new Date(guess), tz);
  utc = guess - offsetMs(new Date(utc), tz); // 2e passe : changements d'heure
  return new Date(utc);
}

/** Date UTC -> "YYYY-MM-DDTHH:mm" dans tz. */
export function utcToLocal(date, tz = config.timezone) {
  const p = wall(new Date(date), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export const nowLocal = () => utcToLocal(new Date());
export const todayLocal = () => nowLocal().slice(0, 10);

/** Ajoute n jours à une date locale "YYYY-MM-DD..." (arithmétique calendaire). */
export function addDays(local, n) {
  const m = LOCAL_RE.exec(local);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10) + local.slice(10);
}

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export function weekdayOf(local) {
  const m = LOCAL_RE.exec(local);
  return DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}
/** "jeudi 19 novembre à 10h00" / "aujourd'hui à 14h00" */
export function humanDate(local, { withTime = true } = {}) {
  const m = LOCAL_RE.exec(local);
  if (!m) return '';
  const day = local.slice(0, 10), today = todayLocal();
  let label;
  if (day === today) label = "aujourd'hui";
  else if (day === addDays(today, 1)) label = 'demain';
  else {
    label = `${weekdayOf(local)} ${+m[3]} ${MONTHS[+m[2] - 1]}`;
    if (m[1] !== today.slice(0, 4)) label += ` ${m[1]}`;
  }
  return withTime && m[4] !== undefined ? `${label} à ${m[4]}h${m[5]}` : label;
}
