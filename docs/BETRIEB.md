# Betriebshandbuch (Runbook)

Für alle, die PodoCRM auf einem eigenen Server betreiben. Jeder Abschnitt ist eine Schritt-für-Schritt-Anleitung; die Befehle laufen als `root` auf dem Server. Installationsverzeichnis überall: `/opt/podo-crm`.

| Aufgabe | Befehl | Wann |
|---|---|---|
| Update | `bash /opt/podo-crm/deploy/update.sh` | bei neuen Versionen |
| Probelauf Update | `bash /opt/podo-crm/deploy/update.sh --dry-run` | vor jedem Update |
| Automatisches Update | `bash /opt/podo-crm/deploy/install-autoupdate.sh` (Timer `podo-update.timer`, täglich 03:30 Europe/Berlin + 10 min nach Boot, `update.sh --auto` gegen `main`, Log `/var/log/podo-update.log`; entfernen mit `--remove`) | einmalig |
| Bootstrap ohne Shell | `BOOTSTRAP_ADMIN_*` / `BOOTSTRAP_PRACTICE_JSON` + `BOOTSTRAP_PRACTICE_OWNER_PASSWORD` in `deploy/.env` (siehe `.env.example`, `deploy/cloud/hetzner-user-data.sh`); läuft idempotent im migrate-Container, Passwörter danach entfernen. Der Plattform-Admin erhält zusätzlich die „Demo-Praxis (Beispieldaten)“ (erfundene Daten, Tarif intern; abschalten mit `BOOTSTRAP_ADMIN_DEMO=false`) | Erstinstallation |
| Wiederherstellung testen | `bash /opt/podo-crm/deploy/restore-test.sh` | **einmal im Quartal** |
| Backup einspielen | `bash /opt/podo-crm/deploy/restore.sh --db … [--files …]` | Notfall |
| Zustand prüfen | `curl -H "Authorization: Bearer $TOKEN" https://DOMAIN/api/health/deep` | Monitoring, alle 5 min |

---

## 0. Die zwei Schlüssel, ohne die alles verloren ist

In `deploy/.env` stehen zwei Werte, die **nirgends sonst** existieren:

| Wert | Wofür | Was passiert ohne ihn |
|---|---|---|
| `APP_ENCRYPTION_KEY` | verschlüsselt Fotos, Audio, Dokumente und gespeicherte Zugangsdaten (SMTP, KIM, Schnittstellen) | Fotos/Dokumente und Zugangsdaten sind **dauerhaft unlesbar** – auch mit Backup |
| `BACKUP_PASSPHRASE` | verschlüsselt alle Backups (GPG, AES-256) | Backups lassen sich **nicht mehr entschlüsseln** – sie sind wertlos |

Pflicht direkt nach der Installation:
1. Die **ganze Datei** `deploy/.env` sichern (sie enthält auch die DB-Passwörter und `CRON_SECRET`): `cat /opt/podo-crm/deploy/.env` und in einen Passwort-Manager (z. B. KeePassXC, Bitwarden-Tresor der Firma) als sichere Notiz übernehmen.
2. Zusätzlich **offline** aufbewahren (ausgedruckt im Tresor oder verschlüsselter USB-Stick an einem zweiten Ort). Mindestens zwei Personen müssen wissen, wo.
3. **Niemals** zusammen mit den Backups ablegen (nicht auf die Storage Box, nicht ins Git-Repository, nicht per E-Mail).
4. Schlüssel nie „mal eben“ ändern: Ein neuer `APP_ENCRYPTION_KEY` macht alle vorhandenen Fotos unlesbar; eine neue `BACKUP_PASSPHRASE` gilt nur für neue Backups (alte brauchen weiter die alte Passphrase – beide aufheben).

Langfristig (SaaS-Betrieb): Schlüssel in ein KMS/Vault verlagern.

### APP_ENCRYPTION_KEY nie tauschen ohne Umschlüsseln

Aus `APP_ENCRYPTION_KEY` werden weitere Schlüssel abgeleitet. Ein Tausch ohne Umschlüsseln macht nicht nur Dateien und
Zugangsdaten unlesbar, sondern auch:

- **Sperrliste des Vertriebs** (`sales_blocklist`): Abgemeldete Adressen, Websites und Praxen sind dort nur als
  nicht umkehrbarer Prüfwert gespeichert (HMAC mit Präfix `v1:`, Schlüssel aus `APP_ENCRYPTION_KEY`). Mit einem neuen
  Schlüssel passt **kein** Prüfwert mehr – die Sperrliste wäre **wirkungslos**, abgemeldete Praxen würden wieder
  angeschrieben (Abmahnrisiko, Art. 21 DSGVO). Deshalb speichert die App einen Kanarienwert
  (`sales_settings.blocklist_key_check`); passt er nicht zum aktuellen Schlüssel, sperrt sie Versand, Import und
  Praxissuche mit der Meldung „Sperrlisten-Schlüssel passt nicht – Versand gesperrt (siehe BETRIEB.md)“.
  Abhilfe: alten Schlüssel wieder einsetzen. Eine Rotation geht nur per Schlüsselbund (alte Version `v1` weiter
  vorhalten, neue Einträge mit `v2:` schreiben, beim Abgleich jede Version prüfen) – das ist noch nicht umgesetzt.
- **Abmeldelinks** in bereits versendeten Vertriebsmails (`/abmelden/…`, HMAC) werden ungültig.
- **Signierte Links** (Portal, Kalender-Feeds, Anamnese) werden ungültig.

