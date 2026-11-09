# PodoHero – Gesamt-Review (Stand 09.11.2026, Branch `feature/podohero`, Commit `1c97019`)

Umfang: ganzes System statt Einzelphasen, Schwerpunkt Querschnittsprobleme. Kein Code geändert.

**Methode**
- Eigene Code-Prüfung in fünf Bereichen: Sicherheit, Datenschutz & Recht, Korrektheit, Betrieb, UX.
- Frische Datenbank `gesamt_review` (PostgreSQL 16) mit den Migrationen 0000–0017 aufgebaut und RLS, Policies, Trigger und Fremdschlüssel direkt im Katalog geprüft.
- App gebaut und lokal auf Port 3400 gestartet; Durchlauf mit Playwright/Chromium auf iPad (1024×1366) und iPhone (390×844), Demo-Praxis.
- Externe Reviews der sicherheitskritischen Dateien (ohne Patientendaten) durch vier Modelle: `docs/reviews/code/gesamt-*.md`.
- **Jeder Befund wurde gegen den Code geprüft.** Nicht bestätigte Modell-Befunde stehen in Abschnitt 6.

Die Untersuchungsbereiche liefen nacheinander und nicht als parallele Sub-Agenten, weil in dieser Sitzung kein Agent-Werkzeug verfügbar war.

Legende für die Spalte „früher“: **neu** = bisher nicht erfasst; **teilw.** = eine frühere `*-umsetzung.md` hat einen Teil behoben oder bewusst offen gelassen.

---

## 1. Überblick

