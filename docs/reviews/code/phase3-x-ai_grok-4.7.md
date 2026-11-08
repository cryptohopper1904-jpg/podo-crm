# Code-Review (Sicherheit): x-ai/grok-4.7

Kritisch

1. **Support-Sitzung ist fachlich Owner — Vollabzug** (`src/lib/auth/session.ts`, `getAuth`: `role = "owner"`; `src/app/api/export/praxis/route.ts`, `GET`). `getAuth` setzt bei Break-Glass `role: "owner"` und verlässt sich auf `effectiveCan`. Der Export prüft nur `auth.role !== "owner"`, nicht `auth.support`. Jede gültige Freigabe (auch `read`) lädt per `buildPracticeExport` alle Mandantentabellen und entschlüsselte Medien (Art. 9). **Fix:** Export nur bei echter Mitgliedschaft `owner` und `!auth.support`; Support explizit ausschließen.

2. **Support-Write kann die Praxis zur Löschung vormerken** (`src/app/(app)/einstellungen/daten/actions.ts`, `requireOwner`; `src/lib/auth/access.ts`, `SUPPORT_WRITE_PERMISSIONS`). `requireAuth("settings.manage")` ist für Scope `write` wahr, `requireOwner` prüft danach nur `role !== "owner"`. Damit setzt `requestDeletionAction` `deletionRequestedAt` (und `cancelDeletionAction` kann zurücknehmen). **Fix:** wie in `ownerOnly` `auth.support` hart ablehnen; Löschen nicht an `settings.manage` hängen.

3. **Ersteinrichtung ohne Token wird Plattform-Admin** (`src/app/(auth)/actions.ts`, `setupAction`; Route über `PUBLIC` `/einrichtung`). Der Kommentar verlangt ein Einmal-Token, der Code prüft aber nur `n === 0 && process.env.SETUP_TOKEN && …`. Fehlt die Variable, wird der erste Aufrufer `isPlatformAdmin` mit Plan `internal`. **Fix:** ohne gesetztes `SETUP_TOKEN` die Erstanlage immer ablehnen.

Hoch

4. **Checkout aktiviert den Tarif ohne Zahlungsnachweis** (`src/integrations/stripe/events.ts`, `checkout.session.completed`). `subscriptionStatus: "active"` sowie `plan`/`seats` kommen aus Metadaten, nicht aus Price-IDs; `payment_status` wird nicht gelesen. Ein abgeschlossenes, aber unbezahltes Session-Event schaltet die Praxis frei. **Fix:** nur bei `payment_status === "paid"` und Tarif/Plätze ausschließlich über signierte Price-IDs wie in `planFromItems`.

5. **Abo-Zuordnung über Metadaten, Mismatch-Check lückenhaft** (`src/server/billing.ts`, `findOrg` / Kundenabgleich). `organizationId` aus `client_reference_id` bzw. `metadata` gewinnt. Der Kundenabgleich greift nur, wenn beide IDs gesetzt sind und abweichen. Ist `stripeCustomerId` noch null, werden fremde Kunden-ID, Tarif und Status übernommen. **Fix:** Org nur übernehmen, wenn die Kunden-ID bereits gebunden ist und exakt passt; sonst `unassigned`.

6. **Support-Freigabe ist nicht personengebunden** (`src/app/(app)/einstellungen/support/actions.ts`, Schema ohne Grantee; `src/server/support.ts`, `granteeUserId ?? null`; `src/lib/auth/access.ts`, `isGrantActive`). `null` gilt für jeden Plattform-Admin. Jeder Admin mit 2FA kann `enterSupport` und damit Fund 1 nutzen. **Fix:** konkrete Admin-User-ID erzwingen; `null` verbieten.

7. **`import.run` im Support-Write** (`src/lib/auth/access.ts`). Kommentar verbietet Patienten-/Dokumentationsänderung, die Allowlist enthält `import.run` (plus `integrations.manage`). **Fix:** `import.run` streichen; Integrationen nur lesen oder Secrets nie an Support ausliefern.

8. **Sperre gilt nicht für bestehende Sitzungen** (`src/app/(auth)/actions.ts`, `lockedUntil` nur in `loginAction`; `src/lib/auth/session.ts`, `getSession`/`getAuth`). Nach Sperre oder Entzug bleiben Cookies bis zu 12 Stunden gültig. **Fix:** `lockedUntil` und Sitzungs-Revocation in `getSession` prüfen; bei Sperre alle Sessions des Users löschen.

Mittel

9. **`invoice.payment_failed` setzt ungeprüft `past_due`** (`src/integrations/stripe/events.ts`; Reihenfolge nur für `customer.subscription.*` in `src/server/billing.ts`). Ein verspätetes Rechnungs-Event stuft eine aktive Praxis herab (Schreibzugriff auf Behandlungsdaten). **Fix:** Status nur aus dem aktuellen Subscription-Objekt; ältere `created`-Zeiten für alle Event-Typen verwerfen.

10. **2FA-Brute-Force über neue Sessions** (`src/app/(auth)/actions.ts`, `verifyTotpAction`). Zähler hängt an der Session (5 Versuche), jeder Login legt eine neue an; `totpLastStep` wird erst nach dem Vergleich geschrieben (TOCTOU, Replay parallel). **Fix:** Fehlversuche am User zählen, bei Schwelle alle Sessions löschen, Step atomar per `UPDATE … WHERE totp_last_step < $step` setzen.

11. **Konto-Orakel nach gültigem Passwort** (`loginAction`: „keine Praxis freigeschaltet“). **Fix:** dieselbe generische Meldung wie bei Fehlpasswort.

12. **`billing_events` ohne RLS, volles Stripe-Payload** (`src/server/billing.ts`, `payload: ev`; `drizzle/0010_phase3_security.sql`). Namen, E-Mail, Adresse liegen mandantenübergreifend in der App-Rolle. **Fix:** Payload minimieren oder getrennt mit restriktiver Rolle speichern.

13. **Telefonagent speichert Gesundheits-/Kontaktdaten zu weit** (`src/server/voice.ts`, `book`/`inbox`: Klartext-Telefon in `messages`; `src/integrations/voice/core.ts`, `recordingAnnounced`). Die Aufzeichnungsansage steht nur im vom Anbieter gelieferten Transkript. **Fix:** Speichern nur bei eigenem Consent-Flag; Nummer in Nachrichten maskieren.

14. **Session-Update ohne User-Bindung** (`src/server/support.ts`, `enterSupport`/`exitSupport`). `UPDATE sessions` filtert nur `sessions.id`. **Fix:** `AND user_id = $userId`.

Niedrig

15. **Webhook-Antwort** (`src/app/api/billing/webhook/route.ts`) liefert `result` (`unassigned`/`duplicate`) entgegen dem Orakel-Kommentar. **Fix:** nur `{ received: true }`.

16. **Audit-IP** (`src/lib/auth/session.ts`, `requestMeta`) nimmt das letzte `X-Forwarded-For` ohne Proxy-Allowlist. **Fix:** IP nur vom direkten Peer bzw. einem geprüften Hop.

17. **Cookie** (`createSession`): kein `__Host-`-Präfix, `secure` nur bei `NODE_ENV === "production"`. **Fix:** `__Host-podo_session`, `secure: true`, `sameSite: "lax"` beibehalten.