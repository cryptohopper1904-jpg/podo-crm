# Code-Review (Sicherheit): x-ai/grok-4.7

Kritisch

**GoBD-Trigger umgehbar** (`drizzle/0001_security.sql`, `podo_invoice_guard` / `podo_invoice_lines_guard`). Geschützt sind nur `number`, Cent-Summen, `issued_at`, `patient_id`, und nur solange `OLD.status <> 'draft'`. `status`, `kind`, `billing_contact_id`, `notes`, `due_at`, `paid_cents` bleiben schreibbar. `status='draft'` setzen, Beträge ändern, wieder ausstellen; oder `paid_cents`/`status='paid'` ohne Zahlung. Der Positions-Trigger prüft nur `NEW.invoice_id`: Umhängen auf einen Entwurf nimmt die Position von der ausgestellten Rechnung. Auswirkung: ausgestellte Belege fälschbar. Fix: Statusübergänge whitelistn (nie zurück nach `draft`); Empfänger, `kind`, `notes`, `due_at` sperren; `paid_cents` nur aus Zahlungszeilen; im Positions-Trigger alte und neue Rechnung `FOR UPDATE` sperren, beide prüfen, Trigger `SECURITY DEFINER`.

Hoch

**Append-only umgehbar** (dieselbe Datei, `treatment_records_no_update` u. a.). Nur `BEFORE UPDATE OR DELETE FOR EACH ROW`. `TRUNCATE` und `ALTER TABLE … DISABLE TRIGGER` umgehen das; es wird keine App-Rolle ohne Owner/`TRUNCATE`/`TRIGGER` angelegt. Auswirkung: Behandlungsdoku (§ 630f BGB) und `audit_log` löschbar. Fix: `BEFORE TRUNCATE`; Runtime-Rolle ohne diese Rechte.

**`audit_log` ohne RLS** (DO-Block: Tabelle fehlt, obwohl `audit_log_no_update` existiert). Auswirkung: `SELECT` sieht mandantenübergreifend Zugriffe auf Gesundheitsdaten. Fix: `ENABLE`+`FORCE` und dieselbe `organization_id`-Policy.

**2FA ohne Limit** (`src/app/(auth)/actions.ts`, `verifyTotpAction`). Fehlversuch nur Audit, Session 12 h (`session.ts`). Auswirkung: 6-stelliger TOTP nach gültigem Passwort erratbar. Fix: Sperre wie beim Passwort; unbestätigte Session auf wenige Minuten; Token nach Erfolg rotieren.

**Azubi gegenzeichnet selbst** (`src/app/(app)/kunden/[id]/doku/actions.ts`, `addAddendumAction`). `kind=countersign` kommt aus dem Formular, keine Rollenprüfung; `countersignRequired` wird nur gesetzt. Fix: Gegenzeichnung nur `owner`/`therapist` und nicht der Autor.

**Hash-Kette nicht belastbar** (dieselbe Datei; `src/lib/records.ts`). Prev-Hash ohne `FOR UPDATE`/Unique; `missingPhotoReason`, `aiAssisted`, `countersignRequired`, `appointmentId` fehlen im Hash. Parallele Saves forken die Kette. Fix: pro Patient serialisieren, Unique(`patient_id`,`prev_hash`), alle fachlichen Felder hashen.

**Gutschein-`ilike`** (`src/server/invoices.ts`, `applyPayments`). `ilike(code, voucherCode)` ohne Escape, erste Zeile `FOR UPDATE`. Code `%` löst einen fremden Gutschein derselben Praxis ein. Fix: `eq` auf normalisiertem Code.

**Keine Rechteprüfung, volle Patientenzeile** (`src/server/invoices.ts`: `createInvoice`, `addPayments`, `cancelInvoice`, `getInvoice`, `listInvoices`, `pushInvoiceToAccounting`). Kein `auth.can`. `getInvoice` macht `select()` auf `patients`. Steuerberatung hat `invoices.read`, laut `permissions.ts` aber nur Finanzen. Fix: `invoices.write`/`invoices.read` erzwingen; nur Rechnungsadresse selektieren.

**Ein Schlüssel alle Mandanten** (`src/lib/storage.ts`, `loadKey` in `storeEncrypted`). AAD ist nur der Pfad. Leak von `APP_ENCRYPTION_KEY` entschlüsselt alle Fotos/Dokumente. Fix: Envelope-Key je `organization_id`.

**Offene Ersteinrichtung** (`setupAction`; `proxy.ts` erlaubt `/einrichtung`). Bei `count(users)=0` kein Secret, `isPlatformAdmin: n===0`, Zähler nicht gesperrt. Wer zuerst kommt, ist Plattform-Admin; parallele Requests erzeugen zwei. Fix: Einmal-Token, Advisory-Lock.

Mittel

**Login-Orakel** (`loginAction`): Sperrtext vor der Passwortprüfung statt generischer Meldung; 8 Versuche sperren das Konto. Fix: gleiche Meldung, IP-Limit.

**`X-Forwarded-For`** (`session.ts`, `requestMeta`): erster Hop ist clientgesteuert und landet in Session/Audit. Fix: nur die vom vertrauenswürdigen Proxy gesetzte Adresse.

**IDOR in der Praxis** (`saveTreatmentAction`): `appointmentId`/`braceEpisodeId` nur gegen `organizationId`, nicht `patientId`. Fremder Termin wird `done`, fremde Spangenepisode abgeschlossen. Fix: `patientId` in die `WHERE`-Klausel.

**Medien-MIME** (`podo_media_guard`; `src/app/api/media/[id]/route.ts`). `mime` ist änderbar und wird als `Content-Type` mit `Content-Disposition: inline` ausgeliefert (auch PDF, gleiche Origin). Fix: `mime` sperren, Magic-Bytes prüfen, Dateien von der Cookie-Origin trennen.

**Positions-Trigger fail-open** (`podo_invoice_lines_guard`): per RLS unsichtbare Rechnung ⇒ `st` NULL ⇒ Änderung erlaubt. Fix: `SECURITY DEFINER`, fehlende Rechnung = Exception.

**Negative Zahlungen** (`paymentInput.amountCents` nur `z.number().int()`; `applyPayments` summiert direkt). Fix: Vorzeichen hier erneut erzwingen.

**Datei vor DB** (`src/app/api/media/route.ts`): `storeEncrypted` schreibt vor dem Insert; bei Fehler bleibt die Datei ohne Datensatz. Fix: Cleanup bzw. Schreiben nach erfolgreichem Insert.

Niedrig

**`proxy.ts`**: keine CSP / `frame-ancestors` (Clickjacking). **`loginAction`**: `memberships … limit(1)` ohne `orderBy` (zufälliger Mandant). **`markSessionVerified`**: derselbe Token; gespeicherte IP/UA werden nie geprüft.