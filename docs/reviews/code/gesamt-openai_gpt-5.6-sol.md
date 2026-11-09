# Gesamt-Review (Sicherheit, extern): openai/gpt-5.6-sol

Geprüfte Dateien: src/lib/auth/session.ts, src/lib/auth/access.ts, src/lib/auth/cookie.ts, src/lib/auth/permissions.ts, src/lib/auth/support-view.ts, src/lib/auth/client-ip.ts, src/server/authz.ts, src/proxy.ts, src/app/api/webhooks/[provider]/route.ts, src/server/webhooks.ts, src/server/portal-core.ts, src/server/kasse.ts, src/server/practice-export.ts, src/app/api/voice/[provider]/route.ts, src/server/support.ts

## Kritisch

- **`src/server/practice-export.ts:25-31,49-52,103-110,152-223` – Vollständiger Gesundheitsdatenexport ohne Autorisierung und vertrauenswürdige Mandantenbindung.**  
  **Auswirkung:** Die exportierte Fachfunktion akzeptiert `organizationId` und Identitätsangaben direkt vom Aufrufer, setzt damit selbst den RLS-Kontext und exportiert sämtliche Tabellen sowie entschlüsselte Medien. Es gibt weder `AuthContext`, Rechteprüfung noch Audit-Log. Jeder Server-Aufrufer kann dadurch einen beliebigen Mandanten exportieren; ein fehlerhaft verdrahteter Route-Handler wird zum Cross-Tenant-Export.  
  **Fix:** `AuthContext` statt `organizationId`/`exportedBy` entgegennehmen, Mandant ausschließlich aus `auth.organization.id` ableiten, ein eigenes Exportrecht bzw. Owner-Prüfung erzwingen und Start/Erfolg/Abbruch mit authentifizierter Benutzer-ID auditieren.

## Hoch

- **`src/app/api/webhooks/[provider]/route.ts:131-162`; `src/server/webhooks.ts:22-43` – Webhook-Ereignisse können dauerhaft verloren gehen.**  
  **Auswirkung:** Nach dem Claim wird sofort HTTP 200 gesendet und erst in `after()` verarbeitet. Ein Prozessabbruch vor `finishWebhookEvent()` hinterlässt `error = null` und `processedAt = null`; spätere Zustellungen können wegen der Retry-Bedingung `error IS NOT NULL` nie erneut claimen. Auch reguläre Verarbeitungsfehler erhalten bereits 200, sodass Provider typischerweise nicht erneut zustellen. Das kann insbesondere bestätigte Zahlungen oder Patientennachrichten dauerhaft unterschlagen.  
  **Fix:** Ereignis dauerhaft in eine Queue/Outbox schreiben und erst dort verarbeiten; Claims mit Status und ablaufender Lease (`processingUntil`) versehen. Fehler intern erneut einplanen. Alternativ erst nach erfolgreicher synchroner Verarbeitung 2xx senden.

- **`src/app/api/voice/[provider]/route.ts:70-88` – Kein Replay-Schutz für Voice-Webhooks und Tool-Aufrufe.**  
  **Auswirkung:** Die Prüfung authentifiziert nur statisches Secret bzw. HMAC über den unveränderten Body. Es gibt weder Timestamp-Fenster noch Event-ID/Nonce-Claim. Jede aufgezeichnete gültige Anfrage kann wiederholt `processVoiceEvent()` auslösen und dadurch Voice-Werkzeuge mehrfach ausführen. Der IP-/Praxis-Limiter verhindert keine Wiederholung innerhalb des Kontingents.  
  **Fix:** Anbieter-Timestamp signaturgebunden prüfen und nur ein enges Zeitfenster akzeptieren; eindeutige Event-/Call-/Tool-Call-ID pro Mandant atomar speichern und Duplikate vor `processVoiceEvent()` beantworten.

- **`src/server/webhooks.ts:121-142` – Falsche TSE-Umsatzsteuerdaten bei Teilzahlungen.**  
  **Auswirkung:** Für eine Teilzahlung wird `amountCents` der Teilzahlung signiert, die `vatGroups` enthalten aber die vollständigen Bruttosummen aller Rechnungspositionen. Damit stimmen signierter Zahlbetrag und Steueraufteilung nicht überein; TSE-/DSFinV-K-Daten werden sachlich falsch.  
  **Fix:** Rechnungs-VAT-Gruppen anteilig und centgenau auf den tatsächlich gezahlten Betrag verteilen; Rundungsrest deterministisch einer Gruppe zuordnen und prüfen, dass die Summe der Gruppen exakt `input.amountCents` ergibt.

