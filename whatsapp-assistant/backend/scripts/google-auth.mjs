#!/usr/bin/env node
// Obtient un GOOGLE_REFRESH_TOKEN (à lancer une seule fois, sur votre machine) :
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node backend/scripts/google-auth.mjs
// Prérequis : un identifiant OAuth « Application de bureau » dans Google Cloud Console,
// avec les API Google Calendar et Google Tasks activées.
import http from 'node:http';

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error('Définissez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET.'); process.exit(1); }
const PORT = 5757, redirect = `http://127.0.0.1:${PORT}`;
const scope = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks';

http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('En attente du code…'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  res.end(j.refresh_token ? 'OK, vous pouvez fermer cet onglet.' : 'Échec : ' + JSON.stringify(j));
  console.log(j.refresh_token ? `\nAjoutez dans .env :\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n` : j);
  process.exit(j.refresh_token ? 0 : 1);
}).listen(PORT, '127.0.0.1', () => {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' });
  console.log(`Ouvrez ce lien dans votre navigateur :\n\n${u}\n`);
});
