# Assistant personnel WhatsApp (auto-hébergé)

Envoyez un message texte ou une note vocale sur WhatsApp — « Rappelle-moi dans deux semaines de faire du
sport », « Relance David demain à 14h pour l'appartement », « Ajoute un RDV visite jeudi à 10h » — et
l'assistant l'enregistre, vous confirme, puis vous le rappelle à l'heure dite. Un dashboard web permet de
tout voir et modifier.

```
 WhatsApp ⇄ OpenWA (Baileys) ──webhook signé HMAC──▶ backend (agent IA + SQLite + planificateur)
              :2785          ◀──── API REST X-API-Key ────┘            ▲
                                                             dashboard (nginx) :3000
```

| Conteneur   | Rôle | Port (127.0.0.1 uniquement) |
|-------------|------|------|
| `openwa`    | Passerelle WhatsApp [OpenWA](https://github.com/rmyndharis/OpenWA), image officielle, moteur `baileys` | 2785 |
| `backend`   | Webhooks, agent IA, base SQLite, rappels (Node 22, aucune dépendance npm) | — (interne) |
| `dashboard` | Interface web | 3000 |

## Démarrage

Prérequis : Docker et Docker Compose.

```bash
cd whatsapp-assistant
```

```bash
./setup.sh
```

`setup.sh` crée `.env`, demande votre numéro autorisé, génère la clé admin OpenWA (`X-API-Key`) et le secret
HMAC des webhooks, puis lance `docker compose up -d --build`. Ensuite :

1. Ajoutez votre clé IA dans `.env` (`GROQ_API_KEY=...`, gratuite sur <https://console.groq.com/keys>), puis
   relancez `docker compose up -d`.
2. Ouvrez <http://localhost:3000> → onglet **WhatsApp** et scannez le QR code
   (WhatsApp → Réglages → Appareils connectés → Connecter un appareil).
3. Écrivez à l'assistant.

Le backend crée tout seul la session OpenWA `assistant` et y enregistre son webhook ; il n'y a rien à
configurer dans OpenWA. Son dashboard natif reste disponible sur <http://localhost:2785> (clé :
`OPENWA_API_KEY` du `.env`).

### À qui écrire ?

- **Vous liez votre propre numéro** (cas le plus simple) : écrivez dans la conversation avec vous-même
  (« Vous »). L'assistant répond dans ce fil ; ses messages commencent par 🤖.
- **Vous liez un second numéro** dédié à l'assistant : écrivez-lui depuis votre numéro autorisé.

## Ce que l'assistant comprend

| Vous écrivez (ou dictez) | Il fait |
|---|---|
| « Rappelle-moi dans deux semaines de faire du sport » | crée un rappel Sport/Perso |
| « Relance David demain à 14h pour l'appartement » | crée une relance client (contact : David) |
| « Ajoute un RDV visite jeudi à 10h » | crée un RDV |
| « Quel est mon programme aujourd'hui ? » / « Mes relances de la semaine ? » | liste les éléments |
| « C'est fait » / « Reporte la visite à vendredi 11h » / « Supprime le RDV de jeudi » | clôture, reporte, supprime |

À l'échéance, un message « ⏰ Rappel » est envoyé (vérification toutes les 30 s ; si WhatsApp est
déconnecté, le rappel part dès la reconnexion). Un résumé quotidien est envoyé à `DAILY_BRIEFING_TIME`.

## Sécurité

- **Liste blanche stricte** : seul `ALLOWED_PHONE_NUMBER` est traité. Les autres expéditeurs, les groupes,
  les statuts et les canaux sont ignorés sans réponse (`backend/src/webhook.js`).
- **Webhooks signés** : chaque livraison OpenWA porte `X-OpenWA-Signature: sha256=<hmac>` calculé sur le corps
  brut ; le backend vérifie en temps constant et rejette (401) toute requête non signée.
- **Rien n'est exposé sur le réseau** : les ports sont liés à `127.0.0.1`, le backend n'est joignable que par
  le réseau Docker interne, et `/webhooks` n'est pas relayé par nginx.
- Le dashboard n'a pas de mot de passe : ne le publiez pas sur Internet sans reverse proxy authentifié.
- `.env` contient vos secrets et n'est pas versionné.

## Configuration (`.env`)

Voir `.env.example`, entièrement commenté. Principaux réglages : `ALLOWED_PHONE_NUMBER`, `TIMEZONE`,
`LLM_PROVIDER` (`groq` | `openai` | `anthropic`) et la clé correspondante. Avec `anthropic`, ajoutez une clé
Groq ou OpenAI pour la transcription des notes vocales. `LLM_BASE_URL` permet d'utiliser un serveur
compatible OpenAI local (Ollama, etc.).

### Synchronisation Google (optionnelle)

Les RDV vont dans Google Calendar, les autres catégories dans Google Tasks.

1. Dans Google Cloud Console : activez les API *Google Calendar* et *Google Tasks*, créez un identifiant
   OAuth de type « Application de bureau ».
2. Obtenez le jeton de rafraîchissement :
   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node backend/scripts/google-auth.mjs
   ```
3. Reportez `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `GOOGLE_REFRESH_TOKEN` dans `.env`, puis
   `docker compose up -d`.

## Commandes utiles

```bash
docker compose logs -f backend
```

```bash
docker compose down
```

Les données vivent dans deux volumes Docker : `assistant-data` (SQLite) et `openwa-data` (session
WhatsApp). `docker compose down -v` les efface.