- **`src/server/webhooks.ts:95-96,126-142` – Externe TSE-Signatur innerhalb einer DB-Transaktion ohne atomare Kopplung.**  
  **Auswirkung:** `signRegisterPayment()` erzeugt eine externe Fiskaltransaktion, bevor Zahlung und Signatur in PostgreSQL sicher committed sind. Scheitert danach Insert, `storeSignature()` oder Commit, existiert eine TSE-Transaktion ohne zugehörigen lokalen Zahlungssatz.  
  **Fix:** Vorab einen lokalen Payment-/Fiscal-Job mit stabiler Idempotenz-ID committen, anschließend extern signieren und Ergebnis in einer zweiten Transaktion speichern. Wiederholungen müssen dieselbe externe Transaktions-ID verwenden; fehlgeschlagene Zuordnungen müssen als abstimmbarer Zustand erhalten bleiben.

- **`src/lib/auth/access.ts:61-72`; `src/server/support.ts:16-19` – Legacy-Supportfreigaben mit `granteeUserId = null` gelten für alle Plattform-Admins.**  
  **Auswirkung:** `isGrantActive()` akzeptiert solche Freigaben für jede beliebige Benutzer-ID. Damit kann jeder aktuelle Plattform-Admin mit aktivierter 2FA die betroffene Praxis betreten, obwohl keine personengebundene Freigabe für ihn erteilt wurde.  
  **Fix:** `granteeUserId === null` stets ablehnen; bestehende Null-Freigaben sofort widerrufen oder explizit auf eine konkrete Person migrieren und die DB-Spalte anschließend `NOT NULL` machen.

- **`src/server/kasse.ts:539-550` – Z-Bon-PDF ohne Rechte- oder Mandantenprüfung des Benutzers.**  
  **Auswirkung:** `zBonPdfForOrg()` nimmt eine beliebige Organisations-ID entgegen und aktiviert dafür selbst RLS. Anders als `getClosing()` prüft sie weder `cash.read` noch die Zugehörigkeit des Aufrufers. Jeder Server-Aufrufer kann damit Fiskaldaten eines fremden Mandanten abrufen.  
  **Fix:** `AuthContext` entgegennehmen, `assertCan(auth, "cash.read")` ausführen und ausschließlich `auth.organization.id` verwenden. Für interne Spezialaufrufe eine nicht exportierte, klar getrennte Helper-Funktion nutzen.

## Mittel

- **`src/app/api/webhooks/[provider]/route.ts:18-25,109-112` – Webhook-Geheimnisse werden als URL-Query-Parameter übertragen.**  
  **Auswirkung:** Tokens für Lexoffice, SMS und den alten Voice-Agent sind Bestandteil des Request-Targets und können dadurch in Proxy-, CDN-, Server- oder Provider-Logs erscheinen. Ein offengelegtes Token ermöglicht das Einspeisen beliebiger authentifizierter Ereignisse für die Praxis.  
  **Fix:** Token in einen dedizierten Header verlegen oder signierte Requests mit Timestamp verwenden; bestehende Tokens rotieren und Query-Token nach Übergangsfrist ablehnen.

- **`src/server/kasse.ts:568-575,620-628` – Export-Zeitraum wird in den Fachfunktionen nicht validiert.**  
  **Auswirkung:** Obwohl `exportRangeInput` maximal drei Jahre und gültige ISO-Daten vorgibt, verwenden `buildDsfinvkExport()` und `closingsInRange()` die ungeprüften Strings direkt. Aufrufer können die Begrenzung umgehen und unnötig große Exporte beziehungsweise Datenbanklast erzeugen.  
  **Fix:** Am Anfang beider Funktionen `const range = exportRangeInput.parse({ from, to })` ausführen und anschließend ausschließlich `range.from`/`range.to` verwenden.

## Niedrig

- **`src/server/support.ts:42-49` – Support-Admin-Verzeichnis ohne Autorisierungsprüfung.**  
  **Auswirkung:** Die exportierte Funktion liefert Namen und E-Mail-Adressen aller Plattform-Admins mit 2FA, ohne `AuthContext` oder Owner-Prüfung. Jeder Server-Aufrufer erhält diese Betreiberkonten.  
  **Fix:** `AuthContext` verlangen und dieselbe Owner-/Nicht-Support-Prüfung wie bei `listSupportGrants()` durchführen.