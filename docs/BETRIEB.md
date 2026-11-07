# Betrieb auf dem eigenen Server

## Voraussetzungen
- Linux-Server in Deutschland (z. B. Hetzner, IONOS, netcup), 2 vCPU, 4 GB RAM, 40 GB SSD reichen für eine Praxis
- Docker + Docker Compose
- Domain, die auf den Server zeigt (A-Record), z. B. `crm.deine-praxis.de`
- **AVV mit dem Hoster** abschließen (Art. 28 DSGVO) und IT-Dienstleister auf Verschwiegenheit verpflichten (§ 203 StGB)

## Erstinstallation
```bash
git clone <repo> podo-crm && cd podo-crm
cp deploy/.env.example deploy/.env
```
In `deploy/.env` setzen (u. a. `SETUP_TOKEN`: Einmal-Code für die Ersteinrichtung, sonst könnte jede Person, die die Domain zuerst aufruft, die Praxis anlegen):
- `DOMAIN`, `PUBLIC_URL`
- `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `BACKUP_PASSPHRASE`: lange Zufallswerte (`openssl rand -base64 32`)
- `APP_ENCRYPTION_KEY`: `openssl rand -base64 32`. **Sicher und getrennt aufbewahren**: Ohne diesen Schlüssel sind Fotos und Zugangsdaten nicht mehr lesbar.

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```
Danach `https://DOMAIN/einrichtung` öffnen und die Praxis anlegen. Anschließend unter **Einstellungen → Sicherheit** 2FA aktivieren.

## Updates
```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```
Der `migrate`-Container spielt neue Datenbank-Migrationen automatisch vor dem App-Start ein.

## Backups
- Der `backup`-Container sichert täglich Datenbank und Fotos, **verschlüsselt** (GPG/AES-256), 14 Tage lokal.
- **Pflicht:** Backups zusätzlich an einen zweiten Standort kopieren, z. B. per `rclone` auf eine Hetzner Storage Box.
- **Wiederherstellung einmal im Quartal testen** (Review-Empfehlung): 
```bash
gpg -d db-XXXX.dump.gpg | pg_restore -h <testserver> -U podo_owner -d podo_restore
```
- Ziele: Datenverlust höchstens 24 h (RPO), Wiederherstellung innerhalb von 4 h (RTO). Für den SaaS-Betrieb später: Managed PostgreSQL mit Point-in-Time-Recovery.

## Sicherheit im Betrieb
- App-Datenbankrolle `podo_app` ist **kein Superuser** (`NOBYPASSRLS`), damit die Mandantentrennung greift.
- Logs enthalten keine Gesundheitsdaten. Fehlertracking (z. B. Sentry) nur mit PHI-Filter und AVV.
- Betriebssystem-Updates automatisch (`unattended-upgrades`), SSH nur mit Schlüssel, Firewall nur 22/80/443.
- Server-Admins sehen keine Fotos im Klartext (verschlüsselt mit `APP_ENCRYPTION_KEY`). Den Schlüssel langfristig in ein KMS/Vault verlagern.

## Datenschutz-Checkliste vor dem ersten echten Patienten
Siehe [`docs/compliance/`](compliance/).
