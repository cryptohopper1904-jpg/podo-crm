# Gesamt-Review (Sicherheit, extern): mistralai/mistral-large-4-0

Geprüfte Dateien: src/lib/auth/session.ts, src/lib/auth/access.ts, src/lib/auth/cookie.ts, src/lib/auth/permissions.ts, src/lib/auth/support-view.ts, src/lib/auth/client-ip.ts, src/server/authz.ts, src/proxy.ts, src/app/api/webhooks/[provider]/route.ts, src/server/webhooks.ts, src/server/portal-core.ts, src/server/kasse.ts, src/server/practice-export.ts, src/app/api/voice/[provider]/route.ts, src/server/support.ts

**Kritisch:** Keine im vorliegenden Code belegbaren kritischen Lücken.

**Hoch**

1. **Webhook-Authentisierung per statischem Token im Query-String** – `src/app/api/webhooks/[provider]/route.ts:110` (`safeEqual(req.nextUrl.searchParams.get("token"), secret.webhookToken)`) für `lexoffice`, `sms`, `voice_agent`. Das Token landet in der URL und damit potenziell in Proxy-/Access-Logs; bei Leak sind gefälschte Webhooks möglich (z. B. SMS/WhatsApp mit gefälschter Absenderadresse → Eintrag in die Patientenakte, Verstoß gegen Art. 9 DSGVO / § 203 StGB). **Fix:** HMAC-Signatur über den Roh-Body wie bei SumUp/WhatsApp; Token nie in der URL.

2. **Praxis-Export ohne serverseitige Berechtigungs-/Mandantenprüfung in der Funktion selbst** – `src/server/practice-export.ts:49-52`: `buildPracticeExport(opts)` verwendet `opts.organizationId` direkt, ohne `assertCan` und ohne Abgleich mit `auth.organization.id`. Wenn eine Route `organizationId` aus Request-Daten übernimmt, ist ein vollständiger DSGVO-Export (inkl. Gesundheitsdaten und entschlüsselter Medien) beliebiger Praxen möglich. **Fix:** `assertCan(auth, "settings.manage")` (oder owner-only) in der Funktion; `organizationId` ausschließlich aus `auth.organization.id` beziehen.

3. **Kein Rate-Limiting am öffentlichen Webhook-POST** – `src/app/api/webhooks/[provider]/route.ts:85-162` (Gegensatz: `src/app/api/voice/[provider]/route.ts:28-29`). DoS durch Request-Flut und Brute-Force auf `?token=` möglich. **Fix:** Rate-Limiter je IP (Fails) und je org vor der Authentisierung, analog Voice-Route.

**Mittel**

4. **Vapi-Auth als statischer Secret-Vergleich ohne Body-Signatur → Replay** – `src/app/api/voice/[provider]/route.ts:73` i. V. m. Kommentar Zeile 20 (`x-vapi-secret`, zeitkonstanter Vergleich). Ein abgehörter Request kann unbegrenzt wiederholt werden (kein Timestamp/Nonce). **Fix:** HMAC-SHA256 über Body + Timestamp + Nonce (wie Retell), Timestamp-Fenster serverseitig prüfen.

5. **`bodyHash` als Idempotenzschlüssel für WhatsApp/SMS/Voice** – `src/app/api/webhooks/[provider]/route.ts:122` (`let externalId = bodyHash(rawBody)`); nur SumUp/lexoffice überschreiben mit `normalized.externalId`. Gleicher Body (z. B. zweimal „Ja“) wird als Duplikat verworfen → Datenverlust in der Patientenkommunikation. **Fix:** Provider-eigene `externalId` (Nachrichten-/Anruf-ID) verwenden.

6. **Portal-Link-Token in der URL** – `src/server/portal-core.ts:43` (`${base}/portal/${token}`). Token kann in Server-/Proxy-Logs, Browser-History oder Referrer landen; bei Leak 30 Tage Portal-Zugriff auf Gesundheitsdaten. **Fix:** Token nur einmalig ausliefern (z. B. POST), sofort HttpOnly-Cookie setzen und URL danach tokenfrei halten; kurze Lebenszeit.

**Niedrig**

7. **Support-Grants mit `granteeUserId = null` gelten für alle Plattform-Admins** – `src/lib/auth/access.ts:64` (`g.granteeUserId === null || g.granteeUserId === userId`). Alt-Freigaben ohne Personenbindung erlauben jedem 2FA-Admin Zugriff. **Fix:** Null-Grants migrieren/löschen; nur personengebundene Grants zulassen.

8. **WhatsApp-Verify-GET ohne Rate-Limiting** – `src/app/api/webhooks/[provider]/route.ts:71-83`. Enumeration/Brute-Force auf `org` + `hub.verify_token` möglich. **Fix:** Rate-Limiter je IP.

9. **`externalId` auf 300 Zeichen gekürzt** – `src/server/webhooks.ts:23` (`externalId.slice(0, 300)`). Kollisionsgefahr bei langen Provider-IDs; Duplikaterkennung kann fehlschlagen. **Fix:** Vollständigen Schlüssel verwenden (z. B. SHA-256 des `externalId`).