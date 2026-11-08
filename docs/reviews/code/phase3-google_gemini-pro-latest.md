# Code-Review (Sicherheit): ~google/gemini-pro-latest

### Kritisch

**1. Unautorisierter Voll-Export aller Gesundheitsdaten im Support-Modus (Break-Glass-Bypass)**
* **Datei & Stelle:** `src/app/api/export/praxis/route.ts` (Zeile 13–14) i. V. m. `src/lib/auth/session.ts` (`getAuth`, Zeile 153).
* **Auswirkung:** Im Support-Modus setzt `getAuth()` die Variable `role = "owner"` („nur für Anzeige; die Rechte begrenzt `effectiveCan()`“). Die Export-Route prüft jedoch nicht `auth.can(...)` und nicht `!auth.support`, sondern direkt `if (!auth || auth.role !== "owner")`. Ein Plattform-Admin mit einer reinen Support-Lesefreigabe (`scope: "read"`) kann über `GET /api/export/praxis` ein komplettes, entschlüsseltes ZIP-Archiv aller Patientendaten, Behandlungsdokumentationen und Fotos herunterladen (Verstoß gegen Art. 9, 28, 32 DSGVO & § 203 StGB).
* **Fix:** Support-Zugriff beim Praxis-Export explizit ausschließen:
  ```ts
  if (!auth || auth.role !== "owner" || auth.support) {
    return NextResponse.json({ error: "Nur Inhaber:innen können die Praxis exportieren." }, { status: 403 });
  }
  ```

---

### Hoch

**2. Unautorisierte Praxis-Kündigung & Löschantrag durch Plattform-Admin im Support-Modus**
* **Datei & Stelle:** `src/app/(app)/einstellungen/daten/actions.ts` (`requireOwner`, Zeile 13–17) i. V. m. `src/lib/auth/access.ts` (`SUPPORT_WRITE_PERMISSIONS`, Zeile 14).
* **Auswirkung:** `SUPPORT_WRITE_PERMISSIONS` enthält `"settings.manage"`. Hat ein Plattform-Admin eine Support-Freigabe mit `scope: "write"`, besteht er in `requireOwner()` sowohl `requireAuth("settings.manage")` als auch `auth.role !== "owner"` (da `role` im Support-Modus `"owner"` ist). Der Support-Admin kann über `requestDeletionAction` die Kündigung und endgültige Löschung der Kundenpraxis beantragen oder über `cancelDeletionAction` zurücknehmen.
* **Fix:** In `requireOwner()` analog zu `src/server/support.ts` auf `!auth.support` prüfen:
  ```ts
  if (auth.role !== "owner" || auth.support) throw new Error("Nur Inhaber:innen können die Praxis kündigen.");
  ```

**3. 2FA-Replay-Bypass bei parallelen Anfragen (Race Condition)**
* **Datei & Stelle:** `src/app/(auth)/actions.ts` (`verifyTotpAction`, Zeile 65–83).
* **Auswirkung:** `row.user.totpLastStep` wird zu Request-Beginn ohne Sperre gelesen und erst am Ende per `UPDATE users SET totpLastStep = step` geschrieben. Bei zwei parallelen Requests mit demselben TOTP-Code sehen beide den alten `totpLastStep`-Wert, bestehen die Prüfung `step <= row.user.totpLastStep` und stellen zwei verifizierte Sessions aus (z. B. bei abgegriffenem Code im selben 30s-Fenster).
* **Fix:** Prüfung und Update atomar in einem bedingten SQL-Statement durchführen:
  ```ts
  const [updated] = await db
    .update(users)
    .set({ totpLastStep: step })
    .where(and(eq(users.id, row.user.id), sql`(${users.totpLastStep} is null or ${users.totpLastStep} < ${step})`))
    .returning({ id: users.id });
  if (!updated) return { error: "Code wurde bereits verwendet." };
  ```

---

### Mittel

