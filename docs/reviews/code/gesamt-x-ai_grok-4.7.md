# Gesamt-Review (Sicherheit, extern): x-ai/grok-4.7

Geprüfte Dateien: src/lib/auth/session.ts, src/lib/auth/access.ts, src/lib/auth/cookie.ts, src/lib/auth/permissions.ts, src/lib/auth/support-view.ts, src/lib/auth/client-ip.ts, src/server/authz.ts, src/proxy.ts, src/app/api/webhooks/[provider]/route.ts, src/server/webhooks.ts, src/server/portal-core.ts, src/server/kasse.ts, src/server/practice-export.ts, src/app/api/voice/[provider]/route.ts, src/server/support.ts

## Kritisch

**1. TSE-Signatur mit falschen Steuerbeträgen** — `src/server/webhooks.ts:121-127`  
`signRegisterPayment` erhält `amountCents` der einzelnen Zahlung, `vatGroups` aber die Summe **aller** Rechnungspositionen. Teilzahlung und jede Folgezahlung (`status` `partially_paid`, Zeile 113) erzeugen eine Signatur, deren MwSt nicht zum signierten Betrag passt. Die Werte liegen danach in `fiscal_transactions` und im Z-Bon (`src/server/kasse.ts:160-176`).  
**Auswirkung:** KassenSichV-Aufzeichnungen sind für Kartenzahlung/Zahlungslink sachlich falsch.  
**Fix:** MwSt anteilig auf `amountCents` zuteilen (bzw. nur den offenen Anteil); Summe der Gruppen muss `amountCents` ergeben, sonst nicht signieren.

## Hoch

**2. Kartenzahlung bei TSE-Ausfall ohne Fiskalspur** — `src/server/webhooks.ts:128-141` und `src/server/kasse.ts:166-179`  
Bei `FiscalSignError` wird die Zahlung trotzdem eingefügt, `storeSignature` entfällt. Im Abschluss ist `tse` nur aus `fiscal_transactions` belegt, bei Nicht-Bar ohne Zeile immer `null`. Nur eine Posteingangsnotiz (Zeile 143-153), kein Ausfalldatensatz. Zusätzlich liegt `signRegisterPayment` **in** der `withOrg`-Transaktion (Zeile 96-127): Rollback nach erfolgreicher TSE-Antwort erzeugt eine Signatur ohne Zahlung; Retry signiert erneut.  
**Fix:** Ausfall strukturiert am Vorgang speichern und in Bon/DSFinV-K kennzeichnen; TSE-Aufruf nach Commit bzw. mit Idempotenzschlüssel, Zahlung bei offener Signatur nicht als abgeschlossen behandeln.

**3. Geschlossene Kassentage sind nicht dicht** — `src/server/webhooks.ts:133-141`, `src/server/kasse.ts:203`, `241-249`, `297-357`, `632-643`  
`assertPaymentsEditable` wird nirgends aufgerufen. `recordProviderPayment` und `addCashMovement` nehmen `cash-closing:${org}` nicht. `closeDay` ordnet nur die zuvor gelesenen IDs zu. Eine Zahlung mit `paidAt` im schon abgeschlossenen Zeitraum bleibt `cashClosingId = null` und fällt in den **nächsten** Z-Bon (`openUntil`, Zeile 106/112); derselbe Tag kann nicht erneut geschlossen werden (Zeile 291-292).  
**Fix:** Dieselben Advisory-Locks und `podo_payment_in_closed_period` beim Insert; Nachzügler als expliziten Nachbucher kennzeichnen, nicht still dem Folgetag zuschlagen.

**4. Webhook wird mit 200 abgeschlossen, obwohl die Verarbeitung hängen bleibt** — `src/server/webhooks.ts:30-43`, `src/app/api/webhooks/[provider]/route.ts:137-155`  
Claim setzt bei Neuanlage weder `error` noch `processedAt`. Retry verlangt `error IS NOT NULL`. Stirbt `after()` vor `finishWebhookEvent`, ist das Ereignis dauerhaft „in Arbeit“, der Handler antwortet trotzdem `{ ok: true }`. Der Anbieter stellt nicht erneut zu.  
**Fix:** Lease/`locked_until`; abgelaufene Claims erneut vergeben; 200 nur nach dauerhaftem Commit der Fachbuchung.

**5. `voice_agent`-Webhook ohne Mandant und ohne Abschluss** — `src/app/api/webhooks/[provider]/route.ts:148-155`  
Anders als SumUp/WhatsApp/SMS wird `handleVoiceAgentWebhook(payload)` nicht awaited und die bereits geprüfte `org` nicht übergeben. `finishWebhookEvent` läuft sofort erfolgreich; ein späterer Fehler wird nicht gefangen und nicht erneut verarbeitet. Der Pfad ist öffentlich (`src/proxy.ts:8`). `/api/voice` übergibt `org` (`src/app/api/voice/[provider]/route.ts:86`), dieser Zweig nicht.  
**Fix:** `await handleVoiceAgentWebhook(org, payload)` und Fehler an `finishWebhookEvent` geben; denselben Claim wie bei den anderen Providern.

