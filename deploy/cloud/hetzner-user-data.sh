#!/bin/bash
# PodoCRM – automatische Erstinstallation auf einem frischen Cloud-Server (Hetzner/Hostinger, Ubuntu 24.04) – als cloud-init user_data
# Testbetrieb mit Demo-Praxis – keine echten Patientendaten.
set -euo pipefail
exec > >(tee -a /root/podo-install.log) 2>&1
DOMAIN="${PODO_DOMAIN:-podo.algoverdict.com}"
APP_DIR=/opt/podo-crm
export DEBIAN_FRONTEND=noninteractive
# 2 GB Swap als Reserve für den Build auf kleinen Servern (4 GB RAM)
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab; fi
apt-get update -qq && apt-get install -y -qq git curl openssl ufw >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
[ -d "$APP_DIR/.git" ] || git clone -q https://github.com/cryptohopper1904-jpg/podo-crm.git "$APP_DIR"
cd "$APP_DIR"
ENV=deploy/.env
if [ ! -f "$ENV" ]; then
  rnd() { openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40; }
  cat > "$ENV" <<CONF
DOMAIN=$DOMAIN
CADDYFILE=Caddyfile
PUBLIC_URL=https://$DOMAIN
DB_OWNER_PASSWORD=$(rnd)
DB_APP_PASSWORD=$(rnd)
BACKUP_PASSPHRASE=$(rnd)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
SETUP_TOKEN=$(rnd | cut -c1-16)
CRON_SECRET=$(rnd)
HEALTH_TOKEN=$(rnd)
ALLOW_SIGNUP=false
INTEGRATIONS_MODE=mock
SEED_DEMO=true
TRUSTED_PROXY_HOPS=1
LLM_DATA_PROCESSING_APPROVED=false
TRANSCRIPTION_DATA_PROCESSING_APPROVED=false
CONF
  chmod 600 "$ENV"
fi
bash deploy/install.sh "$DOMAIN"
echo "PODO-INSTALL-FERTIG $(date -Iseconds)"
