#!/usr/bin/env bash
# Richtet das automatische Update ein (systemd-Timer podo-update.timer, als root):
#   täglich 03:30 Europe/Berlin + 10 min nach dem Booten → deploy/update.sh --auto --ref main
#   Protokoll: /var/log/podo-update.log (logrotate wöchentlich, 8 Generationen)
# Aufruf: bash deploy/install-autoupdate.sh            (einrichten/aktualisieren, idempotent)
#         bash deploy/install-autoupdate.sh --remove   (wieder entfernen)
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system
[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd fehlt – automatisches Update nicht möglich." >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now podo-update.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/podo-update.service" "$UNIT_DIR/podo-update.timer" /etc/logrotate.d/podo-update
  systemctl daemon-reload
  echo "Automatisches Update entfernt."
  exit 0
fi

# Pfad in die Unit eintragen (Installationsverzeichnis kann abweichen)
sed "s#@APP_DIR@#$APP_DIR#g" "$APP_DIR/deploy/systemd/podo-update.service" > "$UNIT_DIR/podo-update.service"
install -m 0644 "$APP_DIR/deploy/systemd/podo-update.timer" "$UNIT_DIR/podo-update.timer"
chmod 0644 "$UNIT_DIR/podo-update.service"
touch /var/log/podo-update.log && chmod 0640 /var/log/podo-update.log
cat > /etc/logrotate.d/podo-update <<'ROT'
/var/log/podo-update.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
ROT
systemctl daemon-reload
systemctl enable --now podo-update.timer
echo "Automatisches Update eingerichtet: $(systemctl list-timers podo-update.timer --no-pager --no-legend 2>/dev/null | head -n1)"
