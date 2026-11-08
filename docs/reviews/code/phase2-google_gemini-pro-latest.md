# Code-Review (Sicherheit): ~google/gemini-pro-latest

Hier sind die identifizierten Sicherheitsprobleme im vorgelegten Code, sortiert nach Schweregrad.

### HOCH

**1. Fehlende Autorisierungsprüfungen (RBAC) in Fachfunktionen – Zugriff auf Gesundheitsdaten (DSGVO Art. 9)**
* **Datei & Stelle:** 
  * `src/server/anamnesis.ts` (`saveAnamnesis`, `createAnamnesisLink`, `revokeAnamnesisLink`)
  * `src/server/prescriptions.ts` (`listPatientPrescriptions`, `listRunningPrescriptions`, `savePrescription`, `changePrescriptionStatus`, `setCopaymentPaid`, `createBillingBatch`, `billingBatchExport`)
  * `src/server/hygiene.ts` (`saveChecklist`, `createBatch`, `saveDevice`, `addDeviceEvent`, `saveMaterial`, `adjustStock`)
* **Auswirkung:** Während `listAnamneses` und `traceBatch` explizit `auth.can("medical.read")` prüfen und `decideBatch` die Rolle validiert, fehlt in allen oben genannten Funktionen eine Berechtigungsprüfung. Wenn ein Aufrufer (Server Action / Route) nur `getAuth()` statt `requireAuth(...)` nutzt, kann z. B. eine Empfangskraft ohne `medical.read`/`medical.write` Diagnosen (ICD-10), Heilmittelverordnungen und Abrechnungsexporte einsehen oder manipulieren.
* **Fix:** In jeder exportierten Funktion vor der DB-Abfrage die Berechtigung erzwingen (Defense-in-Depth), z. B.:
  ```ts
  if (!auth.can("medical.read")) throw new Error("Forbidden"); // bzw. medical.write / billing.write
  ```

**2. CSV-Injection (Formula Injection) beim GKV-Abrechnungsexport**
* **Datei & Stelle:** `src/server/prescriptions.ts`, Funktion `billingBatchExport` (Zeilen 288–317).
* **Auswirkung:** Freitextfelder wie `p.lastName`, `p.firstName`, `vo.doctorName`, `vo.remedy`, `vo.interruptionNote` und `vo.positions[].label` werden ungefiltert in das Export-Array geschrieben. Öffnet die Praxis oder das Abrechnungszentrum die CSV in Excel/LibreOffice, führen Werte beginnend mit `=`, `+`, `-`, `@`, `\t` oder `\r` zur Ausführung von Formeln/Kommandos (Datenexfiltration von Gesundheitsdaten).
* **Fix:** Alle String-Zellen vor dem Export neutralisieren:
  ```ts
  const safeCsvCell = (v: unknown) =>
    typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  ```

---

### MITTEL

**3. Mandantenübergreifende Webhook-Blockade (DoS) und fehlendes RLS auf `webhook_events`**
* **Datei & Stelle:** `src/server/webhooks.ts`, Funktion `claimWebhookEvent` (Zeilen 24–44) & `drizzle/0007_phase2_security.sql`.
* **Auswirkung:** 
  1. `onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalId] })` nutzt einen mandantenübergreifenden Unique-Key. Bei Providern, deren `externalId` nicht global eindeutig ist (z. B. fortlaufende IMAP-UIDs oder lokale IDs), blockiert Mandant A die Webhook-Verarbeitung von Mandant B permanent (da das anschließende `UPDATE` auf `eq(webhookEvents.organizationId, organizationId)` prüft und `null` zurückgibt).
  2. `webhook_events` ist in `0007_phase2_security.sql` nicht mit RLS geschützt.
* **Fix:** Unique-Constraint und Conflict-Target auf `(organization_id, provider, external_id)` ändern; `webhook_events` in die RLS-Schleife in `0007_phase2_security.sql` aufnehmen und über `withOrg` ansprechen.

