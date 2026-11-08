# Technische und organisatorische Maßnahmen (Art. 32 DSGVO) – Entwurf

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
| Plattformbetreiber | Kein Dauerzugriff auf Patientendaten (Break-Glass vorgesehen, Phase 3) | Plan 14.4 |

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
| Backup | täglich, verschlüsselt, 14 Tage lokal + Kopie an zweitem Standort (einzurichten) |
| Wiederherstellung | Quartalsweiser Restore-Test (`docs/BETRIEB.md`) |
| Monitoring | Healthcheck `/api/health`, Docker-Restart-Policy |

## Organisatorisch
- Verpflichtung aller Mitarbeitenden auf Vertraulichkeit/Schweigepflicht
- Nur Firmengeräte (MDM), Bildschirmsperre, keine Fotos in privater Mediathek
- Regelmäßige Schulung; Prozess für Datenpannen (Art. 33/34): Meldung binnen 72 h
- Rollen- und Rechteprüfung halbjährlich
