#!/bin/sh
# Tägliches, verschlüsseltes Backup (Datenbank + Dateien). 14 Tage Aufbewahrung lokal.
# WICHTIG: Backups zusätzlich an einen zweiten Standort kopieren (z. B. Hetzner Storage Box via rclone)
# und regelmäßig eine Wiederherstellung testen (docs/BETRIEB.md).
set -e
TS=$(date +%Y%m%d-%H%M)
pg_dump -h db -U podo_owner -d podo -Fc | gpg --batch --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o /backups/db-$TS.dump.gpg
tar -C /data -cz storage | gpg --batch --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o /backups/files-$TS.tar.gz.gpg
find /backups -type f -mtime +14 -delete
echo "Backup $TS fertig"
