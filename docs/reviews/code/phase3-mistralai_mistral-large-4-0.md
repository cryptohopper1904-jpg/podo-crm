# Code-Review (Sicherheit): mistralai/mistral-large-4-0

# Security-Review – konkrete Befunde

## KRITISCH

**1. Vollständiger Praxis-Export (alle Gesundheitsdaten + entschlüsselte Medien) im Support-/Break-Glass-Modus möglich**
- **Stelle:** `src/app/api/export/praxis/route.ts` (GET): `if (!auth || auth.role !== "owner")` – kein Support-Check. Ursache in `src/lib/auth/session.ts` (`getAuth`): Im Support-Zweig wird `role = "owner"` gesetzt („nur für Anzeige").
- **Auswirkung:** Jeder Plattform-Admin mit *beliebiger* aktiver Freigabe – auch Scope „read" – passiert die Owner-Prüfung und lädt das komplette ZIP (`tables/*.json` inkl. Patienten, voice_calls, Transkripte; `media/` entschlüsselte Fotos/Audios). Break-Glass wird zur Vollexfiltration; Verstoß gegen Art. 9/32 DSGVO und die Zweckbindung der Freigabe.
- **Fix:** `if (!auth || auth.support || auth.role !== "owner") return 403;` plus dedizierte Permission `org.export` (nicht in `SUPPORT_WRITE_PERMISSIONS`, nicht `.read`). Regressionstest: Support-Admin (read und write) muss 403 erhalten.

## HOCH

**2. Löschantrag der Praxis durch Support-Admin auslösbar**
- **Stelle:** `src/app/(app)/einstellungen/daten/actions.ts` `requireOwner()`: `requireAuth("settings.manage")` + `auth.role !== "owner"`. `settings.manage` steht in `SUPPORT_WRITE_PERMISSIONS` (`src/lib/auth/access.ts`), `effectiveCan()` liefert bei Support-write `true`, und `role` ist im Support-Modus gefälscht `"owner"`.
- **Auswirkung:** Break-Glass-Admin mit Write-Scope setzt `deletionRequestedAt` (bzw. nimmt die Löschung zurück) – nach Karenzzeit löscht das Purge-Skript alle Mandantendaten endgültig.
- **Fix:** In `requireOwner()` zusätzlich `if (auth.support) throw …` (Vorbild: `ownerOnly()` in `src/server/support.ts`). Grundsätzlich nie `auth.role` allein prüfen, wenn Support-Modus möglich ist.

**3. Kein IP-Rate-Limiting am Login → Password Spraying**
- **Stelle:** `src/app/(auth)/actions.ts` `loginAction()` – nur Konto-Sperre (8 Fehlversuche / 15 min pro Konto); im Gegensatz zu `setupAction()` fehlt `createRateLimiter` auf die IP.
- **Auswirkung:** Unbegrenzte Anmeldeversuche über viele Konten hinweg gegen eine App mit Patientenzugang.
- **Fix:** `loginLimiter = createRateLimiter({ windowMs: 900_000, max: 20 })` auf `clientKey(await requestMeta())` vor der Passwortprüfung; generische Fehlermeldung beibehalten.

## MITTEL

**4. Session-Token wird beim Wechsel in eine fremde Praxis nicht rotiert**
- **Stelle:** `src/server/support.ts` `enterSupport()`/`exitSupport()` und `src/app/(auth)/actions.ts` `switchOrganizationAction()`: nur `UPDATE sessions SET organization_id` – das Token bleibt identisch (Rotation existiert nur in `markSessionVerified()`).
- **Auswirkung:** Derselbe Token wechselt den Mandanten; ein abgefangener Token gewährt während aktiver Freigabe Zugriff auf die fremde Praxis (`getAuth` prüft den Grant am User, nicht am Token).
- **Fix:** Beim Setzen einer fremden `organizationId` neues Token ausgeben (delete + `createSession` wie in `markSessionVerified`).

**5. Support-Freigaben gelten standardmäßig für ALLE Plattform-Admins**
- **Stelle:** `src/app/(app)/einstellungen/support/actions.ts` `grantSupportAction()` – das Zod-Schema enthält kein `granteeUserId`, daher immer `null`; `isGrantActive()` (`access.ts`) matcht `granteeUserId === null` auf jeden `is_platform_admin`.
- **Auswirkung:** Bei Scope „write" kann jeder Betreiber-Admin `settings.manage`/`integrations.manage`/`import.run` ausüben.
- **Fix:** `granteeUserId` als Pflichtfeld mit konkreter Admin-Auswahl; `null` nur mit explizitem Warnhinweis.

**6. `requireAuth()` ohne Permission im Support-write für beliebige Mutationen freigegeben**
- **Stelle:** `src/lib/auth/access.ts` `mutationAllowedWithoutPermission()` + `src/lib/auth/session.ts` `requireAuth()`: Support + Scope „write" + mutierend → `true` ohne jegliche Permission-Prüfung.
- **Auswirkung:** Jede Server Action / Route, die nur `requireAuth()` (ohne Argument) aufruft, ist im Break-Glass-write ausführbar.
- **Fix:** Allowlist für Support-write-Aktionen oder verpflichtendes Permission-Argument; alle `requireAuth()`-Aufrufe ohne Argument auditieren.

**7. `billing_events` ohne RLS speichert komplettes Stripe-Event inkl. PII**
- **Stelle:** `drizzle/0010_phase3_security.sql` (Kommentar: „bewusst ohne RLS") + `src/server/billing.ts`: `payload: ev` (gesamtes Event).
- **Auswirkung:** Name, E-Mail, Rechnungsadresse ggf. USt-ID aller Praxen liegen plattformweit für die App-Rolle lesbar und unbefristet gespeichert.
- **Fix:** `payload` auf notwendige Felder reduzieren (id/type/created/relevante IDs); Löschfrist; Lesezugriff nur über Owner-Rolle.

## NIEDRIG

**8. `getSession()` liest komplettes `users`-Row inkl. `passwordHash` und `totpSecretEnc`** – `src/lib/auth/session.ts` (`innerJoin(users, …)` ohne Spaltenauswahl). Auswirkung: jedes unbeabsichtigte Weiterreichen von `row.user` leaked Hash/Secret. Fix: Spalten explizit selektieren.

**9. E-Mail-Enumeration bei Registrierung** – `setupAction()` in `src/app/(auth)/actions.ts`: „Für diese E-Mail gibt es bereits ein Konto." Fix: generische Meldung, Bestätigung per E-Mail.

**10. Audit-Log-Spam im Support-Modus** – `getAuth()` (`src/lib/auth/session.ts`) schreibt `support.view` bei *jedem* Request (auch API-Calls, da der Proxy den Header für alle Pfade setzt) in die append-only-Tabelle. Auswirkung: Log-Bloat/DoS-Vektor. Fix: nur Seitenaufrufe protokollieren oder Rate begrenzen.