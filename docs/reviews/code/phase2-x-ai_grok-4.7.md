# Code-Review (Sicherheit): x-ai/grok-4.7

**Kritisch**

1. `src/server/anamnesis.ts`, `listAnamneses`: Bei `medical.read === false` werden nur `versions[].data` genullt, `select()` auf `patients` liefert aber die ganze Zeile inkl. `riskFlags` (Gesundheitsdaten, Art. 9). Audit nur bei `medical`. Empfang sieht Risikoflags ungeprotokollt. Fix: ohne `medical.read` nur nicht-klinische Spalten selektieren und diesen Zugriff auditieren.

**Hoch**

2. `src/server/prescriptions.ts`, `billingBatchExport`: `lastName`, `firstName`, `remedy`, `interruptionNote`, Positions-Labels u. a. landen roh in den CSV-Zellen. Werte mit `=`, `+`, `-`, `@` sind Formula-Injection (Exfiltration der Versichertennummer/ICD-10 in Excel). Zusätzlich kein `medical.read`/`invoices.*`, anders als `traceBatch`. Fix: Formelzeichen escapen; Recht prüfen, sonst abbrechen.

3. `src/server/prescriptions.ts`, `listPatientPrescriptions` / `listRunningPrescriptions`: voller Patient plus ICD-10, Diagnosegruppe, Verordnung ohne `auth.can("medical.read")`. Fix: Recht erzwingen und Felder minimieren.

4. `src/server/anamnesis.ts`, `submitOnlineAnamnesis`: Es werden nur `granted: true`-Zeilen für angekreuzte `ONLINE_CONSENTS` geschrieben. Abwahl erzeugt keinen Widerruf (`granted: false`); alte Foto-/WhatsApp-/SMS-Einwilligung bleibt wirksam (Art. 7 Abs. 3). `requestMeta` (IP) wird nicht mitgespeichert, keine Hinweisversion. Fix: jeden Typ als aktuellen Stand speichern, Widerruf als neue Zeile, Nachweis (Zeit, IP, Textversion) persistieren.

5. `src/server/card-payments.ts`, `simulateTestPayment`: Bei `port.isMock` läuft `processSumupEvent` → `recordProviderPayment` und bucht echte `payments`, ohne `invoices.write` o. Ä. Fix: Recht prüfen; Testbuchung hart an nicht-produktiven Mandanten koppeln und im Ledger als Test markieren bzw. nicht in `payments` schreiben.

**Mittel**

6. `src/server/anamnesis.ts`, `submitOnlineAnamnesis` vs. `saveAnamnesis`: Online-Daten aktualisieren `patients.riskFlags` nicht; es gibt nur eine Posteingangsnachricht, keine sperrende Aufgabe. Diabetes/Antikoagulation bleiben unsichtbar, bis jemand manuell bestätigt. Fix: Flags in derselben Transaktion setzen oder Behandlung/Termin warnend blocken, bis eine Praxisversion existiert.

7. `src/server/anamnesis.ts`, `publicLinkInfo` / `submitOnlineAnamnesis`: `patients.archivedAt` wird nicht geprüft (Portal prüft das). Archivierte Personen bleiben über den Link erreichbar und beschreibbar. Fix: bei Archiv `null`/`{ok:false}` und Link nicht einlösen.

8. `src/lib/rate-limit.ts`, `limited`: Bei `hits.size > maxKeys` löscht `hits.clear()` alle Zähler. Schlüssel `ip ?? "unbekannt"` (`actions.ts`, `portal/[token]/page.tsx`, `rechnung/[id]/route.ts`) bündelt fehlende IPs in ein Kontingent (Sperre oder gemeinsames Budget). Fix: kein globales Clear; abgelehnte Keys nicht als Frischstart; fehlende IP nicht als gemeinsamen Schlüssel; verteiltes Limit, wenn mehr als eine Instanz läuft (Cron-Route nennt Vercel).

9. `src/server/portal-core.ts`, `createPortalLink`; `src/server/anamnesis.ts`, `createAnamnesisLink`: Widerruf und Insert sind nicht gegen parallele Transaktionen serialisiert. Zwei gleichzeitige Aufrufe ergeben zwei gültige Bearer-Links. Fix: partieller Unique-Index `(organization_id, patient_id, purpose) WHERE revoked_at IS NULL` bzw. Advisory-Lock.

10. `src/server/card-payments.ts`, `createPaymentLink` / Portal-Seite: `res.url` wird ungeprüft gespeichert und als `href` ausgeliefert (`javascript:`/Fremdhost). `sendPaymentLink` prüft E-Mail nicht (anders als `EMAIL_RE` in `sendInvoiceEmail`) — Zeilenumbruch in `to` kann Header-Injection im Adapter werden. Fix: nur `https` und SumUp-Host; Empfänger wie in `sendInvoiceEmail` validieren.

11. `src/app/anamnese/[token]/page.tsx`, `src/app/portal/[token]/page.tsx`: Bearer-Token, Vorname, Leistungsnamen, Rechnungen, Gutscheincodes in der HTML-Antwort; `Referrer-Policy` nur als Metadata-Tag, kein `Cache-Control: private, no-store` (PDF-Route setzt beides). Fix: Response-Header `Cache-Control: private, no-store` und `Referrer-Policy: no-referrer`, `dynamic = "force-dynamic"`.

12. `src/server/webhooks.ts`, `claimWebhookEvent`: Konfliktziel ist nur `(provider, externalId)`, nicht `organizationId`. Falsch zugestellte erste Lieferung blockiert die richtige Praxis dauerhaft (Retry filtert auf `organizationId`). Fix: Unique-Key inkl. Mandant oder Claim nur nach kryptographisch an den Mandanten gebundener Signatur.

**Niedrig**

13. `drizzle/0007_phase2_security.sql`: RLS-Schleife enthält `devices`/`materials`, aber nicht `sterile_batches`, obwohl der Guard-Trigger hier angelegt wird. `patient_links` ist die einzige dokumentierte Ausnahme. Fix: sofern keine frühere Policy existiert, RLS+FORCE und `tenant_isolation` für `sterile_batches` (und `tasks`, falls ebenfalls ohne Policy).

14. `src/server/hygiene.ts`, `adjustStock`: Bestandsänderung ohne Audit und ohne Rollenprüfung. Fix: Recht prüfen und Delta protokollieren.