**4. Memory-Exhaustion (DoS) beim Praxis-Export durch ungestreamtes In-Memory-ZIP**
* **Datei & Stelle:** `src/server/practice-export.ts` (Zeile 32–88).
* **Auswirkung:** `buildPracticeExport` lädt zunächst sämtliche Tabellenzeilen der Praxis in den RAM (`data.tables`) und entschlüsselt anschließend in einer Schleife alle Mediendateien als `Buffer` (`buf = await readDecrypted(key)`), um sie per `zip.file(file, buf)` im Speicher von `JSZip` vorzuhalten, bevor der Stream überhaupt startet. Bei Praxen mit hunderten Behandlungsfotos führt dies zum Absturz des Node.js-Prozesses (`JavaScript heap out of memory`) und legt alle Mandanten auf der Instanz lahm.
* **Fix:** Statt voller `Buffer` Lazy-Streams (`fs.createReadStream` gepiped durch ` createDecipheriv`) an `zip.file(file, readStream)` übergeben, sodass JSZip die Dateien erst beim Durchlaufen von `generateNodeStream` einzeln liest und entschlüsselt.

**5. Umgehung des 32-BiB-Transaktions-Locks bei Voice-Buchungen (Hash-Kollisionen via `hashtext`)**
* **Datei & Stelle:** `src/server/voice.ts` (`upsertCall` Zeile 135, `book` Zeile 188).
* **Auswirkung:** `pg_advisory_xact_lock(hashtext(...))` nutzt den 32-Bit-Hash von Postgres. Bei wachsender Mandanten-/Anrufzahl treten durch das Geburtstagsparadoxon bereits ab wenigen tausend gleichzeitigen Vorgängen Kollisionen auf (gegenseitiges Blockieren fremder Mandanten); zudem ist `hashtext` nicht kryptografisch und für gezielte Lock-Contention-Angriffe über manipulierte `callId`-Werte anfällig.
* **Fix:** Zwei 32-Bit-Schlüssel oder einen 64-Bit-Hash aus der Mandanten-UUID ableiten, z. B.:
  ```ts
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`book:${org}`}, 0))`);
  ```

**6. Überschreiben von Praxis-Einstellungen durch Race Condition bei Stripe-Webhooks**
* **Datei & Stelle:** `src/server/billing.ts` (`processBillingEvent`, Zeile 35–46, `applyPatch`, Zeile 67–72).
* **Auswirkung:** `findOrg` liest die Zeile aus `organizations` ohne `FOR UPDATE`. Wenn zeitgleich ein Praxis-Admin Einstellungen ändert (z. B. `saveVoiceSettings` in `src/server/voice.ts`) und ein Stripe-Webhook verarbeitet wird, überschreibt `applyPatch` das gesamte JSONB-Feld `settings` mit dem zuvor gelesenen Stand `{ ...settings, billingLastEventAt: ... }`. Änderungen an `settings.voice` oder `settings.legalAcceptance` gehen verloren.
* **Fix:** In `findOrg` die Zeile mit `.for("update")` sperren oder `billingLastEventAt` per `jsonb_set` atomar in PostgreSQL aktualisieren statt das gesamte `settings`-Objekt aus dem Node-Speicher zurückzuschreiben.

---

### Niedrig

**7. Account-Enumeration und fehlendes Rate-Limiting bei `setupAction` (Self-hosted)**
* **Datei & Stelle:** `src/app/(auth)/actions.ts` (`setupAction`, Zeile 109–117).
* **Auswirkung:**
  1. `signupLimiter` ist nur aktiv, wenn `ALLOW_SIGNUP === "true"` (`if (saas && ...)`). Bei `ALLOW_SIGNUP !== "true"` ist die Datenbankabfrage auf existierende E-Mails (Zeile 115) ungedrosselt erreichbar.
  2. Die Prüfung `if (existing) return { error: "Für diese E-Mail gibt es bereits ein Konto." }` erfolgt *vor* der Prüfung, ob Registrierungen überhaupt erlaubt sind (`n > 0 && process.env.ALLOW_SIGNUP !== "true"` in Zeile 129). Angreifer können so auch bei deaktivierter Registrierung unbegrenzt prüfen, welche E-Mail-Adressen im System registriert sind.
* **Fix:** `signupLimiter` immer (unabhängig von `saas`) ausführen und die E-Mail-Existenzprüfung in die Transaktion *nach* die Prüfung auf `ALLOW_SIGNUP` und `SETUP_TOKEN` verschieben.