---

## 1. Installation

### Voraussetzungen
- Linux-Server in Deutschland (z. B. Hetzner, IONOS, netcup), Ubuntu/Debian, 2 vCPU, 4 GB RAM, 40 GB SSD reichen für eine Praxis.
- Domain bzw. Subdomain mit DNS-A-Eintrag auf den Server.
- **AVV mit dem Hoster** (Art. 28 DSGVO), IT-Dienstleister auf Verschwiegenheit verpflichten (§ 203 StGB).
- Betriebssystem: automatische Sicherheitsupdates (`apt install unattended-upgrades`), SSH nur mit Schlüssel, Firewall nur 22/80/443.

### 1a. Eigener Server (PodoCRM bringt seinen eigenen Caddy für HTTPS mit)
```bash
git clone https://github.com/cryptohopper1904-jpg/podo-crm.git /opt/podo-crm
bash /opt/podo-crm/deploy/install.sh crm.deine-praxis.de
```
`install.sh` bricht ab, wenn Port 80/443 schon belegt ist (dann 1b). Es installiert Docker, schaltet die Firewall (`ufw`: 22/80/443) ein, erzeugt `deploy/.env` mit Zufallswerten (nur wenn sie noch nicht existiert) und startet alle Dienste: `db`, `migrate`, `app`, `caddy`, `backup`, `cron`. Mit einer IP statt Domain wird ein selbst signiertes Zertifikat und eine Demo-Praxis verwendet (nur Test, keine echten Daten).

Danach:
1. **Schlüssel sichern** (Abschnitt 0).
2. `https://DOMAIN/einrichtung` öffnen, Einrichtungs-Code (`SETUP_TOKEN`, wird am Ende ausgegeben) eingeben und die Praxis anlegen. Ohne Code könnte jede Person, die die Domain zuerst aufruft, die Praxis anlegen.
3. Unter **Einstellungen → Sicherheit** 2FA aktivieren.
4. Offsite-Backup einrichten (Abschnitt 3.3) und Monitoring (Abschnitt 4).

### 1b. Als Subdomain neben einem vorhandenen Caddy (z. B. `podo.algoverdict.com` neben `hub.algoverdict.com`)
```bash
curl -fsSL https://raw.githubusercontent.com/cryptohopper1904-jpg/podo-crm/main/deploy/install-subdomain.sh | bash -s podo.algoverdict.com
```
Das Skript erkennt den vorhandenen Caddy (systemd oder Docker), startet PodoCRM **ohne** eigenen Caddy (`db migrate app backup cron`), veröffentlicht die App nur lokal (`127.0.0.1:3010` bzw. Docker-Bridge, Port per `PODO_PORT` änderbar) und hängt einen Block an das vorhandene Caddyfile an (Sicherung `Caddyfile.bak.<zeit>`). Erzeugt wird `deploy/docker-compose.subdomain.yml` – an dieser Datei erkennen `update.sh`, `restore.sh` und `restore-test.sh` den Subdomain-Modus. Diese Datei nicht löschen.

Standard ist Testbetrieb mit Demo-Praxis (`SEED_DEMO=true`, Login `demo@podocrm.local`) – **keine echten Patientendaten**. Für Echtbetrieb `SEED_DEMO=false` setzen und die Demo-Praxis löschen (Abschnitt 7).

**Demo-Passwort** (`scripts/seed-demo.ts`, Gesamt-Review K1) – der Seed läuft nur einmal (solange die Demo-Praxis nicht existiert):

