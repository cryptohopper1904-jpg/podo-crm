# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Kritisch

1. **Unberechtigter VollExport durch Support-Admins**
   - **Datei/Stelle:** `src/app/api/export/praxis/route.ts`, `GET()` – Prüfung nur auf `auth.role !== "owner"`. In `src/lib/auth/session.ts`, `getAuth()` wird Support-Zugriff künstlich mit `role = "owner"` aufgebaut.
   - **Auswirkung:** Jeder Plattform-Admin mit gültiger **Read-Supportfreigabe** kann den vollständigen Praxisexport inklusive Gesundheitsdaten und entschlüsselter Medien herunterladen.
   - **Fix:** Support explizit ausschließen und echte Mitgliedschaft prüfen:
     ```ts
     if (!auth || auth.support || auth.role !== "owner") return ...;
     ```
     Zusätzlich die Owner-Mitgliedschaft serverseitig gegen `memberships` validieren, statt dem synthetischen Support-`role` zu vertrauen.

2. **Erstinstallation erlaubt Plattformübernahme ohne Setup-Token**
   - **Datei/Stelle:** `src/app/(auth)/actions.ts`, `setupAction()`:
     ```ts
     if (n === 0 && process.env.SETUP_TOKEN && d.setupToken !== process.env.SETUP_TOKEN)
     ```
   - **Auswirkung:** Ist `SETUP_TOKEN` nicht gesetzt, kann der erste externe Aufrufer ohne Token den ersten Benutzer anlegen. Dieser erhält `isPlatformAdmin: true`. `/einrichtung` ist in `src/proxy.ts` öffentlich.
   - **Fix:** Bei der Erstinstallation ohne konfiguriertes Token fail-closed abbrechen:
     ```ts
     if (n === 0 && (!process.env.SETUP_TOKEN ||
         d.setupToken !== process.env.SETUP_TOKEN)) return "token";
     ```

## Hoch

3. **Support-Admin mit Write-Freigabe kann Praxislöschung beantragen**
   - **Datei/Stelle:** `src/app/(app)/einstellungen/daten/actions.ts`, `requireOwner()`. Es wird nur `auth.role === "owner"` geprüft. Support erhält in `session.ts` ebenfalls Rolle `owner`; `settings.manage` ist laut `access.ts` für Support-Scope `write` erlaubt.
   - **Auswirkung:** Ein Support-Admin mit Write-Freigabe kann `deletionRequestedAt` setzen oder eine Löschungsrücknahme ausführen. Nach Ablauf der Karenzzeit kann der Purge Gesundheitsdaten endgültig löschen.
   - **Fix:** In `requireOwner()` Support ausschließen und echte aktive Owner-Mitgliedschaft prüfen:
     ```ts
     if (auth.support || auth.role !== "owner") throw ...;
     ```

4. **TOTP-Replay-Schutz ist nicht atomar**
   - **Datei/Stelle:** `src/app/(auth)/actions.ts`, `verifyTotpAction()`. Prüfung von `totpLastStep` und anschließendes
     ```ts
     update(users).set({ totpLastStep: step })
     ```
     erfolgen getrennt.
   - **Auswirkung:** Zwei parallele, noch unbestätigte Sitzungen desselben Benutzers können denselben TOTP-Zeitschritt beide akzeptieren, weil beide vor dem Update den alten Wert lesen.
   - **Fix:** Bedingtes atomisches Update verwenden und nur bei zurückgegebener Zeile verifizieren:
     ```sql
     UPDATE users SET totp_last_step = $step
     WHERE id = $id
       AND (totp_last_step IS NULL OR totp_last_step < $step)
     RETURNING id;
     ```

5. **Fehlgeschlagene Dateilöschung hinterlässt Gesundheitsdaten dauerhaft**
   - **Datei/Stelle:** `src/server/purge-organization.ts`, `purgeOnce()`: Datenbank-`commit` erfolgt vor `rm(target, ...)`.
   - **Auswirkung:** Schlägt `rm` nach dem Commit fehl, ist die Praxis bereits aus der DB gelöscht. Ein erneuter Purge bricht mit „Praxis nicht gefunden“ ab; entschlüsselt gespeicherte bzw. verschlüsselte Gesundheitsmedien bleiben ohne regulären Löschpfad zurück.
   - **Fix:** Speicherlöschung als wiederholbaren separaten Löschauftrag persistieren. Der Worker muss auch ohne vorhandenen Organisationsdatensatz anhand der Org-ID erneut löschen können; Abschluss erst nach erfolgreicher Speicherlöschung protokollieren.

## Mittel

6. **Veraltetes `invoice.payment_failed` kann neueren Abo-Status überschreiben**
   - **Datei/Stelle:** `src/server/billing.ts`, `processBillingEvent()`. Die Prüfung `ev.created < last` gilt nur für `customer.subscription.*`; `invoice.payment_failed` setzt immer `past_due`.
   - **Auswirkung:** Ein verspätet zugestelltes älteres Zahlungsfehler-Event kann eine inzwischen wieder aktive Praxis fälschlich in den Nur-Lesen-Modus versetzen.
   - **Fix:** Auch Rechnungsstatus-Events gegen einen passenden letzten Billing-Zeitstempel vergleichen oder Statusänderungen anhand der zugehörigen Subscription-/Invoice-Version ordnen.

7. **Voice-Webhooks besitzen keinen Replay-Schutz**
   - **Datei/Stelle:** `src/app/api/voice/[provider]/route.ts` und `src/server/voice.ts`. Nach erfolgreicher Secret-Prüfung wird keine Event-ID dauerhaft dedupliziert. Nur Terminbuchungen sind indirekt über `callId` dedupliziert.
   - **Auswirkung:** Wiederholte legitime oder aufgezeichnete Requests erzeugen mehrfach Rückruf- und Absagenachrichten; Anbieter-Retries können Posteingang und Verarbeitung gezielt vervielfachen.
   - **Fix:** Anbieter-Event-ID bzw. Kombination aus Anbieter, Eventtyp und Tool-Call-ID mit Unique Constraint speichern und Verarbeitung atomar nur beim ersten Insert ausführen.