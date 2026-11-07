# Code-Review (Sicherheit): ~google/gemini-pro-latest

Hier sind die konkreten Sicherheitsprobleme im geprüften Code, sortiert nach Schweregrad:

### KRITISCH

**1. 2FA-Brute-Force durch fehlendes Rate-Limiting & fehlende TOTP-Replay-Sperre**
* **Datei & Stelle:** `src/app/(auth)/actions.ts`, `verifyTotpAction` (Zeilen 53–64)
* **Auswirkung:** Ein Angreifer, der das Passwort kennt, erhält eine unbestätigte Session (`verified: false`). Da `verifyTotpAction` weder Fehlversuche zählt noch die Session/den Nutzer sperrt, können alle 1.000.000 sechsstelligen TOTP-Codes innerhalb des 12-Stunden-Fensters per Brute-Force durchprobiert werden. Zudem können bereits genutzte Codes innerhalb des 30s-TOTP-Fensters erneut verwendet werden (Replay).
* **Fix:** Fehlversuche in `sessions` oder `users` mitzählen und nach z. B. 5 Fehlversuchen `destroySession()` aufrufen sowie das Konto temporär sperren. Den zuletzt akzeptierten TOTP-Zeitschritt (`lastTotpStep`) beim User speichern und identische/ältere Schritte ablehnen.

### HOCH

**2. GoBD-Bypass: Manipulation ausgestellter Rechnungen über Status-Downgrade**
* **Datei & Stelle:** `drizzle/0001_security.sql`, `podo_invoice_guard` (Zeilen 42–55)
* **Auswirkung:** Der Trigger prüft `OLD.status <> 'draft'` und blockiert Änderungen an `number`, `total_cents` etc., verhindert aber **nicht**, dass `NEW.status` wieder auf `'draft'` gesetzt wird. Ein kompromittierter App-Kontext kann `UPDATE invoices SET status = 'draft'` ausführen und im nächsten Statement sämtliche Rechnungsbeträge, Positionen (`invoice_lines_guard` prüft ebenfalls nur `st <> 'draft'`) oder die Rechnung selbst löschen.
* **Fix:** Im Trigger `podo_invoice_guard` ergänzen:
  ```sql
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'Status darf nicht auf Entwurf zurückgesetzt werden.' USING ERRCODE = 'P0001';
  END IF;
  ```

**3. 2FA-Kontextverlust / Bypass bei Mandantenwechsel**
* **Datei & Stelle:** `src/app/(auth)/actions.ts`, `switchOrganizationAction` (Zeilen 112–126)
* **Auswirkung:** `switchOrganizationAction` nutzt `getSession()` statt `requireAuth()`. Dadurch kann bereits vor Abschluss von 2FA (`verified: false`) die Organisation gewechselt werden. Zudem wird nicht geprüft, ob die Ziel-Organisation 2FA voraussetzt.
* **Fix:** `getSession()` durch `requireAuth()` ersetzen (erzwingt `session.verified === true`).

**4. Race Condition bei Kontosperrung (Brute-Force-Schutz umgehbar)**
* **Datei & Stelle:** `src/app/(auth)/actions.ts`, `loginAction` (Zeilen 29–37)
* **Auswirkung:** `failedLogins` wird in JS berechnet (`const failed = user.failedLogins + 1`) und zurückgeschrieben. Bei parallelen Requests (Race Condition) überschreiben sich die Prozesse gegenseitig mit niedrigen Zählerständen, bevor `LOCK_AFTER` erreicht wird. Zudem setzt der 8. Versuch `failedLogins` sofort auf `0` zurück.
* **Fix:** Atomares Inkrement in SQL verwenden:
  ```ts
  failedLogins: sql`${users.failedLogins} + 1`,
  lockedUntil: sql`CASE WHEN ${users.failedLogins} + 1 >= ${LOCK_AFTER} THEN now() + interval '15 minutes' ELSE ${users.lockedUntil} END`
  ```

