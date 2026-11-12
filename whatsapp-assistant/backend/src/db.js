import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { localToUtc, utcToLocal } from './tz.js';

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'assistant.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'tache' CHECK (category IN ('sport_perso','tache','rdv','relance')),
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','waiting','done')),
    due_at TEXT,
    contact TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'dashboard',
    reminder_sent_at TEXT,
    google_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_items_due ON items(due_at);
  CREATE TABLE IF NOT EXISTS processed_events (key TEXT PRIMARY KEY, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

export const CATEGORIES = {
  sport_perso: { label: 'Sport / Perso', emoji: '🏃' },
  tache: { label: 'Tâche', emoji: '✅' },
  rdv: { label: 'RDV', emoji: '📅' },
  relance: { label: 'Relance client', emoji: '📞' },
};
export const STATUSES = { todo: 'À faire', waiting: 'En attente', done: 'Terminé' };

const iso = (d = new Date()) => new Date(d).toISOString();
const present = (row) => row && { ...row, due_local: row.due_at ? utcToLocal(row.due_at) : null };

export class ValidationError extends Error {}

function clean(input, { partial = false } = {}) {
  const out = {};
  if (input.title !== undefined || !partial) {
    const title = String(input.title ?? '').trim().slice(0, 300);
    if (!title) throw new ValidationError('Le titre est obligatoire.');
    out.title = title;
  }
  if (input.category !== undefined) {
    if (!CATEGORIES[input.category]) throw new ValidationError('Catégorie invalide.');
    out.category = input.category;
  }
  if (input.status !== undefined) {
    if (!STATUSES[input.status]) throw new ValidationError('Statut invalide.');
    out.status = input.status;
  }
  if (input.due_local !== undefined) {
    if (input.due_local === null || input.due_local === '') out.due_at = null;
    else {
      const d = localToUtc(input.due_local);
      if (!d) throw new ValidationError('Date invalide (format attendu : AAAA-MM-JJTHH:mm).');
      out.due_at = iso(d);
    }
  }
  for (const k of ['contact', 'notes']) {
    if (input[k] !== undefined) out[k] = input[k] ? String(input[k]).trim().slice(0, 2000) : null;
  }
  return out;
}

export function getItem(id) {
  return present(db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id)));
}

export function createItem(input, source = 'dashboard') {
  const f = clean(input);
  const now = iso();
  const status = f.status || 'todo';
  const res = db.prepare(`INSERT INTO items (title, category, status, due_at, contact, notes, source, created_at, updated_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    f.title, f.category || 'tache', status, f.due_at ?? null, f.contact ?? null, f.notes ?? null,
    source, now, now, status === 'done' ? now : null);
  return getItem(res.lastInsertRowid);
}

export function updateItem(id, input) {
  const current = getItem(id);
  if (!current) return null;
  const f = clean(input, { partial: true });
  // Reporter une échéance réarme le rappel
  if ('due_at' in f && f.due_at !== current.due_at) f.reminder_sent_at = null;
  if (f.status && f.status !== current.status) f.completed_at = f.status === 'done' ? iso() : null;
  if (input.google_ref !== undefined) f.google_ref = input.google_ref;
  const keys = Object.keys(f);
  if (keys.length) {
    db.prepare(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => f[k]), iso(), Number(id));
  }
  return getItem(id);
}

export function deleteItem(id) {
  const item = getItem(id);
  if (item) db.prepare('DELETE FROM items WHERE id = ?').run(Number(id));
  return item;
}

/** Filtres : from/to (dates locales), category, status ("open" = non terminé), includeUndated */
export function listItems({ from, to, category, status, includeUndated = false, limit = 500 } = {}) {
  const where = [], args = [];
  const range = [];
  if (from) { range.push('due_at >= ?'); args.push(iso(localToUtc(from))); }
  if (to) { range.push('due_at < ?'); args.push(iso(localToUtc(to))); }
  if (range.length) where.push(includeUndated ? `((${range.join(' AND ')}) OR due_at IS NULL)` : `(${range.join(' AND ')})`);
  if (category) { where.push('category = ?'); args.push(category); }
  if (status === 'open') where.push("status != 'done'");
  else if (status) { where.push('status = ?'); args.push(status); }
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY due_at IS NULL, due_at ASC, id ASC LIMIT ?`;
  return db.prepare(sql).all(...args, limit).map(present);
}

export function dueReminders() {
  return db.prepare(`SELECT * FROM items WHERE due_at IS NOT NULL AND due_at <= ? AND reminder_sent_at IS NULL AND status != 'done'
    ORDER BY due_at ASC LIMIT 20`).all(iso()).map(present);
}
export function markReminded(id) {
  db.prepare('UPDATE items SET reminder_sent_at = ? WHERE id = ?').run(iso(), id);
}

/** true si l'évènement n'a encore jamais été vu (déduplication at-least-once). */
export function claimEvent(key) {
  const res = db.prepare('INSERT OR IGNORE INTO processed_events (key, at) VALUES (?, ?)').run(key, iso());
  return res.changes === 1;
}
export function purgeEvents() {
  db.prepare('DELETE FROM processed_events WHERE at < ?').run(iso(Date.now() - 7 * 864e5));
}

export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
