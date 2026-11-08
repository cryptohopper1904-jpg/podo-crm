# Code-Review (Sicherheit): openai/gpt-5.6-sol

## Hoch

1. **Bearer-Tokens dauerhaft in URLs**
   - **Datei/Stelle:** `src/app/portal/[token]/page.tsx`, `src/app/portal/[token]/rechnung/[id]/route.ts`, `src/app/anamnese/[token]/page.tsx`
   - **Problem:** Portal- und Anamnese-Token stehen im URL-Pfad; PDF-Links enthalten den Portal-Token erneut. `Referrer-Policy` verhindert weder Browser-Historie noch Server-, Proxy-, CDN- oder Monitoring-Logs.
   - **Auswirkung:** Ein aus Logs/History erlangter Portal-Token gewährt bis zu 30 Tage Zugriff auf Termine einschließlich Leistungen, Rechnungen, PDFs und Gutscheine sowie Terminabsagen.
   - **Fix:** Token beim ersten Aufruf validieren, gegen eine kurzlebige, `HttpOnly; Secure; SameSite=Strict`-Session austauschen und anschließend auf eine tokenfreie URL umleiten. Token-Pfade und Query-Strings in Infrastruktur-Logs explizit redigieren.

2. **Zahlungsbeträge werden nicht gegen den offenen Rechnungsbetrag geprüft**
   - **Datei/Stelle:** `src/server/webhooks.ts`, `recordProviderPayment()`
   - **Problem:** Jeder positive `input.amountCents` wird gebucht. Es fehlt die Prüfung gegen `inv.totalCents - inv.paidCents`.
   - **Auswirkung:** Eine falsch zugeordnete oder fehlerhafte Provider-Transaktion kann eine Rechnung überzahlen und über `statusFromPayments()` fälschlich als bezahlt markieren.
   - **Fix:** Nach dem `FOR UPDATE` den offenen Betrag berechnen und nur den erwarteten Betrag akzeptieren; mindestens `amountCents <= offen`, bei den hier erzeugten Checkouts exakt `amountCents === offen`. Abweichungen als ungeklärte Zahlung speichern, nicht verbuchen.

3. **Parallele Link-Erzeugung kann mehrere gültige Links hinterlassen**
   - **Datei/Stelle:** `src/server/anamnesis.ts`, `createAnamnesisLink()`; `src/server/portal-core.ts`, `createPortalLink()`
   - **Problem:** „Alte Links widerrufen, dann neuen einfügen“ ist ohne Sperre/Constraint race-anfällig. Zwei Transaktionen können beide vor dem jeweils anderen `INSERT` widerrufen und anschließend je einen gültigen Link anlegen.
   - **Auswirkung:** Ein vermeintlich ersetzter Link bleibt nutzbar und ermöglicht weiterhin Zugriff auf Gesundheits-/Rechnungsdaten.
   - **Fix:** Pro `organizationId + patientId + purpose` einen transaktionalen Advisory Lock verwenden und danach erneut widerrufen/einfügen; zusätzlich passende partielle Unique-Constraints für nicht widerrufene Links vorsehen.

4. **Webhook-Idempotenzschlüssel ist nicht mandantenspezifisch**
   - **Datei/Stelle:** `src/server/webhooks.ts`, `claimWebhookEvent()`
   - **Problem:** Konfliktziel ist nur `[provider, externalId]`, obwohl `organizationId` gespeichert und beim Retry geprüft wird.
   - **Auswirkung:** Gleiche Provider-Event-ID bei zwei Mandanten lässt das Ereignis des zweiten Mandanten als Duplikat verschwinden; Zahlungen/Nachrichten können dort unverbucht bleiben.
   - **Fix:** Unique-Constraint und `onConflictDoNothing` auf `(provider, organization_id, external_id)` ändern.

## Mittel

5. **Nicht gesetzte Online-Einwilligungen widerrufen frühere Einwilligungen nicht**
   - **Datei/Stelle:** `src/server/anamnesis.ts`, `submitOnlineAnamnesis()`
   - **Problem:** Es werden nur angehakte `ONLINE_CONSENTS` mit `granted: true` gespeichert. Für nicht angehakte Typen entsteht kein `granted: false`.
   - **Auswirkung:** Eine ältere Einwilligung kann weiterhin als aktuell gelten, obwohl sie beim neuen Anamnesebogen nicht erteilt wurde.
   - **Fix:** Für jeden Typ aus `ONLINE_CONSENTS` eine Zeile mit dem tatsächlichen Boolean speichern.

6. **Öffentliche Rate-Limits sind instanzlokal und aktiv zurücksetzbar**
   - **Datei/Stelle:** `src/lib/rate-limit.ts`, `createRateLimiter()`; Verwendung in Anamnese und Portal
   - **Problem:** Jede Instanz besitzt einen eigenen Zähler. Bei `hits.size > maxKeys` wird die gesamte Map geleert. Fehlende IPs teilen außerdem den Schlüssel `"unbekannt"`.
   - **Auswirkung:** Limits lassen sich über mehrere Instanzen bzw. genügend Schlüssel umgehen; umgekehrt können alle Clients ohne erkannte IP gemeinsam gesperrt werden.
   - **Fix:** Atomaren zentralen Store verwenden; begrenzte LRU-Eviction statt `hits.clear()`; Anfragen ohne verlässlich ermittelte IP separat und restriktiv behandeln.

7. **Online-Anamnese und Audit sind nicht atomar**
   - **Datei/Stelle:** `src/server/anamnesis.ts`, `submitOnlineAnamnesis()`
   - **Problem:** Gesundheitsdaten und Tokenverbrauch werden committed, erst danach erfolgt `audit()`.
   - **Auswirkung:** Scheitert das Audit, bleiben Daten gespeichert und der Link verbraucht, aber der vorgeschriebene Zugriffsnachweis fehlt; der Client erhält zudem einen Fehler und kann nicht erneut senden.
   - **Fix:** Audit-Eintrag innerhalb derselben DB-Transaktion schreiben oder eine transaktionale Outbox mitspeichern.

8. **Chargennummern sind nur per Vorabprüfung eindeutig**
   - **Datei/Stelle:** `src/server/hygiene.ts`, `createBatch()`
   - **Problem:** `SELECT` auf Duplikat und anschließendes `INSERT` sind nicht atomar.
   - **Auswirkung:** Parallele Requests können identische normalisierte Sterilgut-Chargen erzeugen und die Rückverfolgbarkeit verfälschen.
   - **Fix:** Unique-Index auf `organization_id` plus normalisiertem Chargencode anlegen und Unique-Verletzungen behandeln.