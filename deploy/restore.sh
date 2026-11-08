#!/usr/bin/env bash
# PodoCRM: Backup in die LAUFENDE Installation einspielen (Notfall / Rollback nach fehlgeschlagenem Update).
#
#   bash deploy/restore.sh --db db-20261108-0300.dump.gpg                 # nur Datenbank
#   bash deploy/restore.sh --db latest --files latest                     # neueste Sicherungen
#   bash deploy/restore.sh --db /root/offsite/db-….dump.gpg --files /root/offsite/files-….tar.gz.gpg
#
# Dateinamen ohne Pfad = Datei im Docker-Volume „backups“; vorhandene Host-Pfade werden direkt gelesen
# (z. B. nach dem Zurückholen aus dem Offsite-Speicher). Entschlüsselt wird mit BACKUP_PASSPHRASE.
#
# Ablauf Datenbank: aktuelle Datenbank zusätzlich sichern → in eine neue Datenbank „podo_restore_new“
#   einspielen → erst wenn das fehlerfrei geklappt hat, App/Cron stoppen und „podo“ ersetzen → starten.
#   Schlägt das Einspielen fehl, bleibt die bisherige Datenbank unverändert.
# Ablauf Dateien: Archiv prüfen (keine absoluten Pfade, kein „..“) und in ein LEERES Verzeichnis im storage-Volume
#   entpacken; erst danach wird umgeschaltet: der bisherige Bestand wandert vollständig nach
#   /data/storage/.pre-restore-<zeit>/ (Quarantäne, verschlüsselt wie zuvor), der wiederhergestellte Stand ersetzt ihn.
#   So bleiben keine Dateien ohne Datenbank-Bezug sichtbar liegen. Quarantäne nach Prüfung löschen (Hinweis am Ende).
#
# Optionen: --db DATEI|latest  --files DATEI|latest  --yes (ohne Rückfrage)  --dry-run
set -euo pipefail