| # | Befund | Schwere | früher |
|---|---|---|---|
| K1 | Cloud-init legt auf einer öffentlichen Domain die Demo-Praxis mit bekanntem Inhaber-Passwort an | kritisch | neu |
| H1 | 2FA ist für alle Rollen optional (Art. 32, ASVS L2) | hoch | neu |
| H2 | App-Container erhält die komplette `deploy/.env` inkl. DB-Eigentümer-Passwort und Backup-Passphrase. Damit lassen sich RLS und Append-only-Trigger aushebeln | hoch | neu |
| H3 | Keine Lösch- bzw. Aufbewahrungsfunktion je Patient:in. Die AVV sagt Löschfunktionen zu | hoch | neu |
| H4 | `webhook_events` speichert rohe WhatsApp-/SMS-Inhalte unbegrenzt lange, ohne RLS | hoch | neu |
| H5 | Support-Modus kann Patientendaten massenhaft exportieren (Doctolib-CSV, Art.-15-Export, Medien) | hoch | teilw. (Phase 3: nur Praxis-Export gesperrt) |
| H6 | Support-Audit lässt sich mit dem Header `Purpose: prefetch` umgehen | hoch | teilw. (Phase 4: Prefetch-Ausnahme bewusst eingeführt) |
| H7 | Webhook-Ereignisse (SumUp-Zahlungen, Nachrichten) gehen bei Fehler oder Absturz still verloren | hoch | neu |
| H8 | Website, AVV und Betriebsdoku machen Zusagen, die technisch nicht gedeckt sind | hoch | neu |
| M1 | Öffentliche Buchung `/buchen` prüft serverseitig weder Freigabe noch Leistungsliste, Arbeitszeiten oder Abwesenheiten | mittel | neu |
| M2 | Interne Terminanlage ohne Buchungs-Lock: Doppelbelegung möglich | mittel | neu |
| M3 | TSE-Signatur von Kartenzahlungen innerhalb der DB-Transaktion | mittel | teilw. (Phase 5 #1 nur für Abschlüsse) |
| M4 | CSP ohne `script-src`/`default-src` | mittel | neu |
| M5 | iCal-Feed-Token nicht widerrufbar, abgeleitet vom Hauptschlüssel | mittel | neu (TODO im Code) |
| M6 | Webhook-Token in der URL; veralteter `voice_agent`-Pfad | mittel | neu |
| M7 | Betrieb: Images nicht gepinnt, keine Limits, keine Log-Rotation, Offsite-Backup nicht eingerichtet, Cloud-init ungepinnt | mittel | neu |
| M8 | Layout bricht auf dem iPad im Rechnungsformular und auf dem iPhone in der Website-Kopfzeile | mittel | neu |
| N1–N10 | siehe Abschnitt 4 | niedrig | gemischt |

**Positiv bestätigt**
- **RLS:** Alle 40 Tabellen mit Mandantendaten haben `ENABLE` + `FORCE ROW LEVEL SECURITY` und die Policy `tenant_isolation`. Bei `audit_log` gilt eine eigene Regel, siehe N3.
- **Tabellen ohne RLS:**
  - `patient_links` – bewusst so (0007, Phase 5 #25).
  - `sessions`, `memberships`, `users`, `organizations`, `billing_events`, `news_items`.
  - `webhook_events` – siehe H4.
- **Migrationen 0000–0017** laufen auf einer leeren Datenbank fehlerfrei durch.
- **Unveränderbarkeit:** Trigger für Rechnungen, Dokumentation, Kasse und Audit sind vorhanden. Die USt-Logik (§ 4 Nr. 14 UStG mit Bestätigungspflicht, 19 % kosmetisch) ist korrekt. Die TSE-Aufteilung bei Teilzahlungen ist anteilig (`allocateByVat`).
- **KI-Freigabe:** Die Sperre wirkt auch im Adapter (`src/integrations/llm/openai-compatible.ts:81`).
- **Telefon:** Der KI-Hinweis am Gesprächsbeginn (AI Act Art. 50) ist umgesetzt. Transkripte werden nur mit Opt-in gespeichert.

---

## 2. Kritisch

### K1 Cloud-init: öffentliche Instanz mit Demo-Inhaber und bekanntem Passwort
- **Fundstellen:**
  - `origin/deploy/cloud-init:deploy/cloud/hetzner-user-data.sh:6,32` (`DOMAIN=podo.algoverdict.com`, `SEED_DEMO=true`)
  - `scripts/seed-demo.ts:40-41` (Inhaber `demo@podocrm.local` / `demo-passwort-123`, ohne 2FA)
- **Abweichung von `install.sh`:** `deploy/install.sh:44` aktiviert die Demo absichtlich **nur** bei Installation auf eine IP-Adresse. Das cloud-init-Skript hebelt diese Schutzregel aus.
- **Auswirkung:** Jede Person im Internet kann sich als Inhaber:in anmelden. Damit sind möglich:
  - Vollexport (`/api/export/praxis`)
  - Anlegen von Konten (`users.manage`)
  - Ändern der Schnittstellen-Konfiguration, z. B. eigene Webhook-Tokens oder SMTP-Server

  Werden auf dieser „Testinstanz“ später echte Daten erfasst – laut Kommentar soll es ein Testbetrieb sein, die Domain wirkt aber produktiv –, liegt eine Datenpanne nach Art. 33 DSGVO vor.
- **Fix:**
  1. Im cloud-init `SEED_DEMO=false` setzen.
  2. Falls eine Demo gewünscht ist: zufälliges Demo-Passwort erzeugen und nur ins root-Log schreiben, dazu `ALLOW_SIGNUP=false` und deutlicher Hinweis „Demo“ in der App.
  3. `seed-demo.ts` in Produktion (`NODE_ENV=production` + Domain) verweigern, wenn kein `DEMO_PASSWORD` gesetzt ist.
  4. Vor dem Merge des Branches `deploy/cloud-init` prüfen, ob die Instanz bereits läuft. Wenn ja: Demo-Konto sofort deaktivieren.

---

## 3. Hoch

### H1 2FA optional für alle Rollen
- **Fundstellen:**
  - `src/app/(auth)/actions.ts:61-63` – die Sitzung gilt sofort als bestätigt, wenn `totpEnabled=false`
  - `src/app/(app)/einstellungen/actions.ts:158-176` – 2FA nur freiwillig, keine Wiederherstellungscodes
- **Auswirkung:**
  - Ein Passwort reicht für Zugriff auf Art.-9-Daten aller Patient:innen. Rate-Limit und Kontosperre helfen gegen Credential-Stuffing nur begrenzt.
  - Erfüllt weder ASVS L2 (V2.2/V2.7) noch den Stand der Technik nach Art. 32 DSGVO für Gesundheitsdaten.
  - Bei Support-Admins ist 2FA Pflicht, bei Praxisinhaber:innen nicht – inkonsistent.
- **Fix:**
  - 2FA für Rollen mit `medical.read`, `users.manage` oder `cash.export` erzwingen. Nach dem Login ohne 2FA nur `/einstellungen/sicherheit` erlauben (Schonfrist z. B. 7 Tage).
  - Wiederherstellungscodes anbieten.
  - Ablauf zum Zurücksetzen durch Inhaber:in bzw. Betreiber definieren, mit Audit.

### H2 App-Container mit allen Betriebsgeheimnissen
- **Fundstellen:**
  - `deploy/docker-compose.yml:34` – `env_file: .env` an den Dienst `app`
  - `.env` enthält `DB_OWNER_PASSWORD`, `BACKUP_PASSPHRASE`, `SETUP_TOKEN` (`install.sh`, cloud-init `:23-29`)
- **Auswirkung:** Eine Codeausführung oder ein Leck von Umgebungsvariablen in der App (z. B. Fehlerbericht, `/proc/self/environ` über eine Abhängigkeit) liefert das Passwort des **Tabelleneigentümers**. Der Eigentümer kann:
  - `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` ausführen
  - `DISABLE TRIGGER` ausführen – `purge-organization.ts:188` nutzt genau das

  Damit fallen die Mandantentrennung (RLS mit `podo_app NOBYPASSRLS`) und die Unveränderbarkeit (GoBD, § 630f BGB, KassenSichV), auf denen das Sicherheitskonzept aufbaut. Zusätzlich sind mit der Backup-Passphrase auch Offsite-Kopien lesbar.
- **Fix:**
  - Getrennte Env-Dateien: `app.env` nur mit `DATABASE_URL` (podo_app), `APP_ENCRYPTION_KEY`, `CRON_SECRET`, `HEALTH_TOKEN`, `PUBLIC_URL` und den Integrations-Einstellungen.
  - Eigentümer-Passwort nur für `db`, `migrate` und `backup`.
  - Backup-Passphrase nur für `backup`.
  - Optional: Docker-Secrets.

### H3 Keine Löschung oder Aufbewahrungssteuerung je Patient:in
- **Fundstellen:**
  - `src/app/(app)/kunden/actions.ts:74-80` – nur Archivieren
  - Fremdschlüssel `treatment_records`, `invoices` und `media` → `patients` sind `RESTRICT`
  - Trigger `podo_forbid_change` auf `treatment_records`, `anamneses` und `consents`
  - Zusage in `docs/legal/AVV.md:57` („Sperr-/Löschfunktionen“)
- **Auswirkung:**
  - Nach Ablauf von § 630f Abs. 3 BGB (10 Jahre) bzw. § 147 AO lässt sich nicht löschen. Verstoß gegen Art. 5 Abs. 1 lit. e und Art. 17 DSGVO.
  - Auch Personen **ohne** Dokumentationspflicht lassen sich nicht löschen, z. B. reine Online-Anfragen, Warteliste oder Einwilligungs-Widerruf für Marketingfotos (`media.purpose = 'marketing'`).
  - Die AVV-Zusage ist damit unzutreffend.
- **Fix:**
  - Löschfunktion nur für Inhaber:in mit Vier-Augen-Bestätigung und Audit. Sie prüft die Fristen anhand der letzten Behandlung bzw. Rechnung; Abfolge wie `purge-organization` (kontrolliert, im Eigentümer-Kontext).
  - Sofort-Löschung für Personen ohne Dokumentation und Rechnungen.
  - Monatlicher Fristen-Report „löschreif“.
  - Medien mit Zweck `marketing` bei Widerruf der Einwilligung löschen.

### H4 `webhook_events`: Rohdaten unbegrenzt, ohne RLS
- **Fundstellen:**
  - `src/app/api/webhooks/[provider]/route.ts:133` → `src/server/webhooks.ts:26` speichert `payload` vollständig
  - Die Tabelle hat keine RLS (Katalog geprüft)
  - Keine Löschung (`grep`: keine Lösch- oder Aufräumlogik)
  - Vom Praxisexport ausgenommen (`src/lib/practice-export.ts:10`)
- **Auswirkung:**
  - WhatsApp- und SMS-Inhalte samt Telefonnummern liegen dauerhaft neben der eigentlichen Nachricht in `messages`.
  - Nach Archivierung oder Löschung der Nachricht bleiben die Daten erhalten. Die Praxis kann sie weder einsehen noch exportieren (Art. 15/20) noch löschen.
  - Ein Fehler in einer Abfrage ohne Mandantenfilter würde diese Daten mandantenübergreifend zeigen.
- **Fix:**
  - Nur `externalId`, Hash, Status und Fehlertext speichern; `payload` höchstens bis zur erfolgreichen Verarbeitung, danach `NULL`.
  - Aufräum-Cron nach 30 Tagen.
  - RLS mit `tenant_isolation`; der Webhook-Pfad arbeitet ohnehin mit bekannter `org`.

### H5 Support-Modus: Massen-Export möglich
- **Fundstellen:**
  - `src/lib/auth/access.ts:33` – Support erhält alle `*.read`-Rechte
  - `src/app/api/export/doctolib/route.ts:12-13` – alle Patient:innen mit Name, Geburtsdatum, Anschrift und Telefon als CSV
  - `src/app/api/patients/[id]/export/route.ts:13` – vollständige Akte als JSON
  - `src/app/api/media/[id]/route.ts:13` – Fotos
  - Keine dieser Routen prüft `auth.support`.
- **Auswirkung:** Phase 3 hat entschieden, dass Support keinen Vollexport erhält (`export/praxis/route.ts:15`). Über die Doctolib-CSV und den Art.-15-Export je Person bekommt der Betreiber dennoch die Stammdaten aller Patient:innen bzw. komplette Akten als Datei. Das widerspricht dem Zweck „Break-Glass zur Fehlersuche“ (§ 203 Abs. 3 StGB: Offenbarung nur, soweit erforderlich).
- **Fix:**
  - In allen Download-, Export- und Medien-Routen `if (auth.support) return 403` – außer explizit benötigter Einzelansicht.
  - Einfacher wartbar: eigene Rechte `export.*`, die `effectiveCan` für Support nie gewährt (endet nicht auf `.read`).

### H6 Support-Audit lässt sich per Header abschalten
- **Fundstellen:**
  - `src/lib/auth/support-view.ts:29,47-49` – `isPrefetch` wertet die vom Client frei setzbaren Header `purpose` und `sec-purpose` aus
  - `src/lib/auth/session.ts:156,224`
  - `src/proxy.ts:13-17` überschreibt diese Header nicht
- **Auswirkung:** Ein Support-Admin schickt `Purpose: prefetch` mit. Dann entsteht für Seitenaufrufe kein `support.view` mehr. Fachliche Audit-Einträge (`patient.read`, `media.read`) gibt es nur dort, wo eigens protokolliert wird. Die Rechenschaftspflicht nach Art. 5 Abs. 2 DSGVO und die Kontrolle durch die Praxis sind damit umgehbar.
- **Fix:**
  - Nur echte RSC-Prefetches ausnehmen (`RSC: 1` **und** `next-router-prefetch: 1`), nie für `/api/*`.
  - Alternativ immer protokollieren; die 60-s-Entprellung reicht gegen Log-Flut.
- **Hinweis:** Gemini hat diesen Befund gemeldet, er ist bestätigt.

### H7 Webhook-Ereignisse gehen still verloren
- **Fundstellen:**
  - `src/app/api/webhooks/[provider]/route.ts:137-162` – sofort `200`, Verarbeitung in `after()`
  - `src/server/webhooks.ts:30-41` – erneute Übernahme nur bei `error IS NOT NULL`
  - Kein Wiederholungslauf
- **Auswirkung:**
  - Stürzt der Prozess zwischen Übernahme und `finishWebhookEvent` ab, etwa bei einem Neustart durch `update.sh`, bleibt das Ereignis ohne Fehler und ohne Erledigt-Status liegen und kann nie wieder übernommen werden.
  - Bei Verarbeitungsfehlern hat der Anbieter schon `200` bekommen und stellt nicht erneut zu.
  - Folge: SumUp-Kartenzahlungen werden nicht gebucht. Die Rechnung bleibt „offen“ – mit Mahnungen an Patient:innen trotz Zahlung – und die Kasse stimmt nicht. Eingehende Nachrichten fehlen. Sichtbar ist das nur im Sync-Protokoll.
- **Fix:**
  - Outbox-Spalten `status`, `attempts`, `lease_until`.
  - Cron (`/api/cron/reminders` oder eigener Lauf) verarbeitet Ereignisse mit `processed_at IS NULL AND (error IS NOT NULL OR lease_until < now())` erneut.
  - Nach N Fehlversuchen Eintrag im Posteingang.
  - Health-Check `/api/health/deep` um „unverarbeitete Webhooks > 1 h“ ergänzen.
- **Hinweis:** GPT hat diesen Befund gemeldet, er ist bestätigt.

### H8 Zusagen ohne technische Deckung
| Fundstelle | Zusage | Realität |
|---|---|---|
| `src/app/(public)/sicherheit/page.tsx:12-13` | „läuft auf Servern in Deutschland … Keine US-Cloud für Praxisdaten“ | Der Standort wird nirgends erzwungen. Cloud-init nennt „Hetzner/Hostinger“; Hetzner bietet auch Helsinki und die USA an. In `docs/legal/UNTERAUFTRAGNEHMER.md` stehen nur Platzhalter. Telefon-Anbieter (Vapi/Retell, USA), Google Business (USA) und WhatsApp (Meta) sind integrierbar. |
| `docs/BETRIEB.md:240` | „Server-Admins sehen keine Fotos im Klartext“ | Falsch: `APP_ENCRYPTION_KEY` steht in `deploy/.env` auf demselben Server. Siehe auch H2. |
| `docs/legal/AVV.md:57` | „Sperr-/Löschfunktionen“ | Gibt es nicht (H3). |
| `sicherheit/page.tsx:13`, `AVV.md:70` | „Datensicherungen … verschlüsselt, rollierend 14 Tage“ | Nur lokal im Volume `backups` auf demselben Server. Offsite gibt es nur als `offsite-backup.example.sh`; `BETRIEB.md:146` nennt es „Pflicht“, eingerichtet wird es nicht. |

- **Auswirkung:** Irreführende Angaben (UWG §§ 5, 5a), unzutreffende TOM-Beschreibung in der AVV (Art. 28 Abs. 3 lit. c / Art. 32) und Haftungsrisiko gegenüber Praxen.
- **Fix:**
  - Texte an den Ist-Zustand anpassen, z. B. „Rechenzentrum in Deutschland (Hetzner Falkenstein/Nürnberg)“ nur, wenn vertraglich und technisch festgelegt.
  - Standort im Installationsskript/Provisioning festschreiben.
  - BETRIEB.md:240 korrigieren.
  - Offsite-Backup in `install.sh` verpflichtend abfragen.

---

## 4. Mittel

### M1 Öffentliche Buchung prüft serverseitig zu wenig
- **Fundstellen:**
  - `src/app/buchen/[slug]/actions.ts:41-62` – keine Prüfung von `onlineBooking.enabled`, der `serviceCodes`-Liste, Wochenende/Feiertag/Öffnungszeit, `working_hours`/`absences` oder einem Höchst-Vorlauf
  - `src/app/buchen/[slug]/page.tsx:40-46` – die Slot-Anzeige berücksichtigt nur Mo–Fr, Feiertage und `settings.opening`, ignoriert also **Arbeitszeiten und Urlaub**
- **Vergleich:** Portal-Buchung (`server/portal-booking.ts`, `computeAvailability`) und Telefonbuchung (`server/voice.ts:250-263`, Slot muss angeboten sein) prüfen das korrekt.
- **Auswirkung:**
  - Online-Termine landen im Praxisurlaub.
  - Eine präparierte POST-Anfrage kann trotz deaktivierter Online-Buchung Termine zu beliebigen Zeiten anlegen, z. B. sonntags um 3 Uhr oder in 5 Jahren, auch für nicht freigegebene Leistungen.
- **Fix:** Dieselbe Verfügbarkeitsfunktion wie Portal und Telefon nutzen und den Slot im Lock gegen die angebotenen Slots prüfen; Freigabe und Leistungsliste serverseitig prüfen.

### M2 Interne Terminanlage ohne Buchungs-Lock
- **Fundstelle:** `src/app/(app)/kalender/actions.ts:48-73` – `findConflicts` läuft außerhalb der Transaktion und ohne `pg_advisory_xact_lock(hashtextextended('book:'||org))`. Alle anderen Schreibpfade verwenden diesen Lock (buchen, portal-booking, voice, waitlist).
- **Auswirkung:** Doppelbelegung, wenn gleichzeitig eine Online-, Portal-, Telefon- oder Wartelisten-Buchung eingeht.
- **Fix:** Konfliktprüfung und Insert in einer Transaktion unter demselben Lock. Langfristig ein Exclusion-Constraint je Behandler:in (`tstzrange`, `btree_gist`).

### M3 TSE-Signatur von Kartenzahlungen in der DB-Transaktion
- **Fundstelle:** `src/server/webhooks.ts:118-142` – `signRegisterPayment` (externe Meldung an fiskaly) läuft vor Insert und Commit.
- **Auswirkung:**
  - Bei Rollback (Constraint, Commit-Fehler) existiert eine TSE-Transaktion ohne Zahlung.
  - Bei erneuter Zustellung wird mit neuer `paymentId` ein zweites Mal signiert, was die DSFinV-K verfälscht.
  - Für Tagesabschlüsse hat Phase 5 #1 genau dieses Problem behoben, für Zahlungen nicht.
- **Fix:** Zahlung mit Kennzeichen „Signatur ausstehend“ committen, danach idempotent über die Zahlungs-ID signieren und das Ergebnis append-only in `fiscal_transactions` speichern (wie bei `cash_closing_registrations`).

### M4 CSP ohne Skript-Richtlinie
- **Fundstelle:** `next.config.ts:5` – nur `frame-ancestors`, `base-uri`, `form-action`, `object-src`.
- **Auswirkung:** Gegen XSS gibt es keine zweite Verteidigungslinie. React-Escaping ist der einzige Schutz, z. B. bei `dangerouslySetInnerHTML` in `hygiene/charge/[code]/etikett/page.tsx:50` und `layout.tsx:29`.
- **Fix:** Nonce-basierte CSP im Proxy (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `default-src 'self'`, `connect-src 'self'`, `img-src 'self' blob: data:`). Siehe Next-16-Doku `node_modules/next/dist/docs/` zu CSP/Nonces.

### M5 iCal-Token nicht widerrufbar
- **Fundstelle:** `src/lib/calendar-token.ts:5-14` – HMAC(userId) mit `APP_ENCRYPTION_KEY`, ohne Version und ohne Ablauf (TODO im Code).
- **Auswirkung:**
  - Eine geleakte Feed-URL (geteilter Kalender, Kalender-Synchronisationsdienst) zeigt dauerhaft Initialen, Uhrzeiten und Leistungskürzel.
  - Widerruf ist nur über eine Rotation des Hauptschlüssels möglich, die alle Fotos unlesbar macht.
  - Der Schlüssel dient doppelt (Verschlüsselung und MAC).
- **Fix:** Zufallstoken je Benutzer:in, gehasht gespeichert, mit Schaltfläche „Link neu erzeugen“. Mindestens: HKDF-Unterschlüssel und `users.calendar_token_version`.

### M6 Webhook-Token in der URL, veralteter Telefon-Pfad
- **Fundstelle:** `src/app/api/webhooks/[provider]/route.ts:29,110` – `?token=` für lexoffice/SMS/`voice_agent`.
- **Auswirkung:**
  - Das Token kann in Logs von Proxys und Anbietern landen.
  - Der Anbieter `voice_agent` existiert hier doppelt neben `/api/voice/[provider]`. `handleVoiceAgentWebhook` verwirft das Ergebnis, speichert die Rohdaten aber in `webhook_events` (siehe H4).
- **Fix:** `voice_agent` aus `PROVIDERS` entfernen. Token als Header oder HMAC mit Zeitstempel, Übergangsfrist.
- **Hinweis:** Von allen Modellen gemeldet.

### M7 Betrieb
- **`deploy/docker-compose.yml`:**
  - Images ungepinnt (`postgres:16-alpine`, `caddy:2-alpine`, `alpine:3.20`).
  - `apk add` bei jedem Containerstart (`:82`, `:101`). Ohne Netz kein Backup, und jede Installation zieht ungeprüfte Pakete (Lieferkette).
  - Keine `mem_limit`/`cpus`. Ein Praxis-Export oder ein OCR-Lauf kann die Datenbank aushungern.
  - Kein `logging: max-size`; Docker-JSON-Logs wachsen unbegrenzt und können die Platte füllen.
  - Das erste Backup läuft beim Start, danach `sleep 86400`; nach jedem Update verschiebt sich der Zeitpunkt.
- **Cloud-init (`hetzner-user-data.sh`):**
  - `curl https://get.docker.com | sh` (`:12`).
  - `git clone` des Standard-Branches ohne Tag oder Commit (`:14`).
  - Keine `unattended-upgrades`, keine SSH-Härtung (Passwort-Login, fail2ban).
- **Offsite-Backup:** nicht automatisiert (H8).
- **Fix:**
  - Images per Digest pinnen; eigenes Backup-Image mit gnupg und curl.
  - `deploy.resources.limits` und `logging.options.max-size: 10m`.
  - Zeitplan per `crond` statt `sleep`.
  - Cloud-init auf einen Release-Tag festlegen; `unattended-upgrades` und `PasswordAuthentication no`.

### M8 Layout auf iPad und iPhone (Playwright, Screenshots im Scratchpad)
- **`/rechnungen/neu` auf dem iPad (1024 px, Hochformat):**
  - Die Seite ist 1149 px breit, es gibt horizontales Scrollen.
  - Die Spalte **USt** der Positionen ist abgeschnitten.
  - „Kunde suchen“, „bitte wählen“ und das Datum sind abgeschnitten („11/“).
- **Website-Kopfzeile auf dem iPhone (`/sicherheit` u. a.):** 543 px statt 390 px; der Button „Kostenlos …“ ragt aus dem Bild.
- **`/kasse` auf dem iPhone:** Die Tabelle „Zahlungen seit dem letzten Abschluss“ ist rechts abgeschnitten (Spalte „Zahlart“), ohne erkennbaren Scroll-Hinweis.
- **Fix:**
  - Positionszeilen ab < 1100 px zweizeilig bzw. als Karten.
  - Kopfzeile mit Menü-Button.
  - Tabellen mit `overflow-x-auto` und sichtbarem Verlauf, auf dem iPhone als Kartenliste.

---

## 5. Niedrig

| # | Befund | Fundstelle | Fix |
|---|---|---|---|
| N1 | 13 Advisory-Locks noch mit 32-Bit-`hashtext`. Folge: nur falsche Serialisierung, aber inkonsistent zur Entscheidung aus Phase 3/5 (#26) | `src/server/records.ts:41`, `portal-core.ts:62`, `invoices.ts:177`, `anamnesis.ts:74`, `kunden/actions.ts:50` u. a. | einheitlich `hashtextextended(…, 0)` |
| N2 | `buildPracticeExport`, `zBonPdfForOrg`, `listSupportAdmins` ohne `AuthContext`. Die Routen prüfen, es fehlt nur die zweite Sicherung. GPT, Gemini und Mistral stuften das als kritisch/hoch ein; herabgestuft, weil kein erreichbarer Pfad existiert | `src/server/practice-export.ts:49`, `src/server/kasse.ts:539`, `src/server/support.ts:43` | `auth` übergeben, `assertCan` bzw. `ownerOnly` |
| N3 | Policy `audit_insert` mit `WITH CHECK (true)`: Einträge für fremde `organization_id` möglich, damit Audit-Log fälschbar | Policy auf `audit_log` (Katalog) | `WITH CHECK (organization_id IS NULL OR organization_id = current_setting('app.org_id')::uuid)` mit Ausnahme für Login-Ereignisse |
| N4 | Nur absolute Sitzungsdauer 12 h, kein Leerlauf-Timeout. Am geteilten iPad am Stuhl bleibt die Akte offen | `src/lib/auth/session.ts:18,42` | Sperrbildschirm/Leerlauf 15–30 min (PIN zum Entsperren) |
| N5 | Kein Reset- oder Wiederherstellungsweg für 2FA; Aktivierung ohne Passwortbestätigung; Deaktivierung nicht vorgesehen | `src/app/(app)/einstellungen/actions.ts:158-176` | Wiederherstellungscodes, Re-Auth, Audit `2fa.disabled` |
| N6 | `pickActiveGrant` nimmt immer die am längsten gültige Freigabe. Eine neue, engere Freigabe (`read`) wird von einer älteren `write`-Freigabe überdeckt | `src/lib/auth/access.ts:68-73` | beim Anlegen frühere Freigaben derselben Person widerrufen |
| N7 | Telefon-Agent (Vapi): statisches Geheimnis ohne Zeitstempel → Replay möglich. Die Buchung ist aber je `externalId` idempotent | `src/app/api/voice/[provider]/route.ts:73`, `src/server/voice.ts:258-262` | Vapi-HMAC, sobald verfügbar; Tool-Call-ID deduplizieren |
| N8 | Login wählt bei mehreren Praxen eine beliebige Mitgliedschaft (ohne `orderBy`) | `src/app/(auth)/actions.ts:55-59` | zuletzt genutzte Praxis merken |
| N9 | Medien-Upload liest `formData()` ohne vorherige Prüfung der Content-Length (Speicher) | `src/app/api/media/route.ts:23` | Content-Length prüfen wie bei `voice-report` |
| N10 | UX/Barrierefreiheit (siehe unten) | – | – |
| N11 | Ende einer Support-Freigabe: `getAuth` hängt die Sitzung per `UPDATE` ohne Token-Rotation auf eine beliebige eigene Mitgliedschaft um (`limit(1)` ohne Reihenfolge). `enterSupport`/`exitSupport` rotieren dagegen (Grok) | `src/lib/auth/session.ts:209-217` | `rotateSession` verwenden bzw. Sitzung beenden |
| N12 | `assertPaymentsEditable` ist definiert, wird aber nirgends aufgerufen. Phase 5 #6 nennt es als Absicherung. Der DB-Trigger `payments_closing_guard` schützt trotzdem; verspätete Webhook-Zahlungen fallen bewusst in den nächsten Abschluss (Phase-5-Entscheidung) | `src/server/kasse.ts:637` | aufrufen oder entfernen, Z-Bon-Kennzeichnung „Nachbuchung“ prüfen |
| N13 | `invoices.checkout_ref` nicht eindeutig; `recordProviderPayment` nimmt `limit(1)` ohne Reihenfolge (Grok) | `src/server/webhooks.ts:101-104` | Unique-Index (partiell, nicht NULL) |
| N14 | `exitSupport` übernimmt `fromOrganizationId` vom Aufrufer für das Audit (Grok) | `src/server/support.ts:149-156` | Praxis aus der Sitzungszeile lesen |

**Details zu N10 (UX/Barrierefreiheit, iPad und iPhone):**
- **Touch-Ziele unter 44 px:**
  - Checkliste „Praxis einrichten“ auf `/heute`: Links 17 px hoch.
  - Namen in `/kunden`: 19 px hoch, die Zeile ist nicht als Ganzes klickbar.
  - Checkboxen 13–20 px (Anamnese-Risiken Diabetes/pAVK/Antikoagulation, USt-Wächter, Kasse „Bestand gezählt“).
  - Messpunkte im 2D-Fußschema ca. 20 px.
- **Fußschema:** Kürzel ohne Legende (N1–N5, Z1, „Z25“, „MT25“, MF, LR, FE, FR, DR). „Z25“/„MT25“ ist vermutlich als „Z2–5“/„MT2–5“ gemeint.
- **Kanalnamen:** auf `/heute` klein und nicht übersetzt („email · 22:02“, „whatsapp“). Besser „E-Mail“, „WhatsApp“.
- **Akte:** Stift-Button ohne zugänglichen Namen (`aria-label="Bearbeiten"`).
- **Funktioniert gut:** deutsche Texte durchgängig, keine Konsolenfehler, Ladezeiten < 1,1 s, untere Navigation auf dem iPhone, Doku-Formular mit Foto-Metadaten (Seite/Zehe/Ansicht) und klarem Hinweis auf Unveränderbarkeit.

---

## 6. Nicht bestätigte bzw. bereits erledigte Modell-Befunde

| Quelle | Behauptung | Ergebnis |
|---|---|---|
| Grok (hoch) | Token-Webhooks nicht fail-closed bei fehlendem Geheimnis | **falsch** – `safeEqual` gibt bei leerem Wert `false` zurück (`src/lib/safe-equal.ts:5`) |
| Grok (hoch) | `voice_agent` im generischen Webhook ohne `await` und ohne Mandant | zutreffend, aber wirkungslos (der Parser verwirft das Ergebnis) → unter M6: Pfad entfernen |
| Grok (kritisch) | TSE-USt bei Teilzahlung falsch | **falsch**, wie bei GPT (siehe nächste Zeile) |
| GPT (hoch) | TSE-USt-Gruppen bei Teilzahlung falsch | **falsch** – `src/server/fiscal.ts:34` verteilt mit `allocateByVat(amountCents, vatGroups)` anteilig |
| GPT, Mistral | Alte Support-Freigaben ohne Person | **bereits entschieden** (Phase 3/4: laufen bis zum Ablauf, max. 72 h; neue Freigaben brauchen eine Person, `support.ts:26`) – inzwischen gegenstandslos |
| GPT (kritisch), Gemini/Mistral (hoch) | Praxis-Export ohne Autorisierung | Route prüft `owner` und `!support` → nur Defense-in-Depth, siehe N2 |
| Mistral (mittel) | `bodyHash` als Idempotenzschlüssel verwirft legitime Nachrichten | **nein** – Anbieter-Payloads enthalten Nachrichten-ID und Zeitstempel; gleicher Body ist ein echtes Duplikat |
| Mistral (mittel) | Portal-Token in der URL | **bereits behandelt** (Phase 5 #27: Tausch gegen Cookie, `no-referrer`, `no-store`) |
| Mistral (hoch) | Brute-Force auf `?token=` | **nein** – Zufallstoken, zeitkonstanter Vergleich; übrig bleibt nur das URL-Leck (M6) |
| Gemini (mittel) | Redirect-Schleife bei deaktivierter Mitgliedschaft | **nein** – `/login` zeigt das Formular, wenn `getAuth()` null ist (`login/page.tsx:12`) |
| Gemini (mittel) | Praxis-Export nicht in einem Snapshot | zutreffend, aber gering: Export ist ein Rückgabe-/Portabilitätsexport, kein GoBD-Archiv; optional `REPEATABLE READ` |
| eigener Verdacht | Antwortvorschläge im Posteingang ohne KI-Freigabe | **nein** – Adapter erzwingt die Freigabe (`openai-compatible.ts:81`) |
| GPT, Gemini | Replay am Telefon-Webhook (hoch) | herabgestuft auf niedrig (N7), Buchung ist idempotent |

---

## 7. Empfohlene Reihenfolge
1. **Sofort:** K1 – Demo auf der öffentlichen Instanz abschalten. Dann H2 (Env-Trennung) und H5/H6 (Support-Export und Audit).
2. **Vor erster echter Praxis:** H1, H7, H8 (Texte, Standort, Offsite-Backup), M1–M3, M7.
3. **Vor Ablauf der ersten Aufbewahrungsfristen bzw. erstem Löschantrag:** H3 und H4 (Löschkonzept).
4. **Laufend:** M4–M6, M8, N1–N10.