| Situation | Passwort der Demo-Inhaber:in |
|---|---|
| `SEED_DEMO_PASSWORD` in `deploy/.env` gesetzt (mind. 12 Zeichen) | dieses Passwort |
| `PUBLIC_URL` ist eine echte Domain, kein `SEED_DEMO_PASSWORD` | **Zufallspasswort**, wird genau einmal im migrate-Log ausgegeben: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs migrate \| grep Demo-Praxis` |
| IP-Adresse oder `localhost` (Test, Entwicklung, E2E) | bekanntes `demo-passwort-123` |

Auf einer öffentlichen Domain wird das bekannte Passwort nie verwendet (auch nicht über `SEED_DEMO_PASSWORD`). Beim ersten Login muss die Demo-Inhaber:in 2FA einrichten (Pflicht für Inhaber:innen). Ist eine Instanz früher mit dem bekannten Passwort angelegt worden: Passwort sofort ändern oder die Demo-Praxis löschen.

### Wichtige Einstellungen in `deploy/.env`
| Variable | Bedeutung |
|---|---|
| `DOMAIN`, `PUBLIC_URL` | Adresse der Installation |
| `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD` | Datenbank-Passwörter (Zufall, nicht ändern) |
| `APP_ENCRYPTION_KEY`, `BACKUP_PASSPHRASE` | siehe Abschnitt 0 |
| `SETUP_TOKEN` | Einmal-Code für `/einrichtung` |
| `CRON_SECRET` | schützt `/api/cron/*` |
| `HEALTH_TOKEN` | Token für `/api/health/deep` (eigenes Geheimnis, nicht `CRON_SECRET`) |
| `BACKUP_RETENTION_DAYS` | Aufbewahrung lokaler Backups (Standard 14) |
| `SENTRY_DSN`, `ERROR_WEBHOOK_URL` | optionales Fehler-Reporting (Abschnitt 4.3) |
| `TRUSTED_PROXY_HOPS` | Anzahl Proxys vor der App (Abschnitt 6) |
| `ADDRESS_PROVIDER`, `PHOTON_URL` | Adress-Vorschläge (`photon` Standard, `off` = aus; eigene Photon-Instanz), Abschnitt 8 |

Nach Änderungen an `deploy/.env`: `bash /opt/podo-crm/deploy/update.sh` (gleicher Stand → Container werden nur neu abgeglichen).

---

## 2. Update

```bash
bash /opt/podo-crm/deploy/update.sh --dry-run     # zeigt Ziel-Commit, neue Commits und alle Schritte – ändert nichts
bash /opt/podo-crm/deploy/update.sh               # auf origin/main
bash /opt/podo-crm/deploy/update.sh v1.4.0        # auf einen Tag, Branch oder Commit (auch: --ref v1.4.0)
```
Erstes Update einer älteren Installation, in der `update.sh` noch fehlt: einmal `git -C /opt/podo-crm pull`, danach wie oben.

Was das Skript macht (gleich für eigenen Server und Subdomain-Modus):
1. **Modus erkennen** (eigener Caddy oder `docker-compose.subdomain.yml`) und die passenden Dienste wählen.
2. **`git fetch`**, Ziel auflösen, neue Commits anzeigen. Bricht ab, wenn versionierte Dateien lokal geändert wurden (`--force` überschreibt sie). Warnt bei einem Downgrade.
3. **Datenbank-Sicherung** `db-preupdate-<zeit>.dump.gpg` im Volume `backups` – gleich verschlüsselt wie das tägliche Backup. Schlägt sie fehl, wird nichts geändert. (`--skip-backup` nur im Notfall.)
4. **Auschecken und bauen**, während die alte Version weiterläuft. Build-Fehler → Code zurück, die alte Version läuft unverändert.
5. **Neustart**: `migrate` spielt neue Datenbank-Migrationen ein, dann startet `app`; `backup` und `cron` werden neu erstellt.
6. **Health-Check**: wartet bis zu 240 s (`--timeout`) auf `/api/health`.

Wird die neue Version nicht gesund, setzt das Skript den Code auf den vorherigen Commit zurück, baut und startet neu und gibt aus, wie die Sicherung von vor dem Update eingespielt wird. Das ist nötig, wenn Migrationen schon gelaufen sind und die alte Version nicht mit dem neuen Schema startet:
```bash
bash /opt/podo-crm/deploy/restore.sh --db db-preupdate-<zeit>.dump.gpg
```
Achtung: Alles, was seit dieser Sicherung eingegeben wurde, geht dabei verloren. Deshalb Updates außerhalb der Sprechzeiten durchführen.

Das Skript lässt sich gefahrlos mehrfach ausführen; ein zweites Update gleichzeitig verhindert eine Sperre (`deploy/.update.lock` im Installationsverzeichnis, nicht im allgemein beschreibbaren `/tmp`).

---

## 3. Backup & Wiederherstellung

### 3.1 Was gesichert wird
- Der Dienst `backup` sichert **beim Start und dann alle 24 h** Datenbank (`db-<zeit>.dump.gpg`, `pg_dump -Fc`) und Dateien (`files-<zeit>.tar.gz.gpg`, das Volume `storage` – die Dateien darin sind zusätzlich mit `APP_ENCRYPTION_KEY` verschlüsselt).
- Verschlüsselung: GPG symmetrisch, AES-256, mit `BACKUP_PASSPHRASE`. Ein Backup gilt erst als fertig, wenn Dump und Verschlüsselung geklappt haben (sonst bleibt keine halbe Datei liegen).
- Ablage: Docker-Volume `backups` auf demselben Server, Aufbewahrung `BACKUP_RETENTION_DAYS` (14 Tage). Nach jedem Erfolg schreibt der Dienst einen Zeitstempel, den `/api/health/deep` prüft.
- Ziele: Datenverlust höchstens 24 h (RPO), Wiederherstellung innerhalb von 4 h (RTO). Für den SaaS-Betrieb später: Managed PostgreSQL mit Point-in-Time-Recovery.

Backups ansehen und sofort eines anstoßen:
```bash
cd /opt/podo-crm
C="docker compose -f deploy/docker-compose.yml $( [ -f deploy/docker-compose.subdomain.yml ] && echo -f deploy/docker-compose.subdomain.yml ) --env-file deploy/.env"
$C exec backup ls -lt /backups          # vorhandene Backups
$C exec backup /backup.sh               # jetzt ein vollständiges Backup
$C logs --tail 20 backup                # „Backup … fertig“ oder „FEHLER …“
```

### 3.2 Wiederherstellung testen – einmal im Quartal (Pflicht)
```bash
bash /opt/podo-crm/deploy/restore-test.sh
```
Das Skript spielt das **neueste** Datenbank-Backup in einen **Wegwerf-Postgres-Container** ein (die laufende Installation bleibt unberührt), prüft:
- Alter des Backups (≤ 26 h), Entschlüsselung und `pg_restore` ohne Fehler,
- Anzahl Tabellen, Zeilenzahlen wichtiger Tabellen, mindestens eine Praxis,
- Migrationsstand im Vergleich zum Code,
- **Hash-Kette der Behandlungsdoku**: per SQL (je Patient:in genau ein Anfang, keine Lücke, keine Verzweigung) und durch Neuberechnung aller Hashes mit dem App-Code (`scripts/verify-hash-chains.ts`, auch der Nachträge). Demo-Praxen werden nur auf Verkettung geprüft.
- **Kassenabschlüsse (Z-Bons)**: je Praxis Z-Nummern 1…n ohne Lücke, Kette ohne Bruch, Belegnummern fortlaufend (SQL) und Neuberechnung der Inhalts-Hashes (inkl. Bon-Snapshot) mit dem App-Code (`src/lib/kasse/chain.ts`).
- das neueste Datei-Backup (entschlüsselbar, Anzahl Dateien – ohne Entpacken auf die Platte),

und löscht Container, Netzwerk und Daten danach wieder. Die Ausgabe enthält nur Zähler und IDs. Ergebnis (Datum, „erfolgreich“) im Betriebsprotokoll / in der Verfahrensdokumentation festhalten.

Optionen: `--file /pfad/db-….dump.gpg` (z. B. eine aus dem Offsite-Speicher zurückgeholte Datei – damit testet man auch die Offsite-Kopie), `--skip-files`, `--skip-recompute`, `--keep` (Container zum Nachsehen stehen lassen; danach mit dem ausgegebenen Befehl löschen).

Erinnerung einrichten, z. B. `/etc/cron.d/podo-restore-test`:
```
# 1. Januar/April/Juli/Oktober, 04:30 – Ergebnis per Mail an root
30 4 1 1,4,7,10 * root bash /opt/podo-crm/deploy/restore-test.sh > /var/log/podo-restore-test.log 2>&1 || echo "PodoCRM Restore-Test FEHLGESCHLAGEN" | mail -s "PodoCRM Restore-Test" root
```

### 3.3 Zweiter Standort (Pflicht)
Backups auf demselben Server helfen nicht, wenn der Server weg ist. Beispiel für eine **Hetzner Storage Box** per `rclone` (SFTP): `deploy/offsite-backup.example.sh` – Einrichtung steht im Kopf der Datei (SSH-Schlüssel, `rclone.conf`, Cron-Eintrag täglich nach dem Backup). Es wird mit `copy` (nicht `sync`) kopiert und offsite 90 Tage aufbewahrt. Die Dateien sind schon verschlüsselt; die Passphrase gehört **nicht** auf die Storage Box. AVV mit dem Anbieter abschließen.

### 3.4 Backup in die laufende Installation einspielen
```bash
bash /opt/podo-crm/deploy/restore.sh --db latest                                # neuestes DB-Backup
bash /opt/podo-crm/deploy/restore.sh --db db-20261108-0300.dump.gpg --files files-20261108-0300.tar.gz.gpg
bash /opt/podo-crm/deploy/restore.sh --db /root/restore/db-….dump.gpg           # Datei vom Host (Offsite)
```
Ablauf: Rückfrage (`WIEDERHERSTELLEN` eintippen; `--yes` ohne Rückfrage, `--dry-run` nur anzeigen) → aktuellen Stand zusätzlich sichern (`db-preupdate-…`) → Backup in eine Hilfsdatenbank einspielen → **nur wenn das fehlerfrei war**: App und Cron stoppen, Datenbank `podo` ersetzen → Dateien (optional): Archiv prüfen (keine absoluten Pfade, kein `..`, keine Links), in ein leeres Verzeichnis entpacken, dann umschalten – der bisherige Bestand wandert vollständig nach `storage/.pre-restore-<zeit>` (Quarantäne, nicht in neuen Backups) → alles starten und auf `/api/health` warten. Ist das Backup älter als der Code, spielt `migrate` die fehlenden Migrationen automatisch nach.

Datenbank und Dateien möglichst vom **selben Zeitpunkt** einspielen. Nach dem Datei-Restore liegen neuere Fotos (ohne Datenbank-Bezug) nur noch in der Quarantäne; nach erfolgreicher Prüfung löschen (Befehl gibt das Skript aus). Wird nur die Datenbank zurückgespielt, bleiben neuere Dateien im Volume, sind aber nicht mehr verknüpft – dann `--files` vom selben Zeitpunkt mit einspielen.

---

## 4. Monitoring

### 4.1 Öffentlich: `/api/health`
`GET /api/health` → `{"ok":true}` (bzw. `503 {"ok":false}`, wenn die Datenbank nicht antwortet). Keine weiteren Angaben. Nutzt der Docker-Healthcheck des `app`-Containers (alle 30 s); `cron` startet erst, wenn die App gesund ist; `update.sh` wartet darauf.

### 4.2 Geschützt: `/api/health/deep`
```bash
curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://DOMAIN/api/health/deep
```
Token: `HEALTH_TOKEN` aus `deploy/.env` (wird von `install.sh` erzeugt). Fehlt es → `503`, falsches Token → `401`.

| Prüfung | ok | warn | fail |
|---|---|---|---|
| `database` | `select 1` < 3 s | – | nicht erreichbar |
| `migrations` | DB auf Stand des Codes | Tabelle nicht lesbar | DB hinter dem Code |
| `storage` | Testdatei in `STORAGE_DIR` schreib-/löschbar | – | nicht beschreibbar |
| `backup` | letztes Backup ≤ 26 h | noch keins erfasst | älter |
| `cronReminders`, `cronKim` | letzter erfolgreicher Lauf ≤ 45 min | noch keiner erfasst (z. B. ohne `CRON_SECRET`) | älter |
| `webhooks` | keine Webhook-Ereignisse älter als 1 h offen | endgültig aufgegebene Ereignisse (`dead`, Hinweis im Posteingang der Praxis) | Ereignisse seit über 1 h unverarbeitet |

Antwort: `{ ok, status: "ok"|"warn"|"fail", checkedAt, checks: { … } }` mit Zeiten und Zählern, ohne Personendaten. HTTP 200 bei `ok`/`warn`, **503 bei `fail`** – so kann jeder Uptime-Dienst (z. B. Uptime Kuma, selbst gehostet) einfach den Statuscode überwachen: HTTP-Monitor, Intervall 5 min, Header `Authorization: Bearer …`. Die Zeitstempel schreiben `backup` und `cron` in das Volume `ops_status`, die App liest es nur.

Für einen externen Monitoring-Dienst einen eigenen `HEALTH_TOKEN` setzen (dann kennt der Dienst nicht das Cron-Secret).

### 4.3 Fehler-Reporting (optional)
Server-Fehler werden immer als **JSON-Logzeile** ausgegeben (`docker compose … logs app`), z. B. `{"ts":"…","level":"error","event":"request.error","route":"/kunden/[id]","method":"GET","routeType":"render","errorName":"Error","digest":"…"}`.

Zusätzlich, nur wenn gesetzt:
- `SENTRY_DSN` – Bericht an Sentry (ohne SDK, direkt per HTTPS). **Nur EU-Region** (`*.ingest.de.sentry.io`) und mit AVV.
- `ERROR_WEBHOOK_URL` (+ optional `ERROR_WEBHOOK_TOKEN`) – JSON per POST an einen eigenen HTTPS-Endpunkt.

Gesendet werden ausschließlich: Route-**Muster** (z. B. `/portal/[token]`, nie der echte Pfad), Methode, Art (render/route/action), Fehlername, gekürzte Fehlermeldung (E-Mail-Adressen, Telefonnummern, IBAN, lange Zahlen, Query-Strings, DB-Werte werden herausgefiltert), Digest, Zeitpunkt, Umgebung. Keine Header, Cookies, Request-Inhalte, Stacktraces oder Nutzer-IDs (`src/lib/error-report.ts`, `src/instrumentation.ts`).

### 4.4 Logs
- Eigener Code loggt über `src/lib/log.ts` (eine JSON-Zeile je Ereignis, sensible Felder werden geschwärzt). **Keine Gesundheitsdaten in Logs.**
- Docker-Logs begrenzen, sonst laufen sie voll – `/etc/docker/daemon.json`:
  ```json
  { "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
  ```
  danach `systemctl restart docker`.
- Zugriffslogs eines vorgeschalteten Webservers für `/portal/*` und `/anamnese/*` redigieren oder abschalten (Token im Pfad beim ersten Aufruf). Der mitgelieferte Caddy schreibt standardmäßig keine Zugriffslogs.

---

## 5. Notfall: Server ist weg → Neuaufbau aus Backup

Voraussetzung: gesicherte `deploy/.env` (Abschnitt 0) und Offsite-Backups (Abschnitt 3.3).

1. **Neuen Server** bereitstellen (gleiche Anforderungen wie in 1), DNS-Eintrag auf die neue IP umstellen (kurze TTL hilft).
2. **Code holen** – möglichst dieselbe Version wie vorher (sonst `main`):
   ```bash
   git clone https://github.com/cryptohopper1904-jpg/podo-crm.git /opt/podo-crm
   ```
3. **Alte `deploy/.env` zurücklegen**, *bevor* irgendetwas gestartet wird (sonst werden neue Schlüssel erzeugt):
   ```bash
   nano /opt/podo-crm/deploy/.env     # Inhalt aus dem Passwort-Manager einfügen
   chmod 600 /opt/podo-crm/deploy/.env
   ```
   Sicherstellen, dass `SEED_DEMO=false` gesetzt ist.
4. **Installieren** wie vorher – `bash /opt/podo-crm/deploy/install.sh DOMAIN` bzw. `install-subdomain.sh DOMAIN`. Beide behalten eine vorhandene `.env`. Es entsteht eine leere, migrierte Datenbank.
5. **Backups zurückholen** (Beispiel Storage Box, rclone wie in `deploy/offsite-backup.example.sh` einrichten):
   ```bash
   mkdir -p /root/restore && docker run --rm -v /root/.config/rclone:/config/rclone:ro -v /root/.ssh:/config/ssh:ro \
     -v /root/restore:/restore rclone/rclone:1.68 copy storagebox:podo-backups /restore --max-age 3d
   ls -lt /root/restore
   ```
6. **Prüfen und einspielen** (neueste zusammengehörige Dateien `db-…`/`files-…`):
   ```bash
   bash /opt/podo-crm/deploy/restore-test.sh --file /root/restore/db-<zeit>.dump.gpg --skip-files
   bash /opt/podo-crm/deploy/restore.sh --db /root/restore/db-<zeit>.dump.gpg --files /root/restore/files-<zeit>.tar.gz.gpg
   ```
7. **Kontrolle**: `/api/health/deep` (alles `ok`, Backup/Cron werden nach dem ersten Lauf grün), Anmeldung mit 2FA, ein Foto in einer Akte öffnen (prüft `APP_ENCRYPTION_KEY`), letzte Behandlungen vorhanden?
8. Offsite-Backup und Monitoring auf dem neuen Server wieder einrichten; alten Server beim Hoster endgültig löschen lassen. Den Vorfall dokumentieren; bei möglichem Datenabfluss: Meldepflicht nach Art. 33 DSGVO (72 h) prüfen.

Nur `BACKUP_PASSPHRASE` vorhanden, `.env` sonst verloren: neue `.env` erzeugen lassen und die alten Werte für `BACKUP_PASSPHRASE` **und** `APP_ENCRYPTION_KEY` vor dem ersten Start eintragen. Ohne `APP_ENCRYPTION_KEY` lässt sich die Datenbank wiederherstellen, Fotos/Dokumente und gespeicherte Zugangsdaten aber nicht.

---

## 6. Sicherheit im Betrieb
- App-Datenbankrolle `podo_app` ist **kein Superuser** (`NOBYPASSRLS`), damit die Mandantentrennung greift. Migrationen und Backups laufen als Eigentümer `podo_owner`.
- Fotos/Dokumente liegen verschlüsselt (`APP_ENCRYPTION_KEY`) in der Dateiablage. Das schützt bei Verlust einzelner Volumes oder Backups ohne `deploy/.env` – **nicht** gegen Server-Admins mit root-Zugriff: Der Schlüssel liegt in `deploy/.env` auf demselben Server.
- **Umgebung je Container** (Gesamt-Review H2): Die App erhält nur die in `deploy/docker-compose.yml` unter `app.environment` gelisteten Variablen (kein `env_file`). `DB_OWNER_PASSWORD` bekommen nur `db`, `migrate` und `backup`, `BACKUP_PASSPHRASE` nur `backup`, `BOOTSTRAP_*` nur `migrate`. Neue App-Variablen dort ergänzen (Test `src/lib/deploy-env.test.ts`).
- **Client-IP / `TRUSTED_PROXY_HOPS`** (Standard `1`): Die App nimmt die IP für Audit-Log und Rate-Limits aus `X-Forwarded-For`, und zwar den *n*-ten Eintrag von rechts – n = Anzahl der vertrauenswürdigen Proxys vor der App. Standard-Setup (nur Caddy, App-Port nicht öffentlich): `1`. Mit vorgeschaltetem CDN/Load-Balancer, der selbst `X-Forwarded-For` anhängt: `2` usw. Ohne Proxy: `0` – dann werden die Header ignoriert. Einträge weiter links sind vom Client fälschbar und werden nie verwendet. Der App-Port darf nicht an Caddy vorbei erreichbar sein (im Subdomain-Modus nur an `127.0.0.1`/Docker-Bridge gebunden).
- **Sitzungs-Cookie**: In Produktion `__Host-podo_session` (nur HTTPS, `Path=/`, ohne `Domain`), lokal `podo_session`.
- **Sitzungs-Entzug**: Neue Tokens bei Praxiswechsel und Support betreten/verlassen. Alle Sitzungen einer Person enden bei 2FA-Sperre (5 falsche Codes), beim eigenen Passwortwechsel (außer der aktuellen) und beim Löschen des Kontos; bei Deaktivierung im Team die Sitzungen in dieser Praxis. Passwort-Fehlversuche sperren nur neue Anmeldungen.
- **2FA-Pflicht** (Gesamt-Review H1): Inhaber:innen und Plattform-Admins brauchen immer 2FA, andere Rollen, wenn die Praxis es unter *Einstellungen → Sicherheit* festlegt. Ohne eingerichtete 2FA ist die Anmeldung möglich, aber es öffnet sich nur `/login/2fa-einrichten` (und Abmelden); Seiten leiten dorthin, API-Routen antworten 401/403.
- **Passwort vergessen**: `/login/passwort-vergessen` antwortet immer gleich (Drosselung je IP und je E-Mail), der Link (`PUBLIC_URL/login/passwort-neu?token=…`) ist 30 Minuten gültig und einmalig; in der DB steht nur der sha256 (`password_resets`). Nach dem Zurücksetzen enden alle Sitzungen, 2FA bleibt Pflicht. Versand über den Plattform-SMTP (`SMTP_URL`, `SMTP_FROM`) – ohne ihn in Produktion nur eine Warnung im Log (`password_reset.no_mail_transport`), keine Mail.
- **Support-Modus**: keine Exporte und keine Foto-/Datei-Downloads (Doctolib-CSV, Auskunft je Person, Praxis-Export, GKV-Abrechnung, DSFinV-K, Medien); erlaubt sind nur einzelne Belege (Rechnungs-PDF, Z-Bon). Jede Seitenansicht und jeder Download wird als `support.view` protokolliert – ohne Ausnahme nach Anfrage-Headern.
- **Praxis-Export** (`/api/export/praxis`) wird gestreamt (Tabellen seitenweise, Medien einzeln, ZIP64 ab 4 GB). Audit-Log: `org.export`, `org.export.completed`/`org.export.failed`.

---

## 7. Datenschutz-Hinweise für den Betrieb
- **Backups enthalten Gesundheitsdaten** (Art. 9 DSGVO): nur verschlüsselt speichern und übertragen, Offsite-Anbieter mit AVV und Standort DE/EU, Passphrase getrennt aufbewahren.
- **Restore-Tests** laufen in einem Wegwerf-Container auf dem Produktionsserver und werden danach gelöscht. Backups nicht auf Arbeitsplatz-Rechnern oder Laptops entschlüsseln.
- **Löschfristen**: Nach dem endgültigen Löschen einer Praxis (Abschnitt 9) sind ihre Daten noch so lange in Backups vorhanden, wie diese aufbewahrt werden – lokal `BACKUP_RETENTION_DAYS` (14 Tage), offsite 90 Tage (Beispielskript). Diese Fristen im Löschkonzept/AVV so angeben; bei einer Wiederherstellung bereits gelöschte Praxen erneut mit `scripts/purge-organizations.ts` löschen.
- **Aufbewahrungspflichten** (Behandlungsdoku 10 Jahre, § 630f BGB; Rechnungen GoBD) erfüllt die Datenbank selbst, nicht das Backup.
- **Kund:in löschen** (Inhaber:in, *Kunde bearbeiten → Kund:in löschen*): ohne Behandlungsdoku, Anamnese, Behandlungsfotos und Rechnungen vollständige Löschung (DB-Funktion `podo_delete_patient`, Audit `patient.deleted`); sonst Löschung der Kontaktdaten, Widerruf der Werbe-/Kanal-Einwilligungen, Löschen der Marketing-Fotos und Archivierung (Audit `patient.contact_erased`). Die endgültige Löschung nach Fristablauf ist noch ein Betreiber-Schritt (offen, siehe `docs/reviews/GESAMT-REVIEW.md` H3).
- **Webhook-Rohdaten** (`webhook_events`, RLS je Praxis): Inhalt nur bis zur erfolgreichen Verarbeitung, Einträge werden nach 30 Tagen gelöscht (Cron).
- **Logs und Fehlerberichte** ohne Patientendaten (Abschnitt 4.3/4.4). Fehlertracking nur mit AVV und EU-Region.
- **Support-Zugriffe** nur über die Freigabe der Praxis (Break-Glass, protokolliert). Admin-Zugriff auf Server/Datenbank auf das Nötigste beschränken und dokumentieren.
- Checkliste vor dem ersten echten Patienten: [`docs/compliance/`](compliance/).

---

## 8. Fachliche Dienste

### Erinnerungen, Rückholung, KIM (Cron)
- Endpunkte: `POST /api/cron/reminders`, `POST /api/cron/kim` und täglich `POST /api/cron/aufbewahrung` (löscht unbestätigte Online-Terminanfragen ohne zugeordnete Person nach 6 Monaten), jeweils mit `Authorization: Bearer $CRON_SECRET` (zeitkonstanter Vergleich; ohne `CRON_SECRET` → 503, falsches Token → 401). Antwort enthält nur Zähler.
- Docker: Der Container `cron` ruft beide alle 15 Minuten **intern** über `http://app:3000` auf und schreibt nach jedem erfolgreichen Lauf einen Zeitstempel (für `/api/health/deep`). `install.sh`/`install-subdomain.sh` erzeugen `CRON_SECRET` (auch bei bestehenden Installationen).
- Einschalten je Praxis unter **Einstellungen → Erinnerungen**: 24-h-Terminerinnerung, Rückholung (überfällig, max. alle 30 Tage), Spangen-Erinnerung. Standard: alles aus.
- Versand nur mit Einwilligung des Kanals (`email_reminders`/`sms_reminders`/`whatsapp`), Texte ohne medizinische Angaben. Jede Erinnerung wird über `reminder_log` höchstens einmal versendet; Fehler werden protokolliert und nicht automatisch wiederholt.
- Alternative auf Vercel – `vercel.json`: `{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/15 * * * *" }] }`. Vercel ruft per **GET** mit `Authorization: Bearer <CRON_SECRET>` auf (die Routen akzeptieren GET und POST). Viertelstündliche Crons brauchen einen kostenpflichtigen Plan; für Gesundheitsdaten EU-Region + AVV.

### Kalender-Abo (iCal-Import, z. B. Doctolib über Docal.io/CalMedi → Google Kalender)
- Endpunkt: `POST /api/cron/kalender-abo` mit `Authorization: Bearer $CRON_SECRET` (wie oben). Der Container `cron` ruft ihn alle 5 Minuten auf (Zeitstempel `cron-kalender-abo.last`).
- Je Lauf alle aktiven Abos aller Praxen, höchstens 5 parallel, je Abo 30 s; Abruf nur per https über den SSRF-Schutz (`net-guard`), 10 s Zeitlimit, max. 5 MB, ETag/If-Modified-Since. Fenster: heute − 7 bis + 90 Tage.
- Die private iCal-Adresse ist ein Zugangsgeheimnis: verschlüsselt in `calendar_feeds.url_enc` (AAD = Praxis + Abo), nie in Logs oder Fehlermeldungen.
- Termine werden nie automatisch einer Kund:in zugeordnet und nie gelöscht; in PodoHero geänderte Termine werden nicht überschrieben (Kennzeichen `local_change`), Überschneidungen mit Terminen derselben Behandler:in werden markiert.
- `/api/health/deep` → `kalender_abo`: `warn`, wenn einzelne Abos seit 30 min nicht erfolgreich abgerufen wurden oder einen Fehler melden; `fail`, wenn keines aktuell ist (Cron läuft nicht).

### Rechnungen: PDF, E-Mail, SumUp, Kundenportal
- PDF: `GET /api/invoices/<id>/pdf` (Recht „Rechnungen lesen“, protokolliert, nicht gecacht). Versand per E-Mail über Praxis-SMTP oder Plattform-SMTP (`SMTP_URL`, `SMTP_FROM`), nur mit TLS.
- SumUp: Webhook-URL im SumUp-Konto `https://DOMAIN/api/webhooks/sumup?org=<Praxis-ID>`; Reader-ID unter Einstellungen → Schnittstellen → SumUp. `PUBLIC_URL` muss gesetzt sein.
- Kundenportal: `/portal/<token>` (30 Tage gültig, neuer Link widerruft den alten). Der Token wird gegen eine signierte Sitzung (Cookie `podo_portal`, HttpOnly, SameSite=Strict, 2 h) getauscht. Rate-Limits liegen im Prozessspeicher – bei mehreren App-Instanzen Redis o. Ä. nötig.
- Webhooks (SumUp, WhatsApp, SMS, lexoffice) werden erst gespeichert (`webhook_events`, Status `pending`), dann verarbeitet. Fehler oder ein Neustart mitten in der Verarbeitung → der Cron-Lauf `/api/cron/reminders` wiederholt mit Backoff (5, 10, 20, 40, 80 min), nach 6 Versuchen `dead` + Hinweis im Posteingang. Status: *Einstellungen → Schnittstellen → Eingehende Ereignisse* und `/api/health/deep` (`webhooks`). Kann ein Ereignis nicht gespeichert werden, antwortet die App 503 (Anbieter stellt erneut zu).
- Nicht zuordenbare SumUp-Zahlungen landen im Posteingang („bitte prüfen“). „Testzahlung simulieren“ ist in Produktion gesperrt, außer `ALLOW_TEST_PAYMENTS=true` (nur reine Testpraxis).

### Adress-Vorschläge (Kundenanlage, Praxisdaten, Pflegeheime)
Beim Tippen in „Straße“ (z. B. `Friedrich-Herder-Str.`) schlägt die App vollständige Adressen vor und füllt PLZ und Ort; eine 5-stellige PLZ ergänzt den Ort, wenn er eindeutig ist. Freie Eingabe bleibt immer möglich.

- **Dienst:** [Photon](https://github.com/komoot/photon) (OpenStreetMap-Geocoder von Komoot, ohne API-Schlüssel, öffentliche Instanz `https://photon.komoot.io` in der EU). Der Browser spricht nur mit der App (`GET /api/adresse/vorschlaege`, nur mit Anmeldung, 60 Anfragen/min je Benutzer:in, 3–120 Zeichen); die App fragt Photon serverseitig an.
- **Übertragen wird nur der eingetippte Adresstext** bzw. die PLZ – nie Namen, Kundennummern oder Gesundheitsdaten, keine Client-IP, keine Cookies; User-Agent `PodoHero/1.0 (+https://podo.algoverdict.com)`. Zielprüfung über `src/integrations/net-guard.ts` (nur https, öffentliche Adresse, keine Weiterleitungen), Zeitlimit 3 s, gleiche Anfragen 10 min im Speicher.
- **Ortsgewichtung:** Die Praxisadresse wird einmal geokodiert und in `organizations.settings.geo` gespeichert (bei Adressänderung neu; Fehlschlag → erneuter Versuch nach 24 h). Suche ist auf Deutschland (bbox) begrenzt.
- **Ausfall:** Ist Photon nicht erreichbar, gibt es einfach keine Vorschläge (Log `address.photon_error`/`address.photon_status`, ohne Suchtext).
- **Abschalten:** `ADDRESS_PROVIDER=off` in `deploy/.env`.
- **Datenschutz-Maximum:** eigene Photon-Instanz (Docker-Image mit Deutschland-Extrakt, ca. 10–20 GB) hinter Caddy mit HTTPS betreiben und `PHOTON_URL=https://photon.example.de` setzen; private/lokale Adressen lehnt net-guard bewusst ab. Die öffentliche Komoot-Instanz ist ein frei zugänglicher Dienst ohne AVV (siehe `docs/legal/UNTERAUFTRAGNEHMER.md`) und hat eine Fair-Use-Grenze.

### Kasse / TSE (KassenSichV)
- **Vor dem ersten echten Bargeld-Einsatz ist ein Vertrag mit einer zertifizierten TSE Pflicht** (z. B. fiskaly SIGN DE), dazu die Meldung der Kasse ans Finanzamt (§ 146a Abs. 4 AO) und die Verfahrensdokumentation.
- Bis dahin signiert ein **Mock** jede Barzahlung nur zum Test (`payments.external_ref = tse:test:…`). Das ersetzt keine TSE.
- fiskaly: `TSE_PROVIDER=fiskaly`, `FISKALY_API_KEY`, `FISKALY_API_SECRET`, `FISKALY_TSS_ID`, `FISKALY_CLIENT_ID`. Fehlen Zugangsdaten, wird die Barzahlung mit „TSE nicht konfiguriert“ abgelehnt.

---

## 9. Gekündigte Praxen endgültig löschen

Praxen beantragen die Löschung unter *Einstellungen → Daten & Kündigung* (`organizations.deletion_requested_at`). Nach 30 Tagen Karenzzeit löscht der Betreiber (Node/pnpm-Umgebung mit Zugriff auf die Datenbank als `podo_owner` und auf die Dateiablage):

```bash
DATABASE_MIGRATION_URL=postgres://podo_owner:…@db/podo STORAGE_DIR=/data/storage pnpm exec tsx scripts/purge-organizations.ts            # Probelauf
DATABASE_MIGRATION_URL=…                                    STORAGE_DIR=/data/storage pnpm exec tsx scripts/purge-organizations.ts --execute  # löschen
```

Nur mit der **Eigentümer-Rolle**: Die Unveränderbarkeits-Trigger werden ausschließlich innerhalb der Lösch-Transaktion (mit exklusiver Tabellensperre) ausgesetzt und vor dem COMMIT wiederhergestellt. Das Skript löscht alle Zeilen der Praxis in FK-sicherer Reihenfolge, Benutzer ohne weitere Mitgliedschaft, das Verzeichnis `<STORAGE_DIR>/<org-id>/` und schreibt `platform.org_purged` ins Audit-Log. In Backups bleiben die Daten bis zum Ablauf der Aufbewahrung (Abschnitt 7).
