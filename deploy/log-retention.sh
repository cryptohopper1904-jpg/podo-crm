#!/usr/bin/env bash
# Container-Logs (app, caddy, cron …) höchstens 7 Tage aufbewahren – so steht es in den Datenschutzhinweisen der
# Praxis-Websites und Buchungsseiten („Protokolldaten werden nach 7 Tagen gelöscht“, src/app/p/[slug]/_site/legal-content.tsx).
# Docker selbst rotiert nur nach Größe (docker-compose.yml: x-logging, Obergrenze je Container); die zeitliche Grenze
# setzt logrotate: täglich rotieren, 6 alte Tage behalten → älteste Zeile höchstens 7 Tage alt.
# Aufruf (als root, idempotent): install.sh, install-subdomain.sh und update.sh rufen es selbst auf.
set -euo pipefail
CONF=/etc/logrotate.d/podohero-docker
if [ ! -d /etc/logrotate.d ]; then
  echo "WARNUNG: logrotate fehlt (apt-get install -y logrotate) – Container-Logs werden nur nach Größe begrenzt." >&2
  exit 0
fi
cat > "$CONF.tmp" <<'ROT'
# verwaltet von PodoHero (deploy/log-retention.sh) – Änderungen werden beim nächsten Update überschrieben
/var/lib/docker/containers/*/*-json.log {
  daily
  rotate 6
  maxage 7
  missingok
  notifempty
  copytruncate
  nocompress
  su root root
}
ROT
chmod 0644 "$CONF.tmp"
mv -f "$CONF.tmp" "$CONF"
command -v logrotate >/dev/null || echo "WARNUNG: logrotate ist nicht installiert (apt-get install -y logrotate)." >&2
