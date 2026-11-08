#!/usr/bin/env bash
# PodoCRM aktualisieren – ein Befehl für beide Installationsarten (install.sh / install-subdomain.sh).
#
#   bash /opt/podo-crm/deploy/update.sh               # auf origin/main aktualisieren
#   bash /opt/podo-crm/deploy/update.sh v1.4.0        # auf einen Tag, Branch oder Commit
#   bash /opt/podo-crm/deploy/update.sh --dry-run     # nur anzeigen, was passieren würde
#
# Ablauf: Modus erkennen → git fetch → Datenbank-Sicherung (verschlüsselt, wie der backup-Dienst)
#   → neuen Stand auschecken → Images bauen (alte Version läuft weiter) → Container neu starten
#   (migrate spielt Migrationen ein) → auf /api/health warten.
# Schlägt Build, Start oder Health-Check fehl: zurück auf den vorherigen Commit, neu bauen/starten
#   und Hinweis, wie die Datenbank-Sicherung von vorher eingespielt wird.
# Mehrfach ausführbar (idempotent): ist der Stand schon aktuell, werden nur die Container abgeglichen.
#
# Optionen:
#   --ref REF        Ziel (Branch, Tag oder Commit), Standard: main (auch als erstes Argument möglich)
#   --dry-run        nichts ändern (git fetch wird ausgeführt, um das Ziel anzuzeigen)
#   --skip-backup    keine Datenbank-Sicherung vorher (nicht empfohlen)
#   --force          lokale Änderungen an versionierten Dateien ignorieren (werden überschrieben!)
#   --timeout SEK    Wartezeit auf /api/health (Standard 240)
set -euo pipefail

