#!/usr/bin/env bash
# PodoCRM – Erstinstallation auf Ubuntu/Debian (als root).
# Aufruf: bash deploy/install.sh <DOMAIN-oder-IP>
set -euo pipefail
TARGET="${1:?Domain oder IP angeben}"
APP_DIR=/opt/podo-crm
cd "$APP_DIR"

# Läuft auf diesem Server schon ein anderer Webserver (Ports 80/443)? Dann nichts kaputt machen.
if command -v ss >/dev/null && ss -tlnp | grep -E ':(80|443)\s' | grep -qv docker; then
  echo "ABBRUCH: Port 80/443 ist schon belegt (anderes Projekt). Nichts geändert."
  ss -tlnp | grep -E ':(80|443)\s'
  exit 2
fi

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Firewall: nur SSH, HTTP, HTTPS
if command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

ENV=deploy/.env
if [ ! -f "$ENV" ]; then
  rnd() { openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40; }
  if [[ "$TARGET" =~ ^[0-9.]+$ ]]; then CADDYFILE=Caddyfile.ip; else CADDYFILE=Caddyfile; fi
  cat > "$ENV" <<CONF
DOMAIN=$TARGET
CADDYFILE=$CADDYFILE
PUBLIC_URL=https://$TARGET
DB_OWNER_PASSWORD=$(rnd)
DB_APP_PASSWORD=$(rnd)
BACKUP_PASSPHRASE=$(rnd)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
SETUP_TOKEN=$(rnd | cut -c1-16)
ALLOW_SIGNUP=false
INTEGRATIONS_MODE=mock
SEED_DEMO=$([[ "$TARGET" =~ ^[0-9.]+$ ]] && echo true || echo false)
LLM_DATA_PROCESSING_APPROVED=false
TRANSCRIPTION_DATA_PROCESSING_APPROVED=false
CONF
  chmod 600 "$ENV"
fi

docker compose -f deploy/docker-compose.yml --env-file "$ENV" up -d --build
echo
echo "PodoCRM läuft: https://$TARGET"
if grep -q "^SEED_DEMO=true" "$ENV"; then echo "Demo-Login: demo@podocrm.local / demo-passwort-123"; fi
echo "Eigene Praxis anlegen: https://$TARGET/einrichtung  ·  Einrichtungs-Code: $(grep ^SETUP_TOKEN "$ENV" | cut -d= -f2)"
