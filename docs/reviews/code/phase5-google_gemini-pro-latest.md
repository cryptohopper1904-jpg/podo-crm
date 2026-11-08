# Code-Review (Sicherheit): ~google/gemini-pro-latest

Hier sind die gefundenen Sicherheits- und Compliance-Probleme, sortiert nach Schweregrad:

### HOCH

**1. Mandantenübergreifendes Datenleck von Angebotslinks und DSGVO-Verstoß**
* **Datei:** `src/server/waitlist.ts`
* **Stelle:** Zeile 69–72 (`activeOffers`)
* **Problem:** Bei der Abfrage offener Wartelisten-Angebote wird nur auf `purpose = OFFER_PURPOSE` gefiltert. Da für einen Patienten in derselben Praxis mehrere Links (z. B. regulärer Portal-Zugang und Wartelisten-Angebot) existieren können, ist das Verhalten korrekt eingegrenzt. **Allerdings** wird in Zeile 203 (`findOffer`) `db.select(...)` direkt auf `patientLinks` ausgeführt, **ohne** `withOrg` (RLS-Kontext) zu nutzen. Wenn die Datenbank-Connection für `db` RLS nicht erzwingt (oder `app.org_id` aus einem vorherigen Request im Connection-Pool noch gesetzt ist!), schlägt die Abfrage entweder fehl oder prüft im falschen Mandantenkontext. Gleiches gilt für Zeile 149: `await db.update(patientLinks).set({ revokedAt: new Date() })...` läuft außerhalb von `withOrg`. Wenn RLS mit `FORCE ROW LEVEL SECURITY` auf `patient_links` aktiv ist, schlägt dieses Update ohne gesetztes `app.org_id` stillschweigend fehl (0 Rows updated)!
* **Auswirkung:** Fehlgeschlagene Versand-Links (`patientLinks`) werden bei Versandfehlern nicht widerrufen und bleiben gültig; Token-Lookups in `findOffer` schlagen bei aktivem RLS fehl.
* **Fix:** `findOffer` über eine (ggf. Security-Definer) Lookup-Funktion nach `token_hash` auflösen oder für das Update in Zeile 149 zwingend `withOrg(org, (tx) => tx.update(patientLinks)...)` verwenden.

**2. Unvollständige Sperrung von Zahlungen (GoBD-Manipulation durch Zeitzonen/Buchungstag-Lücke)**
* **Datei:** `drizzle/0015_phase5_kasse_security.sql` & `src/server/kasse.ts`
* **Stelle:** SQL Zeile 86–89 & 106–109 (`podo_payment_closing_guard`), TS Zeile 232–234 (`closeDay`)
* **Problem:** In `closeDay` werden alle offenen Zahlungen mit `paidAt <= closedAt` in den Abschluss aufgenommen. Wenn für den 10.05. kein Abschluss gemacht wurde, sondern erst am 12.05., enthält der Abschluss vom 12.05. (`business_date = '2026-05-12'`) auch Zahlungen vom 10.05.
Der DB-Trigger `podo_payment_closing_guard` erlaubt jedoch das **nachträgliche Einfügen (`INSERT`)** oder Ändern nicht zugeordneter Zahlungen mit `paid_at` am 10.05., solange kein Abschluss mit exakt `business_date = '2026-05-10'` existiert (`c.business_date = (NEW.paid_at AT TIME ZONE 'Europe/Berlin')::date`). Es wird auf Gleichheit (`=`) statt auf `<=` geprüft!
* **Auswirkung:** Nach einem Abschluss am 12.05. können rückwirkend Zahlungen für den 10.05. eingefügt oder geändert werden, obwohl dieser Zeitraum buchhalterisch bereits durch den Z-Bon vom 12.05. abgeschlossen ist (Verstoß gegen GoBD/Unveränderbarkeit).
* **Fix:** Im Trigger `podo_payment_closing_guard` (und in `assertPaymentsEditable` in `kasse.ts` Zeile 407) muss `c.business_date >= (OLD.paid_at AT TIME ZONE 'Europe/Berlin')::date` (auch bei `INSERT` für `NEW.paid_at`) geprüft werden.

---

### MITTEL