**6. Support-Audit per Client-Header abschaltbar** — `src/proxy.ts:14-16`, `src/lib/auth/support-view.ts:27-29` und `47-48`, `src/lib/auth/session.ts:224-234`  
Der Proxy überschreibt nur `x-podo-method`/`x-podo-path`. `purpose`, `sec-purpose` und `next-router-prefetch` bleiben clientseitig. `shouldLog` verwirft damit jede nicht schreibende Support-Anfrage. Gesundheitsdaten-Lesezugriffe im Break-Glass erscheinen nicht als `support.view`.  
**Fix:** Prefetch nur über einen vom Proxy gesetzten Header erkennen; Client-Header vor dem Weiterreichen entfernen. Query-String mitprotokollieren (derzeit nur `pathname`, `src/proxy.ts:16`).

**7. Abgelaufene Support-Sitzung wird ohne Rotation auf eine volle Mitgliedschaft umgehängt** — `src/lib/auth/session.ts:206-217` gegenüber `60-82` und `src/server/support.ts:142-143`  
Beim Grant-Ende setzt `getAuth` `organizationId` per `UPDATE` auf `limit(1)` ohne `ORDER BY` (beliebige aktive Mitgliedschaft) und lässt das Cookie stehen. `enterSupport`/`exitSupport` rotieren ausdrücklich. Ein während des Supports entwendetes Token (nur `effectiveCan`-Leserechte, Rolle hart `owner` nur zur Anzeige, Zeile 220) wird so zur normalen Sitzung mit Matrix-Rechten der Zielfpraxis.  
**Fix:** `rotateSession` oder Sitzung löschen und Neu-Login; Zielpraxis eindeutig wählen, nicht `limit 1`.

**8. Vollständiger Praxisexport ohne Rechteprüfung und ohne Audit** — `src/server/practice-export.ts:49-226`  
`buildPracticeExport` nimmt eine rohe `organizationId`, prüft weder Rolle noch `AuthContext` und ruft `audit` nicht auf. Entschlüsselte Medien und alle Mandantentabellen (Art. 9) verlassen so die Funktion. Gegenstück mit Kontrolle: `buildDsfinvkExport` (`src/server/kasse.ts:574-615`). Dieselbe Lücke: `zBonPdfForOrg` (`src/server/kasse.ts:539-550`) ohne `assertCan`, im Gegensatz zu `getClosing` (Zeile 534-536).  
**Fix:** `AuthContext` + `assertCan` (Export nur Inhaber) und Audit vor dem Stream; `zBonPdfForOrg` analog `cash.read`.

## Mittel

**9. Token-Webhooks nicht fail-closed** — `src/app/api/webhooks/[provider]/route.ts:104-110`  
SumUp/WhatsApp verlangen `!!secret.…`. lexoffice/SMS/`voice_agent` rufen `safeEqual(token, secret.webhookToken)` auch auf, wenn `secretOf` `{}` liefert (Zeile 36-41). Das in Zeile 102 beschriebene „ohne Geheimnis immer ablehnen“ fehlt. Das Token steht in der Query (`?token=`), also in Access-Logs und Referer.  
**Fix:** `!!secret.webhookToken &&` wie Zeile 106; Token nur per Header.

**10. `checkoutRef` nicht eindeutig** — `src/server/webhooks.ts:101-104`  
`limit(1)` ohne `ORDER BY` und ohne Konfliktprüfung. Bei doppelter `checkoutRef` wird eine beliebige Rechnung gesperrt und bebucht.  
**Fix:** Eindeutigkeit erzwingen; bei ≠1 Treffer nicht buchen, nur `reportUnassignedPayment`.

**11. Support-Freigabe weiter als das Personenmodell** — `src/lib/auth/access.ts:61-72`, `src/server/support.ts:16-19`  
`granteeUserId === null` gilt für jeden Plattform-Admin mit 2FA. `pickActiveGrant` nimmt die längste Laufzeit, nicht den engsten Scope: eine ältere `write`-Freigabe verdeckt eine kürzere `read`-Freigabe.  
**Fix:** `null` nicht mehr akzeptieren; bei Überlappung den restriktiveren Scope verwenden.

**12. `exitSupport` schreibt Audit in eine beliebige Praxis** — `src/server/support.ts:149-156`  
Keine Prüfung, dass `fromOrganizationId` die aktuelle Sitzungspraxis ist oder überhaupt Support bestand. `enterSupport` (`131-143`) prüft nicht `session.verified`; `rotateSession` kopiert `verified` (`src/lib/auth/session.ts:73`).  
**Fix:** `fromOrganizationId` nur aus der Sitzungszeile; `verified` erzwingen; Audit in derselben Transaktion wie die Rotation.

## Niedrig

**13. Portal-Lock 32-Bit** — `src/server/portal-core.ts:62`  
`hashtext` kollidiert praxisübergreifend (Kasse nutzt `hashtextextended`, `src/server/kasse.ts:203`). Fremde Link-Anlage kann serialisiert werden.  
**Fix:** `hashtextextended` wie beim Tagesabschluss.