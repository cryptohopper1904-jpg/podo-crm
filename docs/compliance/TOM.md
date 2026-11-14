# Technische und organisatorische Maßnahmen (Art. 32 DSGVO) – Entwurf

Anlage zum Auftragsverarbeitungsvertrag (`docs/legal/AVV.md`). Fassung: Entwurf, Stand 13.11.2026.

**Auftragsverarbeiter / Betreiber von PodoHero:** Pitt Petruschke, Veltener Straße 33, 16540 Hohen Neuendorf, Deutschland · E-Mail: cryptohopper1904@gmail.com

## Vertraulichkeit
| Maßnahme | Umsetzung | Nachweis im Code |
|---|---|---|
| Zugangskontrolle | Passwort ≥ 12 Zeichen, Argon2id; Sperre nach 8 Fehlversuchen (15 Min); 2FA (TOTP) | `src/lib/auth/*`, `src/app/(auth)/actions.ts` |
| Sitzungen | Zufallstoken (256 Bit), nur Hash in DB, HttpOnly/Secure/SameSite-Cookie, 12 h Laufzeit | `src/lib/auth/session.ts` |
| Zugriffskontrolle | Rollen (Inhaber, Podologe, Empfang, Azubi, Steuerberatung) mit Rechtematrix; Empfang ohne medizinische Inhalte | `src/lib/auth/permissions.ts` |
| Mandantentrennung | App-Filter + PostgreSQL Row-Level-Security (FORCE), App-Rolle ohne Superuser; automatisierter Test | `drizzle/0001_security.sql`, `src/db/security.test.ts` |
| Verschlüsselung at rest | Fotos/Audio/Dokumente AES-256-GCM vor dem Speichern; Zugangsdaten und 2FA-Secrets AES-256-GCM | `src/lib/storage.ts`, `src/lib/crypto.ts` |
| Verschlüsselung in transit | HTTPS (Caddy, automatische Zertifikate), HSTS | `deploy/Caddyfile`, `next.config.ts` |
| Datensparsamkeit Dritte | Routen: nur Adresse an Maps; lexoffice: keine medizinischen Daten; KI: Redaktion + Freigabeschalter; iCal ohne Namen | `src/integrations/*` |
| Plattformbetreiber | Kein Dauerzugriff auf Patientendaten; Zugriff nur über zeitlich begrenzte, personengebundene Support-Freigabe der Praxis (Break-Glass, standardmäßig nur lesend), Erteilen/Widerrufen/Betreten und jede Seitenansicht im Audit-Log der Praxis | `src/server/support.ts` |

## Integrität
| Maßnahme | Umsetzung |
|---|---|
| Unveränderbare Doku (§ 630f BGB) | DB-Trigger verbieten UPDATE/DELETE auf Behandlungseinträge, Nachträge, Anamnesen, Einwilligungen, Audit-Log |
| Manipulationsnachweis | SHA-256-Hash-Kette je Patient (extern signieren: geplant) |
| GoBD | Ausgestellte Rechnungen unveränderbar, Korrektur nur per Storno; lückenlose Nummernkreise |
| Protokollierung | Audit-Log für Lesen/Schreiben von Akten, Fotos, Exporten, Logins, Einstellungen |

## Verfügbarkeit und Belastbarkeit
| Maßnahme | Umsetzung |
|---|---|
| Backup | täglich, verschlüsselt, 14 Tage lokal + Kopie an zweitem Standort, dort höchstens 30 Tage (einzurichten) |
| Wiederherstellung | Quartalsweiser Restore-Test (`docs/BETRIEB.md`) |
| Monitoring | Healthcheck `/api/health`, Docker-Restart-Policy |

## Organisatorisch
- Der Betreiber ist Einzelunternehmer; administrative Zugriffe auf Server und Plattform erfolgen nur durch ihn; Support-Freigaben können nur Plattform-Admin-Konten mit aktiver 2FA erhalten. Werden künftig Mitarbeitende oder Dienstleister eingesetzt, werden sie vorher auf Vertraulichkeit und § 203 StGB verpflichtet.
<!-- TODO (Betreiber): Maßnahmen für eigene Arbeitsgeräte (Bildschirmsperre, Geräteverschlüsselung) ergänzen, sobald bestätigt. -->
- Datenpannen: Meldung an die betroffene Praxis unverzüglich, spätestens binnen 24 h (AVV § 8 Abs. 3)
- Prüfung der Plattform-Admin-Zugänge und Support-Freigaben halbjährlich
