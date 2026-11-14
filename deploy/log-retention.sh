#!/usr/bin/env bash
# Container-Logs von PodoHero (app, caddy, cron …) höchstens 7 Tage aufbewahren – so steht es in den Datenschutzhinweisen
# der Praxis-Websites und Buchungsseiten („Protokolldaten werden nach 7 Tagen gelöscht“, src/app/p/[slug]/_site/legal-content.tsx).
# Docker selbst rotiert nur nach Größe (docker-compose.yml: x-logging, Obergrenze je Container); die zeitliche Grenze
# setzt logrotate: täglich rotieren, 6 alte Tage behalten → älteste Zeile höchstens 7 Tage alt.
#
# Nur die Container DIESER Installation (Compose-Label working_dir = Ordner dieses Skripts), nicht alle Container
# des Hosts; der Pfad kommt aus `docker info` (DockerRootDir, nicht fest /var/lib/docker). Container-IDs ändern sich
# beim Neuerstellen – deshalb rufen install.sh, install-subdomain.sh und update.sh das Skript NACH dem Start auf, und
# /etc/cron.daily/0podohero-log-retention erneuert die Liste täglich (auch nach einem manuellen `docker compose up`).
# Fehler bei `docker ps` oder keine Container gefunden: die bestehende Konfiguration bleibt unverändert (nur Warnung) –
# sonst stünde nach einem kurzen Docker-Aussetzer eine leere Liste in der Datei und die 7-Tage-Grenze fiele weg.
# Aufruf als root, idempotent. PODOHERO_LOGROTATE_CONF / PODOHERO_CRON_DAILY: nur für Tests (src/lib/log-retention.test.ts).
set -euo pipefail
CONF="${PODOHERO_LOGROTATE_CONF:-/etc/logrotate.d/podohero-docker}"
CRON_DAILY="${PODOHERO_CRON_DAILY:-/etc/cron.daily}"
[ "$(id -u)" = 0 ] || [ -n "${PODOHERO_LOGROTATE_CONF:-}" ] || { echo "Bitte als root ausführen (sudo -i)." >&2; exit 1; }
# physischer Pfad (Symlinks aufgelöst) – ebenso beim Label der Container (unten), damit beide Seiten vergleichbar sind
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ ! -d "$(dirname "$CONF")" ]; then
  echo "WARNUNG: logrotate fehlt (apt-get install -y logrotate) – Container-Logs werden nur nach Größe begrenzt." >&2
  exit 0
fi
command -v docker >/dev/null || { echo "WARNUNG: docker nicht gefunden – Log-Aufbewahrung nicht eingerichtet." >&2; exit 0; }
ROOT="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$ROOT" ] || { echo "WARNUNG: Docker-Verzeichnis nicht ermittelbar (docker info) – Log-Aufbewahrung nicht eingerichtet." >&2; exit 0; }
# Compose setzt dieses Label auf den Ordner der ersten Compose-Datei (deploy/docker-compose.yml) – also diesen Ordner.
# Erst alle Compose-Container holen (Fehler → Konfiguration bleibt), dann das Label je Container mit pwd -P auflösen.
LABEL=com.docker.compose.project.working_dir
if ! ALL="$(docker ps -aq --no-trunc --filter "label=$LABEL")"; then
  echo "WARNUNG: docker ps fehlgeschlagen – bestehende Log-Aufbewahrung ($CONF) bleibt unverändert." >&2
  exit 0
fi
IDS=()
for id in $ALL; do
  [[ "$id" =~ ^[0-9a-f]{64}$ ]] || continue
  wd="$(docker inspect -f "{{ index .Config.Labels \"$LABEL\" }}" "$id" 2>/dev/null)" || continue
  [ -n "$wd" ] || continue
  real="$(cd "$wd" 2>/dev/null && pwd -P)" || continue
  [ "$real" = "$DIR" ] && IDS+=("$id")
done
if [ "${#IDS[@]}" -eq 0 ]; then
  echo "WARNUNG: keine PodoHero-Container gefunden – bestehende Log-Aufbewahrung ($CONF) bleibt unverändert; nach dem Start erneut ausführen." >&2
else
{
  echo "# verwaltet von PodoHero (deploy/log-retention.sh) – Änderungen werden beim nächsten Lauf überschrieben"
  echo "# nur Container der Installation in $DIR ($(date -Iseconds))"
  paths=""
  for id in "${IDS[@]}"; do paths+="\"$ROOT/containers/$id/$id-json.log\" "; done
  echo "$paths{"
  cat <<'ROT'
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
} > "$CONF.tmp"
chmod 0644 "$CONF.tmp"
mv -f "$CONF.tmp" "$CONF"
fi

# Tägliche Erneuerung der Container-Liste (läuft unter run-parts vor „logrotate“; bei systemd-Timer spätestens am Folgetag)
CRON="$CRON_DAILY/0podohero-log-retention"
if [ -d "$CRON_DAILY" ]; then
  printf '#!/bin/sh\n# verwaltet von PodoHero (deploy/log-retention.sh)\n[ -f %q ] && bash %q >/dev/null 2>&1 || true\n' "$DIR/log-retention.sh" "$DIR/log-retention.sh" > "$CRON.tmp"
  chmod 0755 "$CRON.tmp"
  mv -f "$CRON.tmp" "$CRON"
fi
command -v logrotate >/dev/null || echo "WARNUNG: logrotate ist nicht installiert (apt-get install -y logrotate)." >&2
