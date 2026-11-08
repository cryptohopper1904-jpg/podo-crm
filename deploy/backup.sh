#!/bin/sh
# Verschlüsseltes Backup (Datenbank + Dateien), läuft im backup-Container (postgres:16-alpine + gnupg).
#   backup.sh            tägliches Backup: Datenbank + Dateien, danach Aufräumen (BACKUP_RETENTION_DAYS, Standard 14)
#   backup.sh pre-update nur Datenbank, Dateiname db-preupdate-…, letzte Zeile: BACKUP_FILE=/backups/…
# Verschlüsselung: GPG symmetrisch, AES-256, Passphrase BACKUP_PASSPHRASE (über einen Dateideskriptor,
# nicht als Kommandozeilen-Argument). Ohne diese Passphrase ist das Backup wertlos – sicher aufbewahren!
# Nach Erfolg wird ein Zeitstempel nach /status/backup.last geschrieben (für /api/health/deep).
# WICHTIG: Backups zusätzlich an einen zweiten Standort kopieren (deploy/offsite-backup.example.sh)
# und regelmäßig eine Wiederherstellung testen (deploy/restore-test.sh, docs/BETRIEB.md).
set -eu

MODE="${1:-daily}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE fehlt}"
TS=$(date +%Y%m%d-%H%M%S)
umask 077

# save <zieldatei> <befehl…> – Befehl ausführen, Ausgabe verschlüsseln und erst nach Erfolg unter dem
# Zielnamen ablegen. Der Exit-Status des Befehls wird ohne pipefail geprüft (läuft in jeder POSIX-Shell):
# ein fehlgeschlagener pg_dump darf nie als „fertig“ durchgehen.
save() {
  target="$1"
  shift
  : > "$target.ok"
  { "$@" || rm -f "$target.ok"; } | gpg --batch --yes --quiet --pinentry-mode loopback --symmetric \
    --cipher-algo AES256 --passphrase-fd 3 -o "$target.tmp" 3<<EOF
$BACKUP_PASSPHRASE
EOF
  if [ ! -e "$target.ok" ]; then
    rm -f "$target.tmp"
    echo "$(date -Iseconds) FEHLER: $1 fehlgeschlagen, $target nicht erstellt" >&2
    exit 1
  fi
  rm -f "$target.ok"
  mv "$target.tmp" "$target"
}

case "$MODE" in
  daily)
    save "/backups/db-$TS.dump.gpg" pg_dump -h db -U podo_owner -d podo -Fc
    save "/backups/files-$TS.tar.gz.gpg" tar -C /data -cz storage
    find /backups -type f -name '*.gpg' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
    find /backups -type f \( -name '*.tmp' -o -name '*.ok' \) -mtime +1 -delete
    # lesbar für die App (läuft als eigener Benutzer), trotz umask 077 oben
    if [ -d /status ]; then (umask 022; date +%s > /status/backup.last); fi
    echo "$(date -Iseconds) Backup $TS fertig"
    ;;
  pre-update)
    save "/backups/db-preupdate-$TS.dump.gpg" pg_dump -h db -U podo_owner -d podo -Fc
    echo "$(date -Iseconds) Datenbank-Sicherung vor dem Update fertig"
    echo "BACKUP_FILE=/backups/db-preupdate-$TS.dump.gpg"
    ;;
  *)
    echo "Unbekannter Modus: $MODE (daily | pre-update)" >&2
    exit 2
    ;;
esac
