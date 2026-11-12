#!/usr/bin/env bash
# Prépare .env (secrets générés automatiquement) puis démarre la stack.
set -euo pipefail
cd "$(dirname "$0")"

gen() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
setvar() { # setvar NOM VALEUR : remplace la ligne NOM=... dans .env
  local tmp; tmp=$(mktemp)
  awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp" && cat "$tmp" > .env && rm -f "$tmp"
}
getvar() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "✔ .env créé à partir de .env.example"
fi
[ -n "$(getvar OPENWA_API_KEY)" ] || { setvar OPENWA_API_KEY "$(gen)"; echo "✔ Clé API admin OpenWA générée"; }
[ -n "$(getvar WEBHOOK_SECRET)" ] || { setvar WEBHOOK_SECRET "$(gen)"; echo "✔ Secret HMAC des webhooks généré"; }

if [ -z "$(getvar ALLOWED_PHONE_NUMBER)" ]; then
  read -r -p "Votre numéro WhatsApp autorisé (format international sans +, ex. 33612345678) : " phone
  phone=$(printf '%s' "$phone" | tr -cd '0-9')
  [ ${#phone} -ge 8 ] || { echo "Numéro invalide."; exit 1; }
  setvar ALLOWED_PHONE_NUMBER "$phone"
fi

provider=$(getvar LLM_PROVIDER)
case "$provider" in
  groq) key=GROQ_API_KEY ;; openai) key=OPENAI_API_KEY ;; anthropic) key=ANTHROPIC_API_KEY ;; *) key="" ;;
esac
if [ -n "$key" ] && [ -z "$(getvar "$key")" ] && [ -z "$(getvar LLM_BASE_URL)" ]; then
  echo "⚠  $key est vide dans .env : l'assistant démarrera, mais ne comprendra pas vos messages"
  echo "   tant que la clé n'est pas renseignée (puis : docker compose up -d)."
fi

if [ "${1:-}" != "--no-start" ]; then
  docker compose up -d --build
  echo
  echo "Dashboard        : http://localhost:3000   (onglet « Connexion WhatsApp » pour le QR code)"
  echo "OpenWA (natif)   : http://localhost:2785   (clé API : valeur de OPENWA_API_KEY dans .env)"
fi
