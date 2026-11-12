// Dashboard — aucune dépendance. Les dates manipulées sont des chaînes locales "YYYY-MM-DDTHH:mm"
// exprimées dans le fuseau configuré côté serveur (TIMEZONE), pas dans celui du navigateur.

const $ = (s) => document.querySelector(s);
const state = { view: 'today', items: [], cfg: null, wa: null, month: null, editing: null };

// ---------- utilitaires ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'dashboard' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const pad = (n) => String(n).padStart(2, '0');
function nowLocal() {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: state.cfg.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const today = () => nowLocal().slice(0, 10);
const asDate = (local) => new Date(`${local.length === 10 ? `${local}T00:00` : local}:00Z`); // arithmétique « murale »
const fromDate = (d) => d.toISOString().slice(0, 16);
const addMin = (local, n) => fromDate(new Date(asDate(local).getTime() + n * 60000));
const addDays = (day, n) => addMin(`${day.slice(0, 10)}T00:00`, n * 1440).slice(0, 10);
const fmtDay = (day, opts = { weekday: 'long', day: 'numeric', month: 'long' }) =>
  new Intl.DateTimeFormat('fr-FR', { ...opts, timeZone: 'UTC' }).format(asDate(day));
const fmtTime = (local) => local.slice(11).replace(':', 'h');
const isLate = (i) => i.status !== 'done' && i.due_local && i.due_local < nowLocal();
const cat = (i) => state.cfg.categories[i.category];

// ---------- données ----------
async function load() {
  state.items = await api('GET', '/items');
  render();
}
async function loadWa() {
  try { state.wa = await api('GET', '/whatsapp'); } catch (e) { state.wa = { status: 'unavailable', lastError: e.message }; }
  const s = state.wa.status;
  $('#wa-dot').className = `dot ${s === 'ready' ? 'ok' : s === 'unavailable' || s === 'failed' || s === 'disconnected' ? 'ko' : 'wait'}`;
  const banner = $('#banner');
  if (s !== 'ready' && state.view !== 'whatsapp') {
    banner.replaceChildren('WhatsApp n\'est pas connecté : les rappels ne peuvent pas être envoyés. ',
      h('a', { href: '#whatsapp', onclick: () => go('whatsapp') }, 'Connecter WhatsApp →'));
    banner.hidden = false;
  } else if (!state.cfg.llm.ready) {
    banner.replaceChildren(`Clé API ${state.cfg.llm.provider} absente : l'assistant ne peut pas comprendre vos messages. Renseignez-la dans le fichier .env puis relancez « docker compose up -d ».`);
    banner.hidden = false;
  } else banner.hidden = true;
  if (state.view === 'whatsapp') render();
}

async function mutate(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await load(); }
  catch (e) { toast(e.message); }
}
const patch = (id, body, msg) => mutate(() => api('PATCH', `/items/${id}`, body), msg);
const toggleDone = (i) => patch(i.id, { status: i.status === 'done' ? 'todo' : 'done' }, i.status === 'done' ? 'Remis à faire' : 'Terminé ✔');

function snooze(i, key) {
  const now = nowLocal();
  const base = i.due_local && i.due_local > now ? i.due_local : now;
  const time = i.due_local ? i.due_local.slice(11) : '09:00';
  const due = {
    '1h': addMin(now, 60),
    soir: `${today()}T20:00`,
    demain: `${addDays(today(), 1)}T${time}`,
    '1j': `${addDays(base, 1)}T${time}`,
    '1s': `${addDays(base, 7)}T${time}`,
  }[key];
  if (due) patch(i.id, { due_local: due, status: i.status === 'done' ? 'todo' : i.status }, `Reporté : ${fmtDay(due.slice(0, 10))} à ${fmtTime(due)}`);
}

