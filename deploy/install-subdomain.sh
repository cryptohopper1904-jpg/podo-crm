#!/usr/bin/env bash
# PodoCRM auf einem Server installieren, auf dem schon ein anderer Webserver (Caddy) läuft,
# z. B. neben hub.algoverdict.com. PodoCRM bekommt eine eigene Subdomain; der vorhandene Caddy
# leitet sie weiter und holt automatisch ein echtes HTTPS-Zertifikat.
#
# Aufruf (als root):
#   curl -fsSL https://raw.githubusercontent.com/cryptohopper1904-jpg/podo-crm/main/deploy/install-subdomain.sh | bash -s podo.algoverdict.com
#
# Voraussetzung: DNS-A-Eintrag der Subdomain zeigt auf diesen Server.
# Testbetrieb: Demo-Praxis wird angelegt – KEINE echten Patientendaten eingeben.
set -euo pipefail
DOMAIN="${1:?Subdomain angeben, z. B. podo.algoverdict.com}"
REF="${PODO_REF:-main}"
APP_DIR=/opt/podo-crm
PORT="${PODO_PORT:-3010}"
REPO=https://github.com/cryptohopper1904-jpg/podo-crm.git
MARK="# podo-crm:$DOMAIN"

say() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Bitte als root ausführen (sudo -i)."

say "1/6 Voraussetzungen"
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker >/dev/null 2>&1 || true

say "2/6 DNS prüfen ($DOMAIN)"
MYIP=$(curl -fsS -4 -m 10 https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
if [ -n "$MYIP" ] && [ "$DNSIP" != "$MYIP" ]; then
  echo "Achtung: $DOMAIN zeigt auf '${DNSIP:-nichts}', dieser Server ist $MYIP."
  echo "Ohne passenden DNS-Eintrag kann kein HTTPS-Zertifikat geholt werden. Es geht trotzdem weiter."
fi

say "3/6 Code holen ($REF)"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$REF" && git -C "$APP_DIR" checkout -q -B "$REF" "origin/$REF"
else
  git clone -q --branch "$REF" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

say "4/6 Vorhandenen Webserver erkennen"
CADDY_KIND=""; CADDY_ID=""; CADDYFILE=""; BIND=127.0.0.1; UPSTREAM=127.0.0.1
if systemctl is-active --quiet caddy 2>/dev/null; then
  CADDY_KIND=systemd; CADDYFILE=/etc/caddy/Caddyfile
else
  CADDY_ID=$(docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1; exit}')
  if [ -n "$CADDY_ID" ]; then
    CADDY_KIND=docker
    SRC=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY_ID")
    [ -z "$SRC" ] && SRC=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}/Caddyfile{{end}}{{end}}' "$CADDY_ID")
    CADDYFILE="$SRC"
    if [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CADDY_ID")" != host ]; then
      BIND=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'); UPSTREAM=$BIND
    fi
  fi
fi
[ -n "$CADDY_KIND" ] || die "Kein laufender Caddy gefunden. Für einen Server ohne anderen Webserver: bash deploy/install.sh $DOMAIN"
[ -n "$CADDYFILE" ] && [ -f "$CADDYFILE" ] || die "Caddyfile des vorhandenen Caddy nicht gefunden ($CADDY_KIND). Nichts geändert."
echo "Gefunden: Caddy ($CADDY_KIND), Konfiguration $CADDYFILE"
if ss -tln 2>/dev/null | grep -q "[:.]$PORT\s" && ! docker ps --format '{{.Names}}' | grep -q '^podo-app'; then
  die "Port $PORT ist belegt. Anderen Port wählen: PODO_PORT=3011 bash … $DOMAIN"
fi

say "5/6 PodoCRM starten"
ENV=deploy/.env
rnd() { openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40; }
if [ ! -f "$ENV" ]; then
  cat > "$ENV" <<CONF
DOMAIN=$DOMAIN
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
else
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ENV"
  grep -q '^CRON_SECRET=' "$ENV" || echo "CRON_SECRET=$(rnd)" >> "$ENV"
  grep -q '^HEALTH_TOKEN=.\{16,\}' "$ENV" || { sed -i '/^HEALTH_TOKEN=/d' "$ENV"; echo "HEALTH_TOKEN=$(rnd)" >> "$ENV"; }
fi
cat > deploy/docker-compose.subdomain.yml <<YML
# erzeugt von install-subdomain.sh – App nur lokal erreichbar, der vorhandene Caddy leitet weiter
services:
  app:
    container_name: podo-app
    ports: ["$BIND:$PORT:3000"]
YML
COMPOSE=(docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.subdomain.yml --env-file "$ENV")
"${COMPOSE[@]}" rm -sf caddy >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build db migrate app backup cron

say "6/6 Weiterleitung im vorhandenen Caddy eintragen"
if ! grep -qF "$MARK" "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
  cat >> "$CADDYFILE" <<CADDY

$MARK
$DOMAIN {
	encode zstd gzip
	reverse_proxy $UPSTREAM:$PORT
}
CADDY
fi
if [ "$CADDY_KIND" = systemd ]; then
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null && systemctl reload caddy
else
  docker exec "$CADDY_ID" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
    && docker exec "$CADDY_ID" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
fi

echo
for _ in $(seq 1 30); do curl -fsS -m 5 "http://$UPSTREAM:$PORT/api/health" >/dev/null 2>&1 && break; sleep 5; done
say "Fertig: https://$DOMAIN"
echo "Demo-Login: demo@podocrm.local / demo-passwort-123   (Testbetrieb – keine echten Patientendaten)"
if [ "$REF" = main ]; then
  echo "Update später:  bash $APP_DIR/deploy/update.sh            (Probelauf: --dry-run)"
else
  echo "Update später:  bash $APP_DIR/deploy/update.sh $REF       (Probelauf: --dry-run)"
fi
echo "Backup-Test:    bash $APP_DIR/deploy/restore-test.sh      (einmal im Quartal)"