**3. Fehlerhafter Advisory Lock Schlüssel (Cross-Feature Race Condition)**
* **Datei:** `src/server/kasse.ts` vs. `src/server/portal-booking.ts`
* **Stelle:** `kasse.ts` Zeile 225 (`hashtext(...)`) vs. `portal-booking.ts` Zeile 217 (`hashtextextended(..., 0)`)
* **Problem:** `kasse.ts` nutzt `pg_advisory_xact_lock(hashtext(...))` (32-Bit Integer Lock), während `portal-booking.ts` und `waitlist.ts` `hashtextextended(..., 0)` (64-Bit Bigint Lock) nutzen. Bei 32-Bit `hashtext` liegt die 50%-Kollisionswahrscheinlichkeit (Birthday Bound) bei nur ~77.000 Transaktionen/Mandanten, zudem teilen sich alle 32-Bit-Locks denselben Namensraum.
* **Auswirkung:** Unnötige Lock-Kollisionen zwischen Mandanten beim Tagesabschluss.
* **Fix:** Einheitlich `pg_advisory_xact_lock(hashtextextended(${`cash-closing:${org}`}, 0))` verwenden.

**4. CSV-Injection (Formula Injection) im DSFinV-K Export**
* **Datei:** `src/lib/kasse/dsfinvk.ts`
* **Stelle:** Zeile 241–245 (`quote`)
* **Problem:** Freitextfelder wie `BON_NOTIZ` (`m.reason` oder `differenceReason`), `BEDIENER_NAME` oder `ARTIKELTEXT` werden in CSV-Dateien exportiert. Wenn Betriebsprüfer oder Steuerberater diese CSV-Dateien in Excel öffnen und ein Text mit `=`, `+`, `-` oder `@` beginnt, führt Excel dies trotz Anführungszeichen ggf. als Formel aus.
* **Auswirkung:** Lokale Code-/Formelausführung beim Öffnen der Export-CSVs in Tabellenkalkulationen.
* **Fix:** Falls dies nach DSFinV-K zulässig ist, führende Zeichen `^[=+\-@]` bei Freitextfeldern (insb. `reason`, `note`) bereits bei der Eingabevalidierung (`movementInput`, `closingInput` in `src/server/kasse.ts`) verbieten.

**5. SSRF-Risiko / Datenabfluss über `ERROR_WEBHOOK_URL` und `SENTRY_DSN`**
* **Datei:** `src/lib/error-report.ts`
* **Stelle:** Zeile 43 (`errorSummary(err)`), Zeile 94–100 (`sendErrorReport`)
* **Problem:** `errorMessage` wird an externe Systeme (Sentry/Webhook) gesendet. Drizzle ORM und PostgreSQL schreiben bei Constraint-/Query-Fehlern oft Parameterwerte oder Tabelleninhalte (und damit **Gesundheitsdaten/Patientennamen**) direkt in `err.message`. Auch wenn `scrubText` existiert, ist eine Regex-Filterung auf Freitext-Fehlermeldungen für Art. 9 DSGVO (Gesundheitsdaten) unzureichend.
* **Auswirkung:** Unbeabsichtigter Abfluss von geschützten Gesundheitsdaten (PII/PHI) in externe Monitoring-Systeme über Datenbank-Fehlermeldungen.
* **Fix:** Bei Datenbankfehlern oder unbekannten Fehlern `errorMessage` im externen Report komplett weglassen oder auf eine feste Whitelist bekannter Fehlerklassen (`KasseError`, `EntitlementError`) bzw. nur den PostgreSQL-`SQLSTATE`-Code beschränken.

**6. Vorhersagbarer / unsicherer Lockfile-Pfad in `/tmp`**
* **Datei:** `deploy/update.sh`
* **Stelle:** Zeile 57–58 (`exec 9>"${TMPDIR:-/tmp}/podo-crm-update.lock"`)
* **Problem:** `/tmp` ist world-writable. Wenn `fs.protected_regular` auf dem Host nicht aktiv ist, kann ein unprivilegierter lokaler Nutzer dort vorab einen Symlink oder eine eigene Datei `/tmp/podo-crm-update.lock` anlegen (Symlink-Attacke / Denial of Service gegen Updates).
* **Auswirkung:** Lokale Nutzer können Updates blockieren oder Dateien überschreiben.
* **Fix:** Lockfile in `/run/lock/podo-crm-update.lock` oder direkt in `$APP_DIR/.update.lock` ablegen.

---

### NIEDRIG

**7. Information Disclosure von internen Datei-IDs im DSFinV-K Export**
* **Datei:** `src/lib/kasse/dsfinvk.ts`
* **Stelle:** Zeile 450 (`BEDIENER_ID: b.operator?.id ?? ""`) & `BON_ID: b.bonId`
* **Problem:** Interne User-UUIDs und Payment-UUIDs werden ungehasht an externe Prüfer exportiert. (Für DSFinV-K meist akzeptabel, aber Datenminimierung beachten).
* **Fix:** Optional verkürzte/gehashte Operator-IDs verwenden, sofern konsistent.