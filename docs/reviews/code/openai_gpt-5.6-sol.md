# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Kritisch

- **`drizzle/0001_security.sql` – `podo_invoice_guard()` / `podo_invoice_lines_guard()`**  
  **Problem:** Bei ausgestellten Rechnungen wird eine Änderung von `status` auf `"draft"` erlaubt, da nur Beträge/Nummer geprüft werden. Danach gelten Rechnung und Positionen wieder als Entwurf und können verändert oder gelöscht werden.  
  **Auswirkung:** Vollständige Umgehung der behaupteten GoBD-Unveränderbarkeit.  
  **Fix:** Rückkehr nach `draft` verbieten; Unveränderbarkeit an `OLD.number IS NOT NULL` bzw. `OLD.issued_at IS NOT NULL` statt an `status` koppeln. Erlaubte Statusübergänge explizit prüfen. Der Positions-Trigger muss ebenfalls den jemals ausgestellten Zustand verwenden.

## Hoch

- **`src/app/(app)/kunden/[id]/doku/actions.ts` – `addAddendumAction()`**  
  **Problem:** Jeder Nutzer mit `medical.write`, einschließlich `trainee`, kann `kind="countersign"` senden. Es wird weder Rolle noch abweichende Identität des Gegenzeichners noch `countersignRequired` geprüft.  
  **Auswirkung:** Auszubildende können eigene oder fremde Dokumentationen selbst gegenzeichnen; die Kontrollfunktion ist wirkungslos.  
  **Fix:** Eigenes Recht wie `medical.countersign`; Trainees ausschließen; ursprünglichen Datensatz laden und `authorId !== auth.user.id` sowie `countersignRequired=true` erzwingen.

- **`src/app/(app)/kunden/[id]/doku/actions.ts` – Spangen- und Terminupdates in `saveTreatmentAction()`**  
  **Problem:** `braceEpisodeId` und `appointmentId` werden nur gegen `organizationId` und ID geprüft, nicht gegen `patientId`.  
  **Auswirkung:** Eine Behandlung für Patient A kann eine Spangenepisode oder einen Termin von Patient B verändern bzw. verknüpfen.  
  **Fix:** Updates und vorherige Validierung zusätzlich mit `eq(...patientId, d.patientId)` durchführen; bei fehlendem Treffer Transaktion abbrechen.

- **`src/app/(auth)/actions.ts` – `verifyTotpAction()`**  
  **Problem:** Für TOTP-Fehlversuche existieren weder Zähler, Sperre noch serverseitiges Rate-Limit. Die Passwortsperre greift hier nicht.  
  **Auswirkung:** Ein Angreifer mit einem gültigen Passwort bzw. unbestätigten Session-Cookie kann den typischerweise sechsstelligen zweiten Faktor automatisiert erraten.  
  **Fix:** Fehlversuche transaktionssicher je Session/Nutzer zählen, nach wenigen Versuchen Session löschen bzw. zeitweise sperren und Anfragen begrenzen.

- **`drizzle/0001_security.sql` – RLS-Tabellenliste**  
  **Problem:** `audit_log` erhält zwar einen Append-only-Trigger, fehlt aber in der RLS-Liste. Auch `organizations` und `memberships` sind nicht mandantenisoliert.  
  **Auswirkung:** Die Datenbank erzwingt für diese mandantenbezogenen Tabellen keine Isolation; ein fehlender Anwendungsfilter ermöglicht praxisübergreifende Einsicht, beim Audit-Log einschließlich sicherheitsrelevanter Metadaten.  
  **Fix:** RLS/FORCE RLS mit passenden Policies ergänzen; Auth-Bootstrap-Tabellen gegebenenfalls über eng begrenzte separate Policies/Rollen zugänglich machen.

- **`src/app/(auth)/actions.ts` – `setupAction()`**  
  **Problem:** Prüfung `count(users)` und Anlage des ersten Platform-Admins sind nicht serialisiert. Zwei parallele Erstregistrierungen können beide `n === 0` sehen.  
  **Auswirkung:** Mehrere öffentliche Anfragen können mehrere Organisationen mit `isPlatformAdmin=true` erzeugen.  
  **Fix:** Erstinstallation über DB-Lock/serialisierbare Transaktion oder singleton Setup-Zeile mit `SELECT … FOR UPDATE` absichern; Adminstatus innerhalb derselben Transaktion bestimmen.

## Mittel

- **`src/app/(app)/kunden/[id]/doku/actions.ts` – Hash-Ketten**  
  **Problem:** Parallele Behandlungen/Addenda können denselben Vorgängerhash lesen und zwei Verzweigungen erzeugen. Zusätzlich wird bei Addenda ein separat erzeugtes `at` gehasht, aber nicht gespeichert.  
  **Auswirkung:** Die Kette kann bei legitimen Parallelzugriffen inkonsistent werden; Addendum-Hashes sind aus den persistierten Daten nicht zuverlässig reproduzierbar.  
  **Fix:** Patient/Datensatz per Advisory Lock oder `FOR UPDATE` serialisieren; exakt denselben gespeicherten Zeitstempel hashen.

- **`src/lib/storage.ts` / `src/app/api/media/route.ts` – Speicherung vor DB-Insert**  
  **Problem:** Die verschlüsselte Datei wird vor dem Einfügen des `media`-Datensatzes dauerhaft geschrieben. Scheitert Insert oder Transaktion, erfolgt keine Löschung.  
  **Auswirkung:** Nicht referenzierte Gesundheitsdateien verbleiben unbegrenzt im Speicher und entziehen sich regulärer Löschung/Auskunft.  
  **Fix:** Staging-Bereich mit Commit/Abort verwenden oder bei Fehlern die gerade erzeugte Datei sicher entfernen; periodische, mandantensichere Orphan-Bereinigung ergänzen.

## Niedrig

- **`drizzle/0001_security.sql` – `podo_media_guard()`**  
  **Problem:** Vergleiche verwenden `<>` statt `IS DISTINCT FROM`; Änderungen von `NULL` zu einem Wert, etwa bei `taken_at`, lösen die Sperre nicht aus.  
  **Auswirkung:** Als unveränderbar deklarierte Medienmetadaten können teilweise nachträglich geändert werden.  
  **Fix:** Sämtliche Vergleiche durch `IS DISTINCT FROM` ersetzen.