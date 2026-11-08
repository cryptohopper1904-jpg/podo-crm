# shellcheck shell=bash
# Gemeinsame Hilfsfunktionen für update.sh, restore.sh und restore-test.sh (wird per `source` geladen).
# Erkennt den Installationsmodus:
#   - standalone: eigener Caddy aus deploy/docker-compose.yml (install.sh)
#   - subdomain:  hinter einem vorhandenen Caddy, zusätzlich deploy/docker-compose.subdomain.yml
#                 (von install-subdomain.sh erzeugt, ohne den caddy-Dienst)

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\n\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# Setzt APP_DIR, ENV_FILE, PODO_MODE, COMPOSE (Array) und SERVICES (Array).
# shellcheck disable=SC2034  # Variablen werden von den aufrufenden Skripten genutzt
podo_detect() {
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ENV_FILE="$APP_DIR/deploy/.env"
  [ -f "$ENV_FILE" ] || die "deploy/.env fehlt ($ENV_FILE) – ist PodoCRM hier installiert?"
  # Projektname NICHT ändern: er ergibt sich aus dem Ordner der ersten Compose-Datei („deploy“);
  # ein anderer Name würde neue, leere Volumes (Datenbank!) anlegen.
  COMPOSE=(docker compose -f "$APP_DIR/deploy/docker-compose.yml")
  if [ -f "$APP_DIR/deploy/docker-compose.subdomain.yml" ]; then
    PODO_MODE=subdomain
    COMPOSE+=(-f "$APP_DIR/deploy/docker-compose.subdomain.yml")
    SERVICES=(db migrate app backup cron)
  else
    PODO_MODE=standalone
    SERVICES=(db migrate app caddy backup cron)
  fi
  COMPOSE+=(--env-file "$ENV_FILE")
}

# Wert aus deploy/.env lesen, ohne die Datei auszuführen.
env_value() {
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true
}

require_docker() {
  command -v docker >/dev/null || die "Docker ist nicht installiert."
  docker info >/dev/null 2>&1 || die "Docker läuft nicht oder keine Berechtigung (als root ausführen)."
  docker compose version >/dev/null 2>&1 || die "Docker Compose (Plugin) fehlt."
}

# App von innen prüfen (funktioniert in beiden Modi, auch ohne veröffentlichten Port).
app_healthy() {
  "${COMPOSE[@]}" exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

# Wartet bis zu $1 Sekunden auf /api/health.
wait_healthy() {
  local timeout="${1:-180}" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if app_healthy; then return 0; fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

backup_running() {
  [ -n "$("${COMPOSE[@]}" ps -q --status running backup 2>/dev/null)" ]
}

# Backup-Datei auflösen: vorhandene Host-Datei bleibt, sonst Name im Volume „backups“ (/backups/…).
backup_path() {
  if [ -f "$1" ]; then printf '%s\n' "$1"
  elif [[ "$1" == /backups/* ]]; then printf '%s\n' "$1"
  else printf '/backups/%s\n' "$(basename "$1")"
  fi
}

# Entschlüsselt ein Backup nach stdout – ohne Klartext auf der Festplatte.
# Quelle: Datei im backups-Volume (über den backup-Container) oder Host-Datei (z. B. aus dem Offsite-Speicher).
# shellcheck disable=SC2016  # $BACKUP_PASSPHRASE wird absichtlich erst im Container ausgewertet
decrypt_backup() {
  local src="$1"
  local gpg_in_container='gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$@" 3<<EOF
$BACKUP_PASSPHRASE
EOF'
  if [ -f "$src" ]; then
    if backup_running; then
      "${COMPOSE[@]}" exec -T backup sh -c "$gpg_in_container" sh < "$src"
    else
      command -v gpg >/dev/null || die "gpg fehlt auf dem Host (apt-get install gnupg) und der backup-Container läuft nicht."
      local pass="${BACKUP_PASSPHRASE:-$(env_value BACKUP_PASSPHRASE)}"
      [ -n "$pass" ] || die "BACKUP_PASSPHRASE weder in der Umgebung noch in deploy/.env gesetzt."
      gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$src" 3<<<"$pass"
    fi
  else
    backup_running || die "backup-Container läuft nicht – Datei $src im Volume nicht erreichbar."
    "${COMPOSE[@]}" exec -T backup sh -c "$gpg_in_container" sh "$src"
  fi
}

# Neuestes Datenbank-Backup im Volume (tägliche und Sicherungen vor Updates).
latest_db_backup() {
  "${COMPOSE[@]}" exec -T backup sh -c 'ls -1t /backups/db-*.dump.gpg 2>/dev/null | head -n1' | tr -d '\r'
}
latest_files_backup() {
  "${COMPOSE[@]}" exec -T backup sh -c 'ls -1t /backups/files-*.tar.gz.gpg 2>/dev/null | head -n1' | tr -d '\r'
}