function snoozeSelect(i) {
  const sel = h('select', { 'aria-label': 'Reporter', title: 'Reporter', onchange: () => { snooze(i, sel.value); sel.value = ''; } },
    h('option', { value: '' }, 'Reporter…'),
    h('option', { value: '1h' }, 'Dans 1 heure'),
    h('option', { value: 'soir' }, 'Ce soir 20h'),
    h('option', { value: 'demain' }, 'Demain'),
    h('option', { value: '1j' }, '+ 1 jour'),
    h('option', { value: '1s' }, '+ 1 semaine'));
  return sel;
}

// ---------- vue Aujourd'hui / À venir ----------
function itemRow(i, { showDay = false } = {}) {
  const when = i.due_local ? (showDay ? `${fmtDay(i.due_local.slice(0, 10), { day: 'numeric', month: 'short' })} ${fmtTime(i.due_local)}` : fmtTime(i.due_local)) : '—';
  return h('div', { class: `item ${i.status === 'done' ? 'done' : ''} ${isLate(i) ? 'late' : ''}` },
    h('button', { class: 'check', 'aria-label': i.status === 'done' ? 'Remettre à faire' : 'Marquer comme terminé', onclick: () => toggleDone(i) }, '✓'),
    h('span', { class: 'when' }, when),
    h('div', { class: 'body', onclick: () => openForm(i) },
      h('div', { class: 'title' }, i.title),
      h('div', { class: 'meta' },
        h('span', { class: `chip ${i.category}` }, cat(i).label),
        i.status === 'waiting' && h('span', { class: 'chip waiting' }, 'En attente'),
        i.contact && h('span', {}, `👤 ${i.contact}`),
        i.source === 'whatsapp' && h('span', { title: 'Créé depuis WhatsApp' }, '💬'))),
    h('div', { class: 'ops' }, i.status !== 'done' && snoozeSelect(i)));
}

function section(title, items, opts) {
  if (!items.length) return null;
  return [h('h3', {}, `${title} · ${items.length}`), h('div', { class: 'list' }, items.map((i) => itemRow(i, opts)))];
}

function viewToday() {
  const t = today(), now = nowLocal(), tomorrow = addDays(t, 1), week = addDays(t, 7);
  const open = state.items.filter((i) => i.status !== 'done');
  const day = (i) => i.due_local?.slice(0, 10);
  const late = open.filter((i) => i.due_local && day(i) < t);
  const todays = state.items.filter((i) => day(i) === t);
  const tom = open.filter((i) => day(i) === tomorrow);
  const wk = open.filter((i) => day(i) > tomorrow && day(i) < week);
  const later = open.filter((i) => day(i) >= week);
  const undated = open.filter((i) => !i.due_local);
  $('#view-sub').textContent = `${fmtDay(t)} · ${fmtTime(now)} (${state.cfg.timezone})`;

  const stats = h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', {}, todays.filter((i) => i.status !== 'done').length), h('span', {}, "à faire aujourd'hui")),
    h('div', { class: `stat ${late.length ? 'late' : ''}` }, h('b', {}, late.length), h('span', {}, 'en retard')),
    h('div', { class: 'stat' }, h('b', {}, open.filter((i) => i.category === 'relance').length), h('span', {}, 'relances ouvertes')),
    h('div', { class: 'stat' }, h('b', {}, tom.length + wk.length), h('span', {}, 'dans les 7 jours')));

  const blocks = [
    section('En retard', late, { showDay: true }),
    section("Aujourd'hui", todays),
    section('Demain', tom),
    section('Cette semaine', wk, { showDay: true }),
    section('Plus tard', later, { showDay: true }),
    section('Sans date', undated),
  ].filter(Boolean);
  return [stats, blocks.length ? blocks : h('div', { class: 'list' }, h('div', { class: 'empty' },
    'Rien de prévu. Écrivez à votre assistant sur WhatsApp ou cliquez sur « + Ajouter ».'))];
}

