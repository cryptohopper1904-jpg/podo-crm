# Code-Review (Sicherheit): x-ai/grok-4.7

**Kritisch**

1. `src/app/api/webhooks/[provider]/route.ts`, `POST`: Signatur nur bei SumUp/WhatsApp und nur wenn `webhookSecret`/`appSecret` gesetzt ist. Lexoffice, SMS und Voice laufen immer unsigniert; fehlt das Geheimnis, werden SumUp/WhatsApp ebenfalls akzeptiert. Org-UUID steht in `?org=` (Logs, Referer). Folge: gefälschte Zahlungsereignisse (`processSumupEvent`), eingehende Nachrichten (`storeInboundMessages`) und beliebige Payloads in `webhook_events`; `externalId` aus dem Payload kann echte Events als Duplikat verwerfen. Fix: Fail-closed, providerfeste Signatur (HMAC, Zeitfenster, Replay-Cache) vor dem Speichern; Org nicht als alleiniges Authenticator.

2. `src/app/buchen/[slug]/actions.ts`, `bookAction`: Unauthentifiziert wird jeder Patient mit gleichem Nachnamen und gleicher Telefonnummer oder E-Mail an die Buchung gehängt; zusätzlich werden `privacy_notice`- und `no_show_terms`-Consents mit `granted: true` geschrieben, Notiz landet in Termin und Posteingang. Folge: Zuordnung und Consent-Falschung in der Patientenakte, Termin-Squatting. Fix: immer neuen Interessenten anlegen, kein Consent auf Bestand; Merge nur nach Praxis-Bestätigung. Slot-Insert mit Ausschluss-Constraint/`FOR UPDATE`.

**Hoch**

3. `src/app/api/ai/voice-report/route.ts` und `src/app/(app)/posteingang/actions.ts` (`suggestReplyAction`): `redact()` wird nicht aufgerufen. Audio, Transkript, `knownNames`, `m.body` und `replyFacts` gehen an Transkription/LLM; `dataProcessingApproved` prüft die Route nicht. Folge: Art.-9-Daten an Dritte ohne die vorgesehene Minimierung. Fix: Freigabe erzwingen, `redact()` vor jedem Versand, Map nur lokal.

4. Dieselbe Voice-Route, Zweig `transcriber.isMock`: festes klinisches `MOCK_TRANSCRIPT`/`MOCK_FIELDS` wird als Bericht geliefert, auch mit echter `patientId`. `registry.ts` `isMockMode`: `INTEGRATIONS_MODE=mock` oder Status `mock` schaltet SumUp, Messaging und LLM global/pro Mandant auf Mock, ohne `NODE_ENV`-Sperre. Folge: erfundene Befunde bzw. fingierte Zahlungs-/Versand-Erfolge. Fix: Mock in Produktion verbieten; bei Mock kein speicherbarer Kliniktext.

5. `src/app/(app)/einstellungen/schnittstellen/actions.ts`, `saveIntegrationAction`: `config_*` (u. a. `baseUrl`) ohne Allowlist, Test liefert `res.message` an Client und `logSync`. Folge: SSRF vom App-Host (Metadata, interne Dienste) durch Mandanten-Admin. Fix: HTTPS-Allowlist, keine internen Netze, Fehlertexte ohne Upstream-Body.

6. `src/app/buchen/[slug]/actions.ts`: Overlap-Check ohne Sperre/Exclusion; `limited()` ist prozesslokal, `hits` wird nie evicted, Limit 5/h umgehbar. Folge: Doppelbelegung, Memory-DoS. Fix: DB-Constraint plus zentrales Rate-Limit.

**Mittel**

7. `src/app/(app)/einstellungen/import/actions.ts`, `doctolibImportAction`: `max(number)+1` ohne `pg_advisory_xact_lock` (Buchung nutzt ihn). Entwürfe ohne `externalId` gelten immer als neu. Folge: Nummernkollision, Dubletten. Fix: derselbe Lock, Idempotenz über Hash.

8. `src/app/(app)/posteingang/actions.ts`, `sendReplyAction`: `subject`/`fromAddress` ohne CR/LF-Filter; bei gefälschtem Webhook Header-Injection bzw. Antwort an Angreiferadresse. Fix: Adresse validieren, Header-Zeichen strippen; WhatsApp/SMS serverseitig ohne Freitext-Medizin.

9. `src/app/api/calendar/[token]/route.ts`: Feed enthält Initialen, Leistungskürzel, Hausbesuch, Praxisname; `Cache-Control: private, max-age=300`; kein Consent-Check. Folge: Behandlungsbezug an Kalender-Anbieter, Token in Logs. Fix: `no-store`, kurzlebiger rotierbarer Token, minimale Felder, Consent-Gate.

10. Fehlertexte: Voice-Route und `excelImportAction` geben `e.message` an den Client (`Unbekannte Praxis` vs `Unbekannt` ist Org-Orakel). Fix: generische Meldungen, Details nur ins Audit.

**Niedrig**

11. `src/app/buchen/[slug]/actions.ts`: `tx.select().from(patients)` lädt bei öffentlicher Anfrage volle Patientenrows aller gleichen Nachnamen. Fix: nur Match-Spalten, normalisierte Telefon/E-Mail-Suche.

12. `doctolibImportAction`-Preview schreibt kein Audit (Excel-Preview schon). Fix: gleicher Audit-Eintrag mit Hash, ohne Probenamen.