**4. Ungeprüfte Betragsbuchung bei Teilzahlungen über SumUp**
* **Datei & Stelle:** `src/server/webhooks.ts`, Funktion `recordProviderPayment` (Zeile 69) und `src/server/card-payments.ts` (`startTerminalPayment` / `createPaymentLink`).
* **Auswirkung:** Zwischen dem Erzeugen eines Zahlungslinks (`open = totalCents - paidCents`) und der Zahlung durch den Patienten kann die Rechnung in der Praxis bereits bar/anderweitig (teil-)bezahlt oder storniert worden sein. `recordProviderPayment` bucht den vollen SumUp-Betrag ohne Prüfung auf Überzahlung (`paid > inv.totalCents`), was zu inkonsistenten Buchhaltungsdaten führt.
* **Fix:** In `recordProviderPayment` prüfen, ob `paid > inv.totalCents` ist, und diesen Fall gesondert markieren/loggen, sowie bei Stornierung einer Rechnung aktive SumUp-Checkouts widerrufen.

**5. Fehlerhafte Duplikatserkennung bei Sammelrechnungen durch Zeitzonen-/Typ-Diskrepanz**
* **Datei & Stelle:** `src/server/invoice-delivery.ts`, Funktion `collectiveSuggestion` (Zeilen 165–176).
* **Auswirkung:** `ownKeys` baut den String `${o.patientId}|${o.issuedAt}`, während beim Abgleich `${r.patientId}|${berlinDateIso(r.treatedAt)}` geprüft wird. Ist `invoices.issuedAt` ein `Date`-Objekt oder ein ISO-Timestamp, schlägt der String-Vergleich mit `YYYY-MM-DD` immer fehl – bereits einzeln abgerechnete Behandlungen werden dem Pflegeheim doppelt in Rechnung gestellt.Zudem greift `d.includes(key)` bei Namensgleichheit zu breit (z. B. "Meier, Hans" matcht in Freitexten unbeabsichtigt).
* **Fix:** `issuedAt` ebenfalls über `berlinDateIso(o.issuedAt)` normalisieren. Statt Text-Matching über `description` sollte die `treatment_record_id` als Fremdschlüssel an `invoice_lines` gespeichert werden.

---

### NIEDRIG

**6. Globaler Memory-Reset im Rate-Limiter ermöglicht einfachen Bypass**
* **Datei & Stelle:** `src/lib/rate-limit.ts`, Funktion `limited` (Zeile 12: `if (hits.size > maxKeys) hits.clear();`).
* **Auswirkung:** Ein Angreifer (oder ein hinter einem falsch konfigurierten Proxy stehender Client, der `X-Forwarded-For` rotiert) kann durch 5.001 bzw. 10.001 Anfragen mit unterschiedlichen IP-Keys den gesamten Rate-Limit-Speicher (`hits.clear()`) leeren und so die Brute-Force-Sperre (`portalFailLimiter`, `limiter`) für alle IPs zurücksetzen.
* **Fix:** Map in Einfügereihenfolge (FIFO) begrenzen statt komplett zu leeren:
  ```ts
  if (hits.size >= maxKeys) {
    const oldestKey = hits.keys().next().value;
    if (oldestKey !== undefined) hits.delete(oldestKey);
  }
  ```

**7. Keine Längen-/Schlüsselbegrenzung bei `Object.fromEntries(form)`**
* **Datei & Stelle:** `src/app/anamnese/[token]/actions.ts`, Zeile 23.
* **Auswirkung:** Ein Angreifer kann vor der Token-DB-Prüfung tausende Formularfelder oder sehr große Strings im `FormData` senden, die synchron in ein Objekt kopiert und durch `parseAnamnesis` geparst werden (CPU-/Memory-Spikes).
* **Fix:** Anzahl der Form-Einträge und Gesamtgröße vor `Object.fromEntries(form)` begrenzen.