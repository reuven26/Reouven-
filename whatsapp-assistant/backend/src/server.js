import http from 'node:http';
import { config, validateConfig } from './config.js';

const errors = validateConfig();
if (errors.length) {
  console.error('Configuration invalide (.env) :\n - ' + errors.join('\n - '));
  process.exit(1);
}

const { CATEGORIES, STATUSES, ValidationError, createItem, updateItem, deleteItem, getItem, listItems } = await import('./db.js');
const openwa = await import('./openwa.js');
const { verifySignature, processWebhook } = await import('./webhook.js');
const { syncItem, unsyncItem } = await import('./google.js');
const { startScheduler, ownerChat } = await import('./scheduler.js');
const { nowLocal } = await import('./tz.js');

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Corps trop volumineux'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  // Exiger application/json bloque les requêtes inter-sites « simples » (CSRF) vers le dashboard local
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Content-Type application/json requis'), { status: 415 });
  const raw = await readBody(req, 1_000_000);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw Object.assign(new Error('JSON invalide'), { status: 400 }); }
}

const mask = (p) => (p.length > 4 ? `${p.slice(0, 3)}${'•'.repeat(p.length - 5)}${p.slice(-2)}` : p);

async function whatsappStatus() {
  const s = await openwa.getSession();
  const status = s?.status || 'unavailable';
  const linked = String(s?.phone || '').replace(/\D/g, '');
  return {
    status,
    phone: s?.phone || null,
    pushName: s?.pushName || null,
    qr: status === 'qr_ready' ? await openwa.getQr().catch(() => null) : null,
    selfChat: !!linked && linked === config.allowedPhone,
    ...openwa.bridgeState(),
    sessionError: s?.lastError || null,
  };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

  // ---- Webhooks OpenWA (signés HMAC) ----
  if (m === 'POST' && path === '/webhooks/openwa') {
    const raw = await readBody(req, 40_000_000);
    if (!verifySignature(raw, req.headers['x-openwa-signature'])) {
      console.warn('[webhook] signature HMAC invalide — requête rejetée');
      return json(res, 401, { error: 'signature invalide' });
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    json(res, 200, { ok: true }); // on acquitte tout de suite, le traitement est asynchrone
    processWebhook(payload, req.headers['x-openwa-idempotency-key'])
      .then((r) => { if (payload.event?.startsWith('message.')) console.log(`[webhook] ${payload.event} : ${r}`); })
      .catch((e) => console.error('[webhook]', e.message));
    return;
  }

  // ---- API du dashboard ----
  if (m === 'GET' && path === '/api/config') {
    return json(res, 200, {
      timezone: config.timezone, now: nowLocal(), allowedPhone: mask(config.allowedPhone),
      categories: CATEGORIES, statuses: STATUSES,
      llm: { provider: config.llm.provider, model: config.llm.model, ready: config.llm.ready },
      transcription: { provider: config.stt.provider, ready: config.stt.ready },
      google: config.google.enabled, briefingTime: config.briefingTime || null,
    });
  }

  if (path === '/api/items') {
    if (m === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      return json(res, 200, listItems({ from: q.from, to: q.to, category: q.category, status: q.status, includeUndated: q.undated === '1' }));
    }
    if (m === 'POST') {
      const item = createItem(await jsonBody(req), 'dashboard');
      syncItem(item);
      return json(res, 201, item);
    }
  }

  const im = /^\/api\/items\/(\d+)$/.exec(path);
  if (im) {
    if (m === 'GET') { const it = getItem(im[1]); return it ? json(res, 200, it) : json(res, 404, { error: 'Introuvable' }); }
    if (m === 'PATCH') {
      const { google_ref, ...body } = await jsonBody(req);
      const it = updateItem(im[1], body);
      if (!it) return json(res, 404, { error: 'Introuvable' });
      syncItem(it);
      return json(res, 200, it);
    }
    if (m === 'DELETE') {
      if (req.headers['x-requested-with'] !== 'dashboard') return json(res, 403, { error: 'Requête refusée' });
      const it = deleteItem(im[1]);
      if (!it) return json(res, 404, { error: 'Introuvable' });
      unsyncItem(it);
      return json(res, 200, { ok: true });
    }
  }

  if (m === 'GET' && path === '/api/whatsapp') return json(res, 200, await whatsappStatus());
  if (m === 'POST' && path.startsWith('/api/whatsapp/')) {
    await jsonBody(req);
    const action = path.split('/').pop();
    if (action === 'start') { await openwa.ensureSession(); await openwa.ensureWebhook(); return json(res, 200, await whatsappStatus()); }
    if (action === 'logout') { await openwa.logoutSession(); return json(res, 200, await whatsappStatus()); }
    if (action === 'test') {
      await openwa.sendText(ownerChat(), 'Message de test : votre assistant est bien connecté. ✅');
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'Route inconnue' });
}

http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return;
    if (e instanceof ValidationError) return json(res, 400, { error: e.message });
    if (e instanceof openwa.OpenWAError) return json(res, 502, { error: `OpenWA : ${e.message}` });
    if (e.status) return json(res, e.status, { error: e.message });
    console.error('[http]', e);
    json(res, 500, { error: 'Erreur interne' });
  });
}).listen(config.port, () => {
  console.log(`[backend] en écoute sur :${config.port} — numéro autorisé ${mask(config.allowedPhone)}, IA ${config.llm.provider}${config.llm.ready ? '' : ' (clé manquante !)'}, Google ${config.google.enabled ? 'activé' : 'désactivé'}`);
  openwa.bootstrap();
  startScheduler();
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
