# PodoCRM

Praxis- und Kundensystem für Podologie: Kundenakte, Termine, Pflichtdokumentation mit Fotos und Sprachbericht (iPad/iPhone), Rechnungen, Gutscheine, Kommunikation, KI-Assistenz und vorbereitete Schnittstellen (lexoffice, SumUp, Doctolib, Google, WhatsApp, SMS, KI-Telefon). Mandantenfähig, damit es später auch an andere Praxen verkauft werden kann.

> Planung, Wettbewerbsanalyse, rechtliche Vorgaben und Roadmap: [`docs/PLAN.md`](docs/PLAN.md)
> Externe KI-Reviews: [`docs/reviews/`](docs/reviews)

## Was drin ist (Stand Phase 0 + große Teile von Phase 1)

| Bereich | Funktionen |
|---|---|
| **Anmeldung & Rollen** | Registrierung/Einrichtung, Argon2id-Passwörter, Sitzungen mit HttpOnly-Cookie, Kontosperre nach Fehlversuchen, 2FA (TOTP), Rollen: Inhaber:in, Podolog:in, Empfang, Azubi (mit Gegenzeichnung), Steuerberatung |
| **Mandanten** | Jede Praxis ist ein Mandant. Trennung doppelt: im Code **und** per PostgreSQL Row-Level-Security (getestet) |
| **Kundenakte** | Stammdaten wie im Excel, Risiko-Ampel (Diabetes, Blutverdünner, pAVK, Neuropathie, MRSA, Allergien), Status Neu/Aktiv/Überfällig/Inaktiv, Dubletten-Prüfung, Zeitleiste, Einwilligungen (versioniert), Route (nur Adresse an Maps), Auskunft nach Art. 15 als JSON, Druckansicht |
| **Kalender** | Tag/Woche, Feiertage je Bundesland, Serientermine, Dauer aus Leistungen, Doppelbuchungsprüfung, Hausbesuche, Quelle (Telefon/Doctolib/WhatsApp …), Absage/Nicht erschienen |
| **Behandlungsdoku** | Fürs iPad/iPhone: Leistungen antippen, Fußschema mit Punkten, Fotos direkt aus der Kamera (verschlüsselt, nie in der Mediathek), **Sprachbericht → Transkription → KI sortiert in Felder**, Sterilgut-Charge (Barcode-Scan), Nagelspangen-Episoden mit **Pflichtfotos** (vorher/Verschlechterung/Abschluss – sonst Begründung), **unveränderbar** (DB-Trigger + Hash-Kette), Nachträge und Gegenzeichnung |
| **Rechnungen & Kasse** | Rechnung/Quittung/Sammelrechnung/Ausfallhonorar/Storno, lückenlose Nummernkreise, USt-Logik inkl. § 4 Nr. 14 und § 19, Mischzahlung, Gutschein-Einlösung, unveränderbar nach Ausstellung |
| **Gutscheine, Auswertung** | Gutscheine mit Restwert, Umsatz/Behandlungen je Monat, Fixkosten, Break-even |
| **Schnittstellen** | Ports & Adapter mit Testmodus: lexoffice (echt), SumUp (echt), Doctolib (CSV + Mail-Parser), KI/LLM (echt, mit Datenschutz-Sperre), Transkription, WhatsApp, SMS, Google-Bewertungen, KI-Telefon (Platzhalter) |
| **Import** | Excel „Rechnungsmanager V0.9.2“ (Patienten, Leistungen, Gutscheine, Rechnungen, Fixkosten) mit Prüfbericht, Doctolib-CSV |
| **Design** | Flach, frisch, hell, **Hell/Dunkel-Umschalter**, große Touch-Ziele, selbst gehostete Schriften (keine Google-Fonts-Abrufe) |
| **Betrieb** | Docker Compose (Postgres, App, Migration, Caddy/HTTPS, verschlüsselte Backups), Healthcheck, Sicherheits-Header, GitHub-Actions-CI |

## Lokal starten

Voraussetzungen: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env.local   # Werte setzen, APP_ENCRYPTION_KEY: openssl rand -base64 32
```

Datenbank (einmalig): Eigentümer-Rolle für Migrationen, **App-Rolle ohne Superuser** (sonst greift die Row-Level-Security nicht):

```bash
psql -c "create role podo_owner login password 'podo_owner'" -c "create role podo_app login password 'podo_app' nosuperuser nobypassrls" -c "create database podo owner podo_owner"
```

```bash
pnpm db:migrate        # Tabellen, Trigger, RLS
pnpm db:seed           # optional: Demo-Praxis mit erfundenen Daten
pnpm dev
```

Demo-Login: `demo@podocrm.local` / `demo-passwort-123`. Ohne Seed führt `/einrichtung` durch die Anlage der ersten Praxis.

## Tests

```bash
pnpm test                                         # Unit-Tests
TEST_DATABASE_URL=postgres://podo_app:…/podo_test pnpm test   # inkl. RLS-/Unveränderbarkeits-Tests gegen echte DB
pnpm typecheck && pnpm lint
```

## Auf dem eigenen Server

Siehe [`docs/BETRIEB.md`](docs/BETRIEB.md): Docker Compose mit automatischem HTTPS, Backups und Update-Ablauf.

## iPad/iPhone-App

Die Web-App läuft im Safari und kann auf den Home-Bildschirm gelegt werden. Für den Praxisbetrieb empfohlen: die native Hülle (Capacitor), siehe [`docs/IOS-APP.md`](docs/IOS-APP.md).

## Wichtige Hinweise

- **Keine echten Patientendaten** in Repo, Issues, Tests oder an externe KI-Dienste ohne AVV.
- KI-Funktionen sind **Dokumentationshilfe**, keine Diagnose (sonst Medizinprodukt nach MDR). Ergebnisse immer prüfen.
- Rechtliche Vorgaben (Fotopflichten, USt, Aufbewahrung) sind als versionierte Regeln hinterlegt und **vor dem Echtbetrieb fachlich zu prüfen** (`src/lib/rules/`, `docs/PLAN.md` Kap. 3 und 14).
