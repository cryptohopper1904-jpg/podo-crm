# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Kritisch

1. **Unauthentifizierte Webhooks werden akzeptiert**  
   **Datei/Stelle:** `src/app/api/webhooks/[provider]/route.ts`, Signaturprüfungen mit `&& secret.webhookSecret` bzw. `&& secret.appSecret`; für `lexoffice`, `sms` und `voice_agent` fehlt jede Prüfung.  
   **Auswirkung:** Fehlt das Secret oder die Verbindung vollständig, kann jeder mit einer Mandanten-UUID Ereignisse einspeisen. Bei WhatsApp/SMS entstehen fremde Patientennachrichten; zudem können gefälschte `externalId`s echte Ereignisse durch die Idempotenzprüfung verdrängen.  
   **Fix:** Webhook ohne aktive Verbindung und erforderliches Secret mit `401/503` ablehnen. Für jeden Provider dessen dokumentierte Signatur bzw. ein mandantenspezifisches, kryptographisch zufälliges Webhook-Secret zwingend prüfen; kein Fail-open.

2. **Größenlimit schützt nicht vor unauthentifiziertem Memory-DoS**  
   **Datei/Stelle:** `src/app/api/webhooks/[provider]/route.ts`, `const rawBody = await req.text()` vor `rawBody.length > 512_000`.  
   **Auswirkung:** Der komplette, beliebig große Request wird bereits in den Speicher geladen, bevor das Limit greift. Der öffentliche Endpunkt kann Worker durch große oder parallele Bodies erschöpfen.  
   **Fix:** `Content-Length` vor dem Lesen prüfen und den Body streaming-basiert hart auf 512 KB begrenzen; zusätzlich ein Request-Body-Limit auf Proxy/Runtime-Ebene setzen.

## Hoch

3. **Fehlgeschlagene Webhooks werden dauerhaft als Duplikat verworfen**  
   **Datei/Stelle:** `src/app/api/webhooks/[provider]/route.ts`, `storeWebhookEvent(...)`; bei Verarbeitungsfehler nur `finishWebhookEvent(..., error)`, spätere Zustellung erhält wegen `!eventId` sofort `{ duplicate: true }`.  
   **Auswirkung:** Temporäre DB-/Providerfehler führen dauerhaft zu verlorenen Zahlungen oder Nachrichten, obwohl der Provider erneut zustellt.  
   **Fix:** Nur erfolgreich abgeschlossene Events endgültig deduplizieren. Fehlgeschlagene Events atomar erneut reservieren oder in eine persistente Queue mit Retry/Backoff und Dead-Letter-Status überführen.

4. **Öffentliche Buchung kann bestehende Patientenakte und Einwilligungen manipulieren**  
   **Datei/Stelle:** `src/app/buchen/[slug]/actions.ts`, Zuordnung über Nachname plus passende Telefonnummer **oder** E-Mail; anschließend Einträge in `appointments`, `consents` und `messages`.  
   **Auswirkung:** Kennt jemand Nachname und Telefonnummer/E-Mail, kann er Termine und Notizen einer bestehenden Patientenakte hinzufügen und zwei Einwilligungen als `granted: true` protokollieren, ohne Identitätsnachweis.  
   **Fix:** Bestehende Patienten nur nach OTP-Verifikation des bereits gespeicherten Kommunikationskanals verknüpfen. Bis dahin separaten Buchungs-/Lead-Datensatz anlegen; Einwilligungen erst der verifizierten Person zuordnen.

5. **Parallele Buchungen können denselben Termin mehrfach belegen**  
   **Datei/Stelle:** `src/app/buchen/[slug]/actions.ts`, getrennte `SELECT`-Kollisionsprüfung und anschließender `INSERT`.  
   **Auswirkung:** Zwei Transaktionen können gleichzeitig keine Kollision sehen und beide Termine einfügen.  
   **Fix:** PostgreSQL-Exclusion-Constraint auf Ressource/Therapeut und `tstzrange(starts_at, ends_at, '[)')` für nicht stornierte Termine; Constraint-Verletzung als „bereits vergeben“ behandeln.

6. **Antworten können mehrfach extern versendet werden**  
   **Datei/Stelle:** `src/app/(app)/posteingang/actions.ts`, `port.send(...)` erfolgt vor Speicherung/Statusänderung und ohne Idempotenzsperre.  
   **Auswirkung:** Doppelklicks, parallele Requests oder ein DB-Fehler nach erfolgreichem Versand erzeugen doppelte Nachrichten; bei Gesundheitsbezug vervielfacht das die Offenlegung.  
   **Fix:** Persistente Outbox mit eindeutiger Idempotency-ID verwenden; Nachricht vor Versand atomar auf `sending` setzen und nur einen Worker versenden lassen.

## Mittel

7. **Vorschaupflicht beim Import ist clientseitig umgehbar**  
   **Datei/Stelle:** `src/app/(app)/einstellungen/import/actions.ts`, Vergleich `form.get("hash") !== up.hash` in beiden Importaktionen.  
   **Auswirkung:** Ein Nutzer mit `import.run` kann SHA-256 selbst berechnen und direkt `intent=run` senden, ohne die vorgesehene Prüfung/Warnungen zu sehen.  
   **Fix:** Nach der Vorschau serverseitig einen kurzlebigen, einmaligen Datensatz oder signierten Token erzeugen, gebunden an Hash, Organisation, Benutzer und Importtyp.

8. **Doctolib-Import vergibt Patientennummern nicht konkurenzsicher**  
   **Datei/Stelle:** `src/app/(app)/einstellungen/import/actions.ts`, `max(patients.number) + 1` ohne Lock.  
   **Auswirkung:** Parallele Importe/Buchungen können gleiche Nummern erzeugen oder Transaktionen durch Unique-Verletzungen abbrechen; externe IDs können ebenfalls doppelt importiert werden.  
   **Fix:** DB-Sequenz bzw. mandantenspezifische Zählertabelle mit `UPDATE ... RETURNING`; Unique-Constraint auf `(organization_id, externalIds->>'doctolib')`.

## Niedrig

9. **Beliebige `patientId` verfälscht das Auditprotokoll**  
   **Datei/Stelle:** `src/app/api/ai/voice-report/route.ts`, `entityId` wird ungeprüft direkt aus `FormData` übernommen.  
   **Auswirkung:** Audit-Einträge können auf nicht existente oder fremde Patienten-IDs zeigen.  
   **Fix:** UUID validieren und innerhalb `withOrg(org)` Existenz sowie Mandantenzugehörigkeit prüfen; andernfalls `entityId` weglassen oder Request ablehnen.