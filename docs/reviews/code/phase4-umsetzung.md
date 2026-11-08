# Phase 4 – Umsetzung der externen Sicherheitsreviews (GPT-5.6, Gemini Pro)

Quellen: `phase4-openai_gpt-5.6-sol.md`, `phase4-google_gemini-pro-latest.md`.

| # | Befund | Schwere | Status | Regressionstest |
|---|---|---|---|---|
| 1 | KIM `resolvePublic`: IP-Literale ohne `isPrivateIp` (SSRF) | kritisch | **behoben** – gemeinsame `resolvePublicAddress` (net-guard) prüft auch IP-Literale; `isPrivateIp` normalisiert IPv6 vollständig (ausgeschriebene Formen wie `0:0:0:0:0:0:0:1`, Zonen-ID, `::ffff:`-Mapping auch in Hex-Form, `::a.b.c.d`, 6to4, NAT64, fc00::/7, fe80::/10, fec0::/10, Multicast) | `kim.test.ts`, `net-guard.test.ts` |
| 2 | Praxis-SMTP: DNS-Rebinding zwischen Prüfung und nodemailer-Verbindung | hoch | **behoben** – Host wird einmal aufgelöst und geprüft, nodemailer verbindet mit der geprüften IP; `tls.servername` = Hostname (Zertifikat weiter gegen den Hostnamen geprüft) | `server/mail.test.ts`, `integrations/mail/mail.test.ts` |
| 3 | Plattform-SMTP (`SMTP_URL`) ohne erzwungenes TLS | hoch | **behoben** – `SMTP_URL` wird zerlegt (nur `smtp://`/`smtps://`), `requireTLS` bzw. implizites TLS, `tls.minVersion = TLSv1.2`, `rejectUnauthorized`; Klartext nur außerhalb der Produktion zu `localhost` (Mailcatcher). Plattform-SMTP ist Betreiber-Konfiguration und wird nicht auf öffentliche Adressen beschränkt | `integrations/mail/mail.test.ts` |
| 4 | Retell: Legacy-Signatur ohne Zeitstempel (Replay) | hoch | **behoben** – nur noch `v=<ts>,d=<hex>` mit ±5 min | `retell.test.ts` |
| 5 | eVerordnung: Patientenanlage und Verordnung nicht atomar | mittel | **behoben** – Validierung vorab; Personenwahl/-anlage, Dublettenprüfung und Verordnung in einer Transaktion (`savePrescription(…, { tx })`, Rollback bei jedem Fehler); Audit erst nach Commit. Andere Aufrufer (Formular, OCR) unverändert | `everordnung.db.test.ts` |
| 6 | Praxisexport enthält `settings.ocr.apiKeyEnc` | mittel | **behoben** – `sanitizeOrganizationRow` entfernt rekursiv alle Schlüssel `/enc$\|secret\|password\|token\|api_?key/i` aus `settings` | `lib/practice-export.test.ts`, `practice-export.db.test.ts` |
| 7 | POP3: Sockets bleiben bei Fehlern/Zeitlimit offen | mittel | **behoben** – `connect()` schließt bei jedem Fehler; Transportfehler (Zeitlimit, Abbruch, Größenlimit) schließen die Verbindung, reguläre `-ERR`-Antworten nicht; abgelaufene Waiter werden entfernt und der Stream zerstört | `kim.test.ts` |
| 8 | `findCandidates`: `ilike` mit ungeescaptem Nachnamen (`%`) | mittel | **behoben** – exakter Vergleich `lower(last_name) = lower(:name)` | `everordnung.db.test.ts` |
| 9 | KIM `buildMail`: From/To/Subject ohne CRLF-Prüfung | mittel | **behoben** – From/To müssen gültige Adressen ohne CR/LF sein (sonst `SmtpError`), Betreff ohne Steuerzeichen/Zeilenumbrüche (RFC 2047), `domain` geprüft | `kim.test.ts` |
| 10 | `listSupportGrants` ohne Berechtigungsprüfung | mittel | **behoben** – nur Inhaber:in oder `settings.manage`, nie im Support-Modus; Einstellungsseite (Inhaber:in) unverändert | `auth-sessions.db.test.ts` |
| 11 | `runKimSyncAll` sequenziell, eine hängende Praxis blockiert alle | niedrig | **behoben** – höchstens 5 Praxen parallel (`mapPool`, jede mit eigenen kurzen Transaktionen), hartes Zeitlimit 60 s je Praxis (`withTimeout`); Fehler isoliert | `lib/pool.test.ts`, `kim.db.test.ts` |

Hinweis zu 11: Das Zeitlimit verwirft das Ergebnis; die Operation selbst endet über die POP3-Zeitlimits je Befehl (Socket wird dabei jetzt zuverlässig geschlossen, siehe 7).

Prüfung: `next typegen`, `tsc --noEmit`, `eslint src scripts`, `vitest run` (inkl. DB-Tests) – alle grün.