// ---------- vue Calendrier ----------
function viewCalendar() {
  state.month ||= today().slice(0, 7);
  const first = `${state.month}-01`;
  const dow = (asDate(first).getUTCDay() + 6) % 7; // lundi = 0
  const start = addDays(first, -dow);
  const t = today();
  $('#view-sub').textContent = 'Cliquez sur un jour pour ajouter, sur un élément pour le modifier.';
  const shift = (n) => { const d = asDate(first); d.setUTCMonth(d.getUTCMonth() + n); state.month = d.toISOString().slice(0, 7); render(); };

  const byDay = {};
  for (const i of state.items) if (i.due_local) (byDay[i.due_local.slice(0, 10)] ||= []).push(i);

  const cells = [];
  for (let n = 0; n < 42; n++) {
    const d = addDays(start, n);
    if (n % 7 === 0 && n >= 28 && d.slice(0, 7) !== state.month) break; // pas de semaine entièrement hors mois
    const list = byDay[d] || [];
    cells.push(h('div', { class: `day ${d.slice(0, 7) !== state.month ? 'out' : ''} ${d === t ? 'today' : ''}`, onclick: () => openForm(null, { date: d }) },
      h('span', { class: 'num' }, +d.slice(8)),
      list.slice(0, 3).map((i) => h('button', { class: `ev ${i.category} ${i.status === 'done' ? 'done' : ''}`, title: `${fmtTime(i.due_local)} ${i.title}`,
        onclick: (e) => { e.stopPropagation(); openForm(i); } }, `${fmtTime(i.due_local)} ${i.title}`)),
      list.length > 3 && h('span', { class: 'more' }, `+ ${list.length - 3} autres`)));
  }
  return [
    h('div', { class: 'cal-head' },
      h('button', { class: 'btn small', 'aria-label': 'Mois précédent', onclick: () => shift(-1) }, '‹'),
      h('strong', {}, fmtDay(first, { month: 'long', year: 'numeric' })),
      h('button', { class: 'btn small', 'aria-label': 'Mois suivant', onclick: () => shift(1) }, '›'),
      h('button', { class: 'btn small', onclick: () => { state.month = today().slice(0, 7); render(); } }, "Aujourd'hui")),
    h('div', { class: 'cal' }, ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map((d) => h('div', { class: 'dow' }, d)), cells),
  ];
}

// ---------- vue Relances ----------
function viewFollowups() {
  const rel = state.items.filter((i) => i.category === 'relance');
  $('#view-sub').textContent = 'Glissez une carte d\'une colonne à l\'autre pour changer son statut.';
  const cols = Object.entries(state.cfg.statuses).map(([status, label]) => {
    let list = rel.filter((i) => i.status === status);
    if (status === 'done') list = list.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).slice(0, 30);
    const col = h('div', { class: 'col',
      ondragover: (e) => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id) patch(id, { status }, `Déplacé : ${label}`); } },
      h('h3', {}, h('span', {}, label), h('span', {}, list.length)),
      list.length ? list.map((i) => h('div', { class: `card ${isLate(i) ? 'late' : ''}`, draggable: 'true', ondragstart: (e) => e.dataTransfer.setData('text/plain', String(i.id)) },
        h('div', { class: 'title', onclick: () => openForm(i) }, i.title),
        h('div', { class: 'meta' },
          i.contact && h('span', {}, `👤 ${i.contact}`),
          h('span', { class: 'when' }, i.due_local ? `${fmtDay(i.due_local.slice(0, 10), { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(i.due_local)}` : 'Sans date')),
        h('div', { class: 'ops' },
          status !== 'todo' && h('button', { onclick: () => patch(i.id, { status: 'todo' }) }, 'À faire'),
          status !== 'waiting' && h('button', { onclick: () => patch(i.id, { status: 'waiting' }) }, 'En attente'),
          status !== 'done' && h('button', { onclick: () => patch(i.id, { status: 'done' }, 'Terminé ✔') }, 'Terminé'),
          status !== 'done' && snoozeSelect(i))))
        : h('div', { class: 'empty' }, 'Aucune relance'));
    return col;
  });
  return h('div', { class: 'board' }, cols);
}