# Das ganze Skript steckt in main(): Bash liest es so vollständig ein, bevor git checkout
# diese Datei durch eine neuere Version ersetzt.
main() {
  # shellcheck source=deploy/lib.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

  local REF=main DRY_RUN=0 SKIP_BACKUP=0 FORCE=0 TIMEOUT=240
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) REF="${2:?--ref braucht einen Wert}"; shift 2 ;;
      --ref=*) REF="${1#--ref=}"; shift ;;
      --dry-run|-n) DRY_RUN=1; shift ;;
      --skip-backup) SKIP_BACKUP=1; shift ;;
      --force) FORCE=1; shift ;;
      --timeout) TIMEOUT="${2:?--timeout braucht einen Wert}"; shift 2 ;;
      -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      -*) die "Unbekannte Option: $1 (siehe --help)" ;;
      *) REF="$1"; shift ;;
    esac
  done
  [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout muss eine Zahl (Sekunden) sein."

  podo_detect
  cd "$APP_DIR"
  run() { # führt aus oder zeigt im Probelauf nur an
    if [ "$DRY_RUN" = 1 ]; then printf '  [Probelauf] %s\n' "$*"; else "$@"; fi
  }

  say "PodoCRM-Update ($([ "$DRY_RUN" = 1 ] && echo 'PROBELAUF – es wird nichts geändert' || echo "Ziel: $REF"))"
  info "Verzeichnis:  $APP_DIR"
  info "Modus:        $PODO_MODE $([ "$PODO_MODE" = subdomain ] && echo '(hinter vorhandenem Caddy, ohne eigenen caddy-Dienst)' || echo '(eigener Caddy für HTTPS)')"
  info "Dienste:      ${SERVICES[*]}"

  command -v git >/dev/null || die "git fehlt."
  [ -d "$APP_DIR/.git" ] || die "$APP_DIR ist kein git-Checkout."
  require_docker

  # Nur ein Update gleichzeitig. Sperrdatei im (root-eigenen) Installationsverzeichnis statt im allgemein
  # beschreibbaren /tmp (kein Symlink-/Vorab-Anlegen durch andere lokale Nutzer); vorhandener Symlink → Abbruch.
  if command -v flock >/dev/null; then
    local LOCK="$APP_DIR/deploy/.update.lock"
    [ -L "$LOCK" ] && die "Sperrdatei $LOCK ist ein Symlink – Abbruch."
    exec 9>>"$LOCK"
    flock -n 9 || die "Es läuft bereits ein Update (Sperre $LOCK)."
  fi
  # Seit Phase 5: eigenes HEALTH_TOKEN für /api/health/deep (kein Rückgriff mehr auf CRON_SECRET)
  if [ "$DRY_RUN" != 1 ] && ! grep -q '^HEALTH_TOKEN=.\{16,\}' "$ENV_FILE"; then
    sed -i '/^HEALTH_TOKEN=/d' "$ENV_FILE"
    echo "HEALTH_TOKEN=$(openssl rand -base64 32 | tr -d '\n/+=' | cut -c1-40)" >> "$ENV_FILE"
    warn "HEALTH_TOKEN neu erzeugt (deploy/.env) – im Monitoring (Uptime Kuma o. Ä.) eintragen."
  fi

  # ── 1. Stand prüfen und Ziel ermitteln ─────────────────────────────────────
  say "1/6 Code-Stand prüfen"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    if [ "$FORCE" = 1 ]; then
      warn "Lokale Änderungen an versionierten Dateien werden überschrieben (--force)."
    else
      die "Lokale Änderungen an versionierten Dateien (siehe oben). Sichern oder mit --force überschreiben."
    fi
  fi
  local PREV PREV_BRANCH TARGET TARGET_KIND
  PREV=$(git rev-parse HEAD)
  PREV_BRANCH=$(git symbolic-ref -q --short HEAD || true)
  info "Aktuell: $(git log -1 --format='%h %s (%cd)' --date=short)"
  git fetch -q --tags --force origin || die "git fetch fehlgeschlagen (Netzwerk/Zugang zum Repository?)."
  if git rev-parse -q --verify "refs/remotes/origin/$REF^{commit}" >/dev/null; then
    TARGET=$(git rev-parse "refs/remotes/origin/$REF^{commit}"); TARGET_KIND=branch
  elif git rev-parse -q --verify "refs/tags/$REF^{commit}" >/dev/null; then
    TARGET=$(git rev-parse "refs/tags/$REF^{commit}"); TARGET_KIND=tag
  elif git rev-parse -q --verify "$REF^{commit}" >/dev/null; then
    TARGET=$(git rev-parse "$REF^{commit}"); TARGET_KIND=commit
  else
    die "Ziel '$REF' nicht gefunden (weder Branch auf origin noch Tag noch Commit)."
  fi
  info "Ziel:    $(git log -1 --format='%h %s (%cd)' --date=short "$TARGET") [$TARGET_KIND $REF]"

  local SAME=0
  if [ "$TARGET" = "$PREV" ]; then
    SAME=1
    info "Bereits auf diesem Stand – Container werden nur abgeglichen."
  else
    local n; n=$(git rev-list --count "$PREV..$TARGET" 2>/dev/null || echo "?")
    info "Neue Commits: $n"
    git log --oneline --no-decorate -n 15 "$PREV..$TARGET" 2>/dev/null | sed 's/^/    /' || true
    if ! git merge-base --is-ancestor "$PREV" "$TARGET" 2>/dev/null; then
      warn "Das Ziel ist kein Nachfolger des aktuellen Stands (Downgrade/anderer Zweig). Neuere Datenbank-Migrationen werden NICHT zurückgenommen."
    fi
  fi

  # ── 2. Datenbank-Sicherung ────────────────────────────────────────────────
  say "2/6 Datenbank sichern (verschlüsselt)"
  local BACKUP_FILE=""
  if [ "$SKIP_BACKUP" = 1 ]; then
    warn "Übersprungen (--skip-backup)."
  elif [ "$SAME" = 1 ]; then
    info "Nicht nötig – kein neuer Code, also keine neuen Migrationen."
  elif [ "$DRY_RUN" = 1 ]; then
    run "${COMPOSE[@]}" exec -T backup sh -c '<deploy/backup.sh>' backup.sh pre-update
  else
    "${COMPOSE[@]}" up -d db backup >/dev/null
    local i
    for i in $(seq 1 24); do # gnupg wird beim Start des backup-Containers installiert
      "${COMPOSE[@]}" exec -T backup sh -c 'command -v gpg >/dev/null && pg_isready -q -h db -U podo_owner' 2>/dev/null && break
      [ "$i" = 24 ] && die "backup-Container nicht bereit (gpg/Datenbank). Update abgebrochen, nichts geändert."
      sleep 5
    done
    # Aktuelle backup.sh vom Host direkt ausführen (die eingebundene Datei im Container kann veraltet sein)
    local out
    out=$("${COMPOSE[@]}" exec -T backup sh -c "$(cat "$APP_DIR/deploy/backup.sh")" backup.sh pre-update) \
      || die "Datenbank-Sicherung fehlgeschlagen. Update abgebrochen, nichts geändert."
    BACKUP_FILE=$(printf '%s\n' "$out" | sed -n 's/^BACKUP_FILE=//p' | tail -n1)
    [ -n "$BACKUP_FILE" ] || die "Datenbank-Sicherung: Dateiname nicht erkannt. Update abgebrochen."
    info "Gesichert: $BACKUP_FILE (im Volume \"backups\")"
  fi

  # ── 3. Neuen Stand auschecken ─────────────────────────────────────────────
  say "3/6 Code auschecken"
  if [ "$TARGET_KIND" = branch ]; then
    run git checkout -q -B "$REF" "$TARGET"
  else
    run git checkout -q --detach "$TARGET"
  fi

  rollback_code() {
    if [ -n "$PREV_BRANCH" ]; then
      git checkout -q -B "$PREV_BRANCH" "$PREV"
    else
      git checkout -q --detach "$PREV"
    fi
  }

  # ── 4. Bauen (alte Container laufen weiter) ───────────────────────────────
  say "4/6 Images bauen (die laufende Version bleibt so lange online)"
  if [ "$DRY_RUN" = 1 ]; then
    run "${COMPOSE[@]}" build migrate app
  elif ! "${COMPOSE[@]}" build migrate app; then
    rollback_code
    die "Build fehlgeschlagen. Code zurück auf $(git rev-parse --short HEAD); die bisherige Version läuft unverändert weiter."
  fi

  # ── 5. Starten ────────────────────────────────────────────────────────────
  say "5/6 Container neu starten (migrate spielt neue Migrationen ein)"
  if [ "$PODO_MODE" = subdomain ]; then
    # falls jemals versehentlich gestartet: eigener Caddy würde 80/443 des vorhandenen Webservers blockieren
    run "${COMPOSE[@]}" rm -sf caddy
  fi
  local started=1
  if [ "$DRY_RUN" = 1 ]; then
    run "${COMPOSE[@]}" up -d "${SERVICES[@]}"
    run "${COMPOSE[@]}" up -d --force-recreate --no-deps backup cron
  else
    "${COMPOSE[@]}" up -d "${SERVICES[@]}" || started=0
    # backup/cron neu erstellen: eingebundene Skripte (backup.sh) sonst evtl. noch alte Fassung
    [ "$started" = 1 ] && { "${COMPOSE[@]}" up -d --force-recreate --no-deps backup cron >/dev/null || started=0; }
  fi

  # ── 6. Health-Check ───────────────────────────────────────────────────────
  say "6/6 Auf /api/health warten (max. ${TIMEOUT}s)"
  if [ "$DRY_RUN" = 1 ]; then
    info "[Probelauf] würde warten, bis /api/health antwortet."
    say "Probelauf beendet – nichts geändert."
    return 0
  fi
  if [ "$started" = 1 ] && wait_healthy "$TIMEOUT"; then
    "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || true
    say "Update erfolgreich: $(git log -1 --format='%h %s')"
    [ -n "$BACKUP_FILE" ] && info "Sicherung von vorher: $BACKUP_FILE"
    return 0
  fi

  # ── Fehlerfall: Rollback ──────────────────────────────────────────────────
  warn "Neue Version ist nicht gesund geworden. Letzte Log-Zeilen:"
  "${COMPOSE[@]}" logs --tail 40 migrate app 2>&1 | sed 's/^/    /' || true
  if [ "$SAME" = 1 ]; then
    die "Die App startet auch ohne Code-Änderung nicht. Logs prüfen: ${COMPOSE[*]} logs app"
  fi
  say "Rollback auf $(git log -1 --format='%h %s' "$PREV")"
  rollback_code
  local rb_ok=0
  if "${COMPOSE[@]}" up -d --build "${SERVICES[@]}" && "${COMPOSE[@]}" up -d --force-recreate --no-deps backup cron >/dev/null && wait_healthy "$TIMEOUT"; then
    rb_ok=1
  fi
  echo
  if [ "$rb_ok" = 1 ]; then
    warn "Die vorherige Version läuft wieder."
  else
    warn "Auch die vorherige Version wird nicht gesund – vermutlich passt sie nicht zur bereits migrierten Datenbank."
  fi
  cat >&2 <<HINT

  Falls die neue Version Datenbank-Migrationen eingespielt hat, passt das Schema evtl. nicht mehr
  zur alten Version. Dann die Sicherung von vor dem Update einspielen:

    bash $APP_DIR/deploy/restore.sh --db ${BACKUP_FILE:-<db-preupdate-…dump.gpg>}

  (stoppt App und Cron, ersetzt die Datenbank durch die Sicherung, startet wieder; Daten, die
  seit der Sicherung eingegeben wurden, gehen dabei verloren). Vorhandene Sicherungen:

    ${COMPOSE[*]} exec backup ls -lt /backups

HINT
  exit 1
}

main "$@"
exit 0