**5. Race Condition bei Erstregistrierung führt zu mehreren Platform-Admins**
* **Datei & Stelle:** `src/app/(auth)/actions.ts`, `setupAction` (Zeilen 79–106)
* **Auswirkung:** Die Prüfung `SELECT count(*) FROM users` (`n === 0`) findet außerhalb der nachfolgenden Transaktion und ohne Tabellen-Lock statt. Parallele Requests bei der Initialisierung legen mehrere Organisationen und mehrere Nutzer mit `isPlatformAdmin: true` an, selbst wenn `ALLOW_SIGNUP !== "true"`.
* **Fix:** Die Zählung in die Transaktion verlegen und mittels `await tx.execute(sql`LOCK TABLE users IN EXCLUSIVE MODE`)` serialisieren.

### MITTEL

**6. Umgehung der Azubi-Gegenzeichnungspflicht (§ 630f BGB / Rollenmodell)**
* **Datei & Stelle:** `src/app/(app)/kunden/[id]/doku/actions.ts`, `addAddendumAction` (Zeilen 158–176) & `src/lib/auth/permissions.ts` (Zeile 53)
* **Auswirkung:** Ein `trainee` (Azubi) besitzt `medical.write`. Seine Einträge erhalten `countersignRequired: true`. In `addAddendumAction` wird jedoch nur `requireAuth("medical.write")` geprüft. Ein Azubi kann `kind="countersign"` übergeben und seine eigene Dokumentation selbst gegenzeichnen.
* **Fix:** In `addAddendumAction` prüfen:
  ```ts
  if (kind === "countersign" && auth.role !== "owner" && auth.role !== "therapist") {
    throw new Error("Keine Berechtigung zur Gegenzeichnung.");
  }
  ```

**7. Verwaiste, ungeschützte Gesundheitsdaten auf dem Dateisystem (DSGVO Art. 17 / Art. 32)**
* **Datei & Stelle:** `src/app/api/media/route.ts`, `POST` (Zeilen 44–65)
* **Auswirkung:** `storeEncrypted(org, buf)` schreibt die Datei vor der Datenbanktransaktion auf das Speichermedium. Schlägt der anschließende DB-Insert fehl, verbleibt die Datei ohne DB-Referenz und ohne Audit-Log dauerhaft im Storage (wird bei späteren Löschkonzepten nie erfasst). Zudem fehlt eine Magic-Byte-Prüfung: Der Client-Header `file.type` wird ungeprüft übernommen.
* **Fix:** Dateityp anhand der Magic Bytes (Buffer-Header) validieren; im Fehlerfall des DB-Inserts die Datei im `catch`-Block wieder löschen.

**8. Fehlende RLS-Absicherung auf der Tabelle `audit_log`**
* **Datei & Stelle:** `drizzle/0001_security.sql` (Zeilen 69–81)
* **Auswirkung:** `audit_log` fehlt im RLS-Array. Bei einem fehlerhaften Query ohne `organization_id`-Filter können Audit-Logs (inkl. Metadaten über fremde Patienten/Mandanten) mandantenübergreifend ausgelesen werden.
* **Fix:** `'audit_log'` in die RLS-Schleife aufnehmen (mit Policy für `organization_id`).

### NIEDRIG

**9. IP-Spoofing im Audit- und Session-Log**
* **Datei & Stelle:** `src/lib/auth/session.ts`, `requestMeta` (Zeile 17)
* **Auswirkung:** `h.get("x-forwarded-for")?.split(",")[0]` liest den *ersten* Eintrag des Headers. Dieser kann vom Client frei gefälscht werden, wodurch IP-basierte Forensik in `sessions` und `audit_log` unbrauchbar wird.
* **Fix:** Nur einem konfigurierten Reverse-Proxy vertrauen oder das letzte Element vor dem eigenen Proxy auswerten.

**10. SQL-Wildcard-Injection in Gutschein-Prüfung**
* **Datei & Stelle:** `src/server/invoices.ts`, `applyPayments` (Zeile 106)
* **Auswirkung:** `ilike(vouchers.code, p.voucherCode)` erlaubt dem Nutzer die Eingabe von `%` oder `_`. Mit `voucherCode = "%"` wird ein beliebiger aktiver Gutschein des Mandanten eingelöst, ohne den Code zu kennen.
* **Fix:** `eq(sql`lower(${vouchers.code})`, p.voucherCode.toLowerCase())` statt `ilike` verwenden.