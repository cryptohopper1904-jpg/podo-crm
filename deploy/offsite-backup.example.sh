#!/usr/bin/env bash
# BEISPIEL: verschlüsselte Backups an einen zweiten Standort kopieren (Hetzner Storage Box per rclone/SFTP).
# Die Dateien sind bereits mit BACKUP_PASSPHRASE verschlüsselt – der Speicheranbieter sieht nur Chiffrat.
# Trotzdem: AVV mit dem Anbieter abschließen, Standort Deutschland/EU wählen.
#
# Einrichtung (einmalig, als root auf dem PodoCRM-Server):
#   1. Storage Box bestellen (z. B. BX11), im Hetzner-Robot „SSH-Support“ und „Externe Erreichbarkeit“ aktivieren.
#   2. SSH-Schlüssel für die Box anlegen und hinterlegen (Port 23):
#        ssh-keygen -t ed25519 -f /root/.ssh/storagebox -N ''
#        cat /root/.ssh/storagebox.pub | ssh -p 23 uXXXXXX@uXXXXXX.your-storagebox.de install-ssh-key
#   3. rclone-Konfiguration /root/.config/rclone/rclone.conf anlegen:
#        [storagebox]
#        type = sftp
#        host = uXXXXXX.your-storagebox.de
#        user = uXXXXXX
#        port = 23
#        key_file = /config/ssh/storagebox
#        shell_type = unix
#   4. Kopieren und anpassen:  cp deploy/offsite-backup.example.sh /usr/local/sbin/podo-offsite && chmod 700 /usr/local/sbin/podo-offsite
#   5. Täglich nach dem Backup ausführen (Backup läuft ab Container-Start alle 24 h), z. B. /etc/cron.d/podo-offsite:
#        30 5 * * * root /usr/local/sbin/podo-offsite >> /var/log/podo-offsite.log 2>&1
#   6. Einmal testen: Datei zurückholen und prüfen:
#        rclone copy storagebox:podo-backups/db-….dump.gpg /root/restore/
#        bash /opt/podo-crm/deploy/restore-test.sh --file /root/restore/db-….dump.gpg
#
# Aufbewahrung: lokal BACKUP_RETENTION_DAYS (Standard 14). Offsite hier 90 Tage (--min-age … delete unten).
# Die Passphrase NICHT auf der Storage Box ablegen.
set -euo pipefail

RCLONE_REMOTE="${RCLONE_REMOTE:-storagebox:podo-backups}"   # <remote>:<ordner>
OFFSITE_RETENTION="${OFFSITE_RETENTION:-90d}"
APP_DIR="${APP_DIR:-/opt/podo-crm}"
RCLONE_IMAGE="rclone/rclone:1.68"

cd "$APP_DIR"
COMPOSE=(docker compose -f deploy/docker-compose.yml)
[ -f deploy/docker-compose.subdomain.yml ] && COMPOSE+=(-f deploy/docker-compose.subdomain.yml)
COMPOSE+=(--env-file deploy/.env)

BACKUP_CT=$("${COMPOSE[@]}" ps -q backup)
[ -n "$BACKUP_CT" ] || { echo "$(date -Iseconds) backup-Container nicht gefunden"; exit 1; }

# Volume „backups“ über den backup-Container einbinden (nur lesend), rclone-Konfiguration + SSH-Schlüssel vom Host
RCLONE=(docker run --rm --volumes-from "$BACKUP_CT:ro"
  -v /root/.config/rclone:/config/rclone:ro -v /root/.ssh:/config/ssh:ro "$RCLONE_IMAGE")

# copy (nicht sync): lokal gelöschte Backups bleiben offsite erhalten, bis sie die Offsite-Frist erreichen
"${RCLONE[@]}" copy /backups "$RCLONE_REMOTE" --include '*.gpg' --immutable --transfers 2
"${RCLONE[@]}" delete "$RCLONE_REMOTE" --min-age "$OFFSITE_RETENTION" --include '*.gpg'
echo "$(date -Iseconds) Offsite-Kopie nach $RCLONE_REMOTE fertig"