// ---------- vue WhatsApp ----------
const WA_LABEL = {
  ready: ['ok', 'Connecté'], qr_ready: ['wait', 'En attente du scan du QR code'], initializing: ['wait', 'Démarrage…'],
  authenticating: ['wait', 'Authentification…'], created: ['wait', 'Session créée'], disconnected: ['ko', 'Déconnecté'],
  action_required: ['ko', 'Action requise'], failed: ['ko', 'Échec'], unavailable: ['ko', 'Passerelle OpenWA injoignable'],
};
function viewWhatsapp() {
  const w = state.wa || { status: 'unavailable' }, c = state.cfg;
  const [cls, label] = WA_LABEL[w.status] || ['wait', w.status];
  $('#view-sub').textContent = 'Passerelle OpenWA (moteur Baileys) — session « assistant ».';
  const act = (path, msg) => async () => { try { await api('POST', `/whatsapp/${path}`); toast(msg); } catch (e) { toast(e.message); } loadWa(); };

  const qr = w.status === 'ready'
    ? h('div', { class: 'qr' }, `✅ Compte lié${w.phone ? ` : +${w.phone}` : ''}${w.pushName ? ` (${w.pushName})` : ''}`)
    : w.qr ? h('div', { class: 'qr' }, h('img', { src: w.qr, alt: 'QR code de connexion WhatsApp' }))
    : h('div', { class: 'qr' }, w.status === 'unavailable' ? 'OpenWA ne répond pas encore. Patientez quelques secondes…' : 'QR code en cours de génération…');

  return h('div', { class: 'wa' },
    h('div', { class: 'panel' }, qr,
      h('div', { class: 'btns' },
        w.status === 'ready' && h('button', { class: 'btn primary', onclick: act('test', 'Message de test envoyé') }, 'Envoyer un message de test'),
        w.status !== 'ready' && h('button', { class: 'btn', onclick: act('start', 'Session relancée') }, 'Relancer la session'),
        w.status === 'ready' && h('button', { class: 'btn danger', onclick: () => confirm('Délier ce compte WhatsApp ?') && act('logout', 'Compte délié')() }, 'Délier le compte'))),
    h('div', { class: 'panel' },
      h('span', { class: `badge ${cls}` }, label),
      (w.sessionError || w.lastError) && h('p', { class: 'err' }, w.sessionError || w.lastError),
      w.status !== 'ready' && h('ol', {},
        h('li', {}, 'Ouvrez WhatsApp sur votre téléphone.'),
        h('li', {}, 'Réglages → Appareils connectés → Connecter un appareil.'),
        h('li', {}, 'Scannez le QR code affiché ici (il se renouvelle automatiquement).')),
      w.status === 'ready' && h('p', {}, w.selfChat
        ? 'Écrivez-vous à vous-même sur WhatsApp (conversation « Vous ») : l\'assistant répond dans ce fil, ses messages commencent par 🤖.'
        : 'Ce compte sert de numéro d\'assistant : écrivez-lui depuis votre numéro autorisé.'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Numéro autorisé'), h('dd', {}, `+${c.allowedPhone} (tous les autres expéditeurs et les groupes sont ignorés)`),
        h('dt', {}, 'Webhook signé HMAC'), h('dd', {}, w.webhookOk ? '✅ enregistré' : '⏳ en attente'),
        h('dt', {}, 'Fuseau horaire'), h('dd', {}, c.timezone),
        h('dt', {}, 'IA'), h('dd', {}, `${c.llm.provider} · ${c.llm.model} ${c.llm.ready ? '✅' : '⚠️ clé manquante dans .env'}`),
        h('dt', {}, 'Notes vocales'), h('dd', {}, `${c.transcription.provider} (Whisper) ${c.transcription.ready ? '✅' : '⚠️ clé manquante dans .env'}`),
        h('dt', {}, 'Google'), h('dd', {}, c.google ? '✅ synchronisation active' : 'désactivé (optionnel)'),
        h('dt', {}, 'Résumé quotidien'), h('dd', {}, c.briefingTime || 'désactivé')),
      h('p', {}, h('a', { href: `http://${location.hostname}:2785`, target: '_blank', rel: 'noopener' }, 'Ouvrir le dashboard natif OpenWA ↗'),
        h('br'), h('span', { class: 'muted' }, 'Clé demandée : la valeur de '), h('code', {}, 'OPENWA_API_KEY'), h('span', { class: 'muted' }, ' dans votre fichier .env.'))));
}