main() {
  # shellcheck source=deploy/lib.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
  local DB="" FILES="" YES=0 DRY_RUN=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --db) DB="${2:?--db braucht eine Datei}"; shift 2 ;;
      --files) FILES="${2:?--files braucht eine Datei}"; shift 2 ;;
      --yes|-y) YES=1; shift ;;
      --dry-run|-n) DRY_RUN=1; shift ;;
      -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die "Unbekannte Option: $1 (siehe --help)" ;;
    esac
  done
  [ -n "$DB$FILES" ] || die "Nichts zu tun: --db und/oder --files angeben (siehe --help)."

  podo_detect
  cd "$APP_DIR"
  require_docker
  say "Wiederherstellung (Modus: $PODO_MODE)"
  "${COMPOSE[@]}" up -d db backup >/dev/null
  local i
  for i in $(seq 1 24); do
    "${COMPOSE[@]}" exec -T backup sh -c 'command -v gpg >/dev/null && pg_isready -q -h db -U podo_owner' 2>/dev/null && break
    [ "$i" = 24 ] && die "backup-Container/Datenbank nicht bereit."
    sleep 5
  done

  if [ "$DB" = latest ]; then DB=$(latest_db_backup); [ -n "$DB" ] || die "Kein Datenbank-Backup im Volume gefunden."; fi
  if [ "$FILES" = latest ]; then FILES=$(latest_files_backup); [ -n "$FILES" ] || die "Kein Datei-Backup im Volume gefunden."; fi
  [ -n "$DB" ] && DB=$(backup_path "$DB")
  [ -n "$FILES" ] && FILES=$(backup_path "$FILES")
  [ -n "$DB" ] && info "Datenbank: $DB"
  [ -n "$FILES" ] && info "Dateien:   $FILES"

  if [ "$DRY_RUN" = 1 ]; then
    say "Probelauf – nichts geändert."
    return 0
  fi
  if [ "$YES" != 1 ]; then
    echo
    warn "Alle Eingaben seit dem Zeitpunkt dieser Sicherung gehen verloren (Datenbank wird ERSETZT)."
    read -r -p "Zum Fortfahren WIEDERHERSTELLEN eintippen: " answer
    [ "$answer" = WIEDERHERSTELLEN ] || die "Abgebrochen, nichts geändert."
  fi

  if [ -n "$DB" ]; then
    say "1/3 Aktuellen Stand zusätzlich sichern"
    "${COMPOSE[@]}" exec -T backup sh -c "$(cat "$APP_DIR/deploy/backup.sh")" backup.sh pre-update | sed 's/^/  /'

    say "2/3 Sicherung in Hilfsdatenbank einspielen"
    local PSQL=("${COMPOSE[@]}" exec -T backup psql -v ON_ERROR_STOP=1 -q -h db -U podo_owner -d postgres)
    "${PSQL[@]}" -c "DROP DATABASE IF EXISTS podo_restore_new WITH (FORCE)" -c "CREATE DATABASE podo_restore_new"
    if ! decrypt_backup "$DB" | "${COMPOSE[@]}" exec -T backup pg_restore -h db -U podo_owner -d podo_restore_new --exit-on-error; then
      "${PSQL[@]}" -c "DROP DATABASE IF EXISTS podo_restore_new WITH (FORCE)" || true
      die "Einspielen fehlgeschlagen (Passphrase/Datei prüfen). Die bisherige Datenbank ist unverändert."
    fi

    say "3/3 Datenbank ersetzen"
    "${COMPOSE[@]}" stop app cron >/dev/null 2>&1 || true
    "${PSQL[@]}" -c "DROP DATABASE podo WITH (FORCE)" -c "ALTER DATABASE podo_restore_new RENAME TO podo"
    info "Datenbank ersetzt."
  fi

  if [ -n "$FILES" ]; then
    say "Dateien (Fotos/Dokumente) zurückspielen"
    "${COMPOSE[@]}" stop app cron >/dev/null 2>&1 || true
    local TS; TS=$(date +%Y%m%d-%H%M%S)
    # shellcheck disable=SC2016  # wird im Container ausgewertet
    decrypt_backup "$FILES" | "${COMPOSE[@]}" run --rm -T --no-deps --entrypoint sh app -c '
      set -eu
      S=/data/storage; TS="$1"; NEW="$S/.restore-new-$TS"; OLD="$S/.pre-restore-$TS"; ARC="$S/.restore-$TS.tgz"
      trap "rm -f \"$ARC\"" EXIT
      cat > "$ARC"
      # Archiv prüfen: keine absoluten Pfade, keine „..“-Bestandteile, keine Links
      if tar -tzf "$ARC" | grep -Eq "^/|(^|/)\.\.(/|$)"; then echo "Archiv enthält unsichere Pfade – abgebrochen." >&2; exit 1; fi
      if tar -tvzf "$ARC" | grep -Eq "^[lh]"; then echo "Archiv enthält Links – abgebrochen." >&2; exit 1; fi
      mkdir -m 700 "$NEW" "$OLD"
      tar -C "$NEW" -xz --strip-components=1 --no-same-owner --no-same-permissions -f "$ARC"
      # Umschalten: bisherigen Bestand (ohne frühere Quarantänen) in die Quarantäne, neuen Stand an seinen Platz
      find "$S" -mindepth 1 -maxdepth 1 ! -name ".restore-*" ! -name ".pre-restore-*" -exec mv -t "$OLD" {} +
      find "$NEW" -mindepth 1 -maxdepth 1 -exec mv -t "$S" {} +
      rmdir "$NEW"
    ' sh "$TS" || die "Dateien konnten nicht zurückgespielt werden (Bestand unverändert, sofern das Umschalten nicht begonnen hat)."
    info "Dateien zurückgespielt. Bisheriger Bestand in Quarantäne: /data/storage/.pre-restore-$TS"
    info "Nach erfolgreicher Prüfung löschen: ${COMPOSE[*]} run --rm --no-deps --entrypoint rm app -rf /data/storage/.pre-restore-$TS"
  fi

  say "Starten"
  "${COMPOSE[@]}" up -d "${SERVICES[@]}"
  if wait_healthy 240; then
    say "Wiederherstellung abgeschlossen – PodoCRM antwortet wieder."
    info "Hinweis: Passt der Code-Stand nicht zur Sicherung, startet migrate neuere Migrationen automatisch nach."
  else
    die "App antwortet nicht. Logs: ${COMPOSE[*]} logs --tail 100 migrate app"
  fi
}

main "$@"
exit 0
