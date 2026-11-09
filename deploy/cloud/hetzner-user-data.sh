#!/bin/bash
# PodoHero – automatische Erstinstallation auf einem frischen Cloud-Server (Hetzner/Hostinger, Ubuntu 24.04) – als cloud-init user_data.
# Kein Shell-Zugang nötig:
#   - Plattform-Admin und optional eine Praxis werden beim ersten Start aus BOOTSTRAP_* angelegt
#     (scripts/bootstrap.ts im migrate-Container, idempotent; 2FA beim ersten Login unter /login/2fa-einrichten)
#   - automatische Updates: systemd-Timer podo-update.timer (täglich 03:30 Europe/Berlin + 10 min nach dem Booten,
#     deploy/update.sh --auto gegen main, Protokoll /var/log/podo-update.log)
#
# Konfiguration: die Werte unten im Block „KONFIGURATION“ vor dem Einfügen als user_data ausfüllen
# (oder als Umgebungsvariablen setzen). Leere BOOTSTRAP_*-Werte = nichts anlegen.
# Ohne BOOTSTRAP_PRACTICE_JSON: Testbetrieb mit Demo-Praxis (erfundene Daten, keine echten Patientendaten).
# Passwörter landen nur in /opt/podo-crm/deploy/.env (chmod 600) – nach dem ersten Login dort entfernen.
set -euo pipefail
exec > >(tee -a /root/podo-install.log) 2>&1

# ───────────── KONFIGURATION ─────────────
DOMAIN="${PODO_DOMAIN:-podo.algoverdict.com}"
REPO_URL="${PODO_REPO_URL:-https://github.com/cryptohopper1904-jpg/podo-crm.git}"
PODO_AUTO_UPDATE="${PODO_AUTO_UPDATE:-true}"
BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-}"
BOOTSTRAP_ADMIN_NAME="${BOOTSTRAP_ADMIN_NAME:-}"
BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-}"
# Pfad im Repository (z. B. deploy/bootstrap/kiehne.json) oder JSON-Text in einer Zeile
BOOTSTRAP_PRACTICE_JSON="${BOOTSTRAP_PRACTICE_JSON:-}"
BOOTSTRAP_PRACTICE_OWNER_PASSWORD="${BOOTSTRAP_PRACTICE_OWNER_PASSWORD:-}"
# E-Mail-Versand (z. B. Resend: smtps://resend:<API-KEY>@smtp.resend.com:465) und Absender
SMTP_URL="${SMTP_URL:-}"
SMTP_FROM="${SMTP_FROM:-}"
# ─────────────────────────────────────────

APP_DIR=/opt/podo-crm
export DEBIAN_FRONTEND=noninteractive
# 2 GB Swap als Reserve für den Build auf kleinen Servern (4 GB RAM)
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab; fi
apt-get update -qq && apt-get install -y -qq git curl openssl ufw >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
timedatectl set-timezone Europe/Berlin 2>/dev/null || true
[ -d "$APP_DIR/.git" ] || git clone -q "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
ENV=deploy/.env
# Mit echter Praxis keine Demo-Daten
if [ -n "$BOOTSTRAP_PRACTICE_JSON" ]; then SEED_DEMO=false; else SEED_DEMO=true; fi
if [ ! -f "$ENV" ]; then
  rnd() { openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40; }
  umask 077
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
SEED_DEMO=$SEED_DEMO
TRUSTED_PROXY_HOPS=1
LLM_DATA_PROCESSING_APPROVED=false
TRANSCRIPTION_DATA_PROCESSING_APPROVED=false
CONF
  chmod 600 "$ENV"
fi

# BOOTSTRAP_* in deploy/.env übernehmen (nur gesetzte Werte; vorhandene Einträge werden ersetzt).
# docker compose liest .env ohne Shell-Auswertung – Werte mit Zeilenumbruch sind nicht erlaubt.
set_env() {
  local key="$1" val="$2"
  [ -n "$val" ] || return 0
  case "$val" in *$'\n'*) echo "WARNUNG: $key enthält einen Zeilenumbruch – übersprungen." >&2; return 0 ;; esac
  local tmp; tmp=$(mktemp "$APP_DIR/deploy/.env.XXXXXX")
  grep -v "^$key=" "$ENV" > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  chmod 600 "$tmp" && mv "$tmp" "$ENV"
}
set_env BOOTSTRAP_ADMIN_EMAIL "$BOOTSTRAP_ADMIN_EMAIL"
set_env BOOTSTRAP_ADMIN_NAME "$BOOTSTRAP_ADMIN_NAME"
set_env BOOTSTRAP_ADMIN_PASSWORD "$BOOTSTRAP_ADMIN_PASSWORD"
set_env BOOTSTRAP_PRACTICE_JSON "$BOOTSTRAP_PRACTICE_JSON"
set_env BOOTSTRAP_PRACTICE_OWNER_PASSWORD "$BOOTSTRAP_PRACTICE_OWNER_PASSWORD"
set_env SMTP_URL "$SMTP_URL"
set_env SMTP_FROM "$SMTP_FROM"

bash deploy/install.sh "$DOMAIN"

# Automatische Updates (ohne Shell): systemd-Timer → deploy/update.sh --auto --ref main
if [ "$PODO_AUTO_UPDATE" = true ]; then
  bash deploy/install-autoupdate.sh
fi
echo "PODO-INSTALL-FERTIG $(date -Iseconds)"