// ---------- formulaire ----------
const form = $('#form'), dlg = $('#dlg');
function openForm(item, preset = {}) {
  state.editing = item;
  $('#dlg-title').textContent = item ? 'Modifier' : 'Nouvel élément';
  $('#del-btn').hidden = !item;
  $('#form-err').hidden = true;
  const f = form.elements;
  f.title.value = item?.title || '';
  f.category.value = item?.category || preset.category || (state.view === 'followups' ? 'relance' : 'tache');
  f.status.value = item?.status || 'todo';
  f.date.value = item?.due_local?.slice(0, 10) || preset.date || (item ? '' : today());
  f.time.value = item?.due_local?.slice(11) || (item ? '' : '09:00');
  f.contact.value = item?.contact || '';
  f.notes.value = item?.notes || '';
  dlg.showModal();
  f.title.focus();
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const body = {
    title: f.title.value, category: f.category.value, status: f.status.value,
    due_local: f.date.value ? `${f.date.value}T${f.time.value || '09:00'}` : null,
    contact: f.contact.value, notes: f.notes.value,
  };
  try {
    if (state.editing) await api('PATCH', `/items/${state.editing.id}`, body);
    else await api('POST', '/items', body);
    dlg.close(); toast('Enregistré'); await load();
  } catch (err) { $('#form-err').textContent = err.message; $('#form-err').hidden = false; }
});
$('#cancel-btn').addEventListener('click', () => dlg.close());
$('#del-btn').addEventListener('click', () => {
  if (!confirm('Supprimer définitivement cet élément ?')) return;
  const id = state.editing.id;
  dlg.close();
  mutate(() => api('DELETE', `/items/${id}`), 'Supprimé');
});
$('#add-btn').addEventListener('click', () => openForm(null));

// ---------- navigation ----------
const VIEWS = {
  today: ["Aujourd'hui & à venir", viewToday], calendar: ['Calendrier', viewCalendar],
  followups: ['Suivi & relances clients', viewFollowups], whatsapp: ['Connexion WhatsApp', viewWhatsapp],
};
function render() {
  if (!state.cfg) return;
  const [title, fn] = VIEWS[state.view];
  $('#view-title').textContent = title;
  $('#add-btn').hidden = state.view === 'whatsapp';
  const out = fn();
  $('#view').replaceChildren(...[out].flat(3).filter(Boolean));
}
function go(view) {
  state.view = VIEWS[view] ? view : 'today';
  history.replaceState(null, '', `#${state.view}`);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  render(); loadWa();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(b.dataset.view); });

async function init() {
  try { state.cfg = await api('GET', '/config'); }
  catch { $('#view').replaceChildren(h('div', { class: 'list' }, h('div', { class: 'empty' }, 'Le backend démarre… nouvelle tentative dans 3 secondes.'))); setTimeout(init, 3000); return; }
  const f = form.elements;
  f.category.replaceChildren(...Object.entries(state.cfg.categories).map(([k, v]) => h('option', { value: k }, `${v.emoji} ${v.label}`)));
  f.status.replaceChildren(...Object.entries(state.cfg.statuses).map(([k, v]) => h('option', { value: k }, v)));
  $('#nav-foot').textContent = `Fuseau : ${state.cfg.timezone}`;
  go(location.hash.slice(1) || 'today');
  await load();
  setInterval(() => { if (!dlg.open) load().catch(() => {}); }, 30000);
  setInterval(loadWa, 5000);
}
init();
