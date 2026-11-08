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

## Erinnerungen & Rückholung (Cron)
- Endpunkt: `POST /api/cron/reminders` mit Header `Authorization: Bearer $CRON_SECRET` (zeitkonstanter Vergleich; ohne `CRON_SECRET` → 503, falsches Token → 401). Antwort enthält nur Zähler.
- Docker: Der Container `cron` (alpine + curl) ruft den Endpunkt alle 15 Minuten **intern** über `http://app:3000` auf. `install.sh` erzeugt `CRON_SECRET` (auch bei bestehenden Installationen).
- Einschalten je Praxis unter **Einstellungen → Erinnerungen** (`/einstellungen/erinnerungen`): 24-h-Terminerinnerung, Rückholung (überfällig, max. alle 30 Tage), Spangen-Erinnerung (Episode aktiv, letzte Doku > 4 Wochen). Standard: alles aus.
- Versand nur mit Einwilligung des Kanals (`email_reminders`/`sms_reminders`/`whatsapp`), Texte ohne medizinische Angaben. Jede Erinnerung wird über `reminder_log` (Unique-Schlüssel) höchstens einmal versendet; Fehler werden protokolliert und nicht automatisch wiederholt.
- Alternative auf Vercel (statt Cron-Container) – `vercel.json`:
```json
{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/15 * * * *" }] }
```
  Vercel Cron ruft per **GET** mit `Authorization: Bearer <CRON_SECRET>` auf (die Route akzeptiert GET und POST); `CRON_SECRET` als Umgebungsvariable im Projekt setzen. Hinweis: Viertelstündliche Crons brauchen einen kostenpflichtigen Vercel-Plan; für Gesundheitsdaten EU-Region + AVV beachten.

## Rechnungen: PDF, E-Mail, SumUp, Kundenportal
- PDF: `GET /api/invoices/<id>/pdf` (Recht „Rechnungen lesen“, protokolliert, nicht gecacht). E-Mail-Versand mit PDF-Anhang über die E-Mail-Schnittstelle; **echter SMTP-Versand ist noch nicht implementiert** (Testmodus protokolliert nur).
- SumUp: Webhook-URL im SumUp-Konto: `https://DOMAIN/api/webhooks/sumup?org=<Praxis-ID>`; Reader-ID des Solo-Terminals unter Einstellungen → Schnittstellen → SumUp. `PUBLIC_URL` muss gesetzt sein (Rückmeldung an den Webhook).
- Kundenportal: `/portal/<token>` (30 Tage gültig, nicht einmalig, neuer Link widerruft den alten). Gedrosselt je IP (Prozessspeicher – bei mehreren App-Instanzen Redis o. Ä. nötig).

## Kasse / TSE (KassenSichV)
- **Vor dem ersten echten Bargeld-Einsatz ist ein Vertrag mit einer zertifizierten TSE Pflicht** (z. B. fiskaly SIGN DE), dazu die Meldung der Kasse ans Finanzamt (§ 146a Abs. 4 AO) und die Verfahrensdokumentation.
- Bis dahin signiert ein **Mock** jede Barzahlung nur zum Test (`payments.external_ref = tse:test:…`). Das ersetzt keine TSE.
- fiskaly-Anbindung (Gerüst, ungetestet): `TSE_PROVIDER=fiskaly`, `FISKALY_API_KEY`, `FISKALY_API_SECRET`, `FISKALY_TSS_ID`, `FISKALY_CLIENT_ID`. Fehlen Zugangsdaten, wird die Barzahlung mit „TSE nicht konfiguriert“ abgelehnt. DSFinV-K-Export und Tagesabschlüsse sind noch offen (siehe `docs/SCHEMA_REQUESTS.md`).

## Datenschutz-Checkliste vor dem ersten echten Patienten
Siehe [`docs/compliance/`](compliance/).
