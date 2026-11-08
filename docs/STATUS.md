# Stand & Übergabe (07.11.2026, nachts)

## Was läuft (getestet)
- **95 automatische Tests grün**, darunter echte Datenbanktests für Mandantentrennung (RLS), unveränderbare Doku, GoBD-Rechnungsschutz, Audit-Log-Trennung und Excel-Import.
- **Browser-Durchlauf (Playwright)**: Login → Heute → Kunden → Akte (hell/dunkel) → Doku auf iPhone-Größe → Sprachbericht (Testmodus) → Spange setzen ohne Foto (wird blockiert) → mit Foto (gespeichert, unveränderbar) → Rechnungen/Gutscheine/Auswertung → Posteingang/Bewertungen/News → Schnittstellen → Import.
- **Produktions-Build** (`pnpm build`) läuft durch.
- **Deine Excel-Vorlage V0.9.2** wird gelesen: 5 Kunden, 18 Leistungen, 1 Gutschein, 8 Rechnungen, 15 Fixkosten, 49 sinnvolle Hinweise (z. B. fehlende Dauer bei Leistungen). Gelesen wurde nur lokal; es ging nichts nach außen.

## Entscheidungen, die ich allein getroffen habe (bitte prüfen)
| Thema | Entscheidung | Warum |
|---|---|---|
| Technik | Next.js 16 + PostgreSQL 16 + Drizzle, eigene Anmeldung (Argon2id, 2FA) | volle Kontrolle, läuft auf deinem Server, keine US-Cloud nötig |
| Hosting | Docker Compose mit Caddy (HTTPS automatisch), verschlüsselte Backups | einfach auf jedem DE-Server |
| Mandanten | ab Tag 1 mehrere Praxen, doppelte Trennung (Code + Datenbank) | Verkauf an andere Podologen |
| Rechnungen | **CRM vergibt die Nummern** (R2026-0001, Q…, SR…, GS…), lexoffice bekommt nur Belege | GoBD, Mischzahlungen, Gutscheine |
| USt | 0 % nur mit Bestätigung „Heilbehandlung mit therapeutischem Ziel“, sonst 19 % | § 4 Nr. 14 UStG (Review-Ergebnis) |
| Pflichtfotos Spange | fehlendes Foto blockiert, außer mit schriftlicher Begründung | Rechtssicherheit ohne Praxisstillstand |
| KI | alle KI-Funktionen im **Testmodus**; echte Anbieter erst nach Haken „EU + AVV + Zero Data Retention“ | Gesundheitsdaten |
| WhatsApp | nur Organisatorisches, nur mit Einwilligung | Meta = Drittland |
| Online-Buchung | eigene Seite `/buchen/<praxis>` für Selbstzahler, zusätzlich zu Doctolib | Doctolib-API nur für Partner |
| Design | Mint/Petrol + Koralle, Inter/Space Grotesk lokal eingebunden (keine Google-Fonts-Abrufe) | DSGVO, Wunsch „frisch, hell, flat, Umschalter“ |

## Externe Reviews (alle in `docs/reviews/`)
1. **Plan-Review** (GPT, Gemini, Mistral, Grok) → Plan v0.2, Korrekturen in Kap. 14/15
2. **Code-Review Sicherheit, Runde 1** (GPT, Gemini, Grok) → behoben: 2FA-Bruteforce/Replay, Rechnung zurück auf Entwurf, Azubi-Selbstgegenzeichnung, Audit-Log-Trennung, Upload-Typprüfung, verwaiste Dateien, Gutschein-Wildcard, IP-Spoofing, Registrierungs-Race
3. **Runde 2 (Grok)** → behoben: TRUNCATE-Schutz, Positions-Trigger „fail closed“, Hash-Kette ohne Verzweigung, kurze 2FA-Sitzungen + neues Token, Einmal-Code für Ersteinrichtung, eigener Foto-Schlüssel je Praxis, Login ohne Konto-Hinweis
4. **Runde 3** (GPT, Gemini, Grok: Webhooks, KI-Route, Kalender, Import, Buchung) → behoben: Webhooks nur mit Signatur/Token (fail closed), Wiederholung fehlgeschlagener Webhooks, Online-Buchung hängt sich nie an bestehende Akten (Praxis ordnet zu), Doppelbuchungssperre, Schutz gegen Anfragen ins interne Netz (SSRF), Namen werden vor KI-Versand serverseitig entfernt, Testmodus-Texte klar markiert und nicht übernommen, Antworten nicht doppelt versendbar, WhatsApp nur mit Einwilligung, serverseitig signierter Import-Vorschau-Token, Kalender-Feed ohne Praxisname/Hausbesuch

## Was du morgen tun musst
1. **GitHub-Repo verbinden.** Ich konnte keins anlegen; das blockiert die Sitzung. Bitte ein **leeres privates Repo** anlegen (z. B. `podo-crm`) und in der Sitzung freigeben. Dann pushe ich alles (alle Commits) und öffne einen Pull Request.
2. **Server-Zugang** (Anbieter, IP, SSH-Zugang oder Coolify/Portainer), dazu eine **Domain**. Danach Installation nach `docs/BETRIEB.md`.
3. **Fachlich prüfen**: Fotopflichten (`src/lib/rules/brace.ts`) gegen die aktuelle Leistungsbeschreibung § 125, USt-Einstufung deiner Leistungen mit der Steuerberatung, Ausfallhonorar-Text.
4. **Für echte Schnittstellen**: lexoffice-API-Key, SumUp-Zugang + Reader-ID, Doctolib-Partneranfrage, Google-Business-API-Antrag, SMS-Anbieter, WhatsApp-BSP, EU-KI-Anbieter mit AVV.


## Phase 2 (Stand 08.11.2026)
| Bereich | Umgesetzt |
|---|---|
| **Verordnungen (GKV)** | Erfassung inkl. Positionen, Foto der Papierverordnung, Ampeln für Behandlungsbeginn/Frist, Frequenz und verbrauchte Einheiten, Zuzahlung, Statusfluss bis „abrechnungsreif“, Verknüpfung mit der Behandlungsdoku, **Abrechnungslauf mit CSV-Export für ein Abrechnungszentrum** (die § 302-Übermittlung selbst macht der Partner). Regeln versioniert in `src/lib/rules/prescription.ts` – **vor Echtbetrieb fachlich prüfen** |
| **Anamnese** | Strukturierter Bogen (indikationsabhängig), IWGDF-Risikoklasse, Versionen (unveränderbar), **Online-Anamnese per Einmal-Link** (7 Tage, nur Vorname sichtbar, Einwilligungen werden mit erfasst) |
| **Pflegeheime** | Heime verwalten, Bewohner zuordnen, Besuchstag mit Schnell-Doku, Sammelrechnung je Monat |
| **Erinnerungen** | Automatisch 24 h vorher, Rückholung bei Überfälligkeit, Spangen-Kontrolle – nur mit Einwilligung, ohne medizinische Inhalte, ohne Doppelversand; Cron-Container im Docker-Setup |
| **Rechnungen** | PDF-Erzeugung, Versand per E-Mail, SumUp-Terminal und Zahlungslink direkt aus der Rechnung (Webhook bucht automatisch), TSE-Schnittstelle vorbereitet (fiskaly) |
| **Kundenportal** | Link für Patient:innen: kommende Termine, offene Rechnungen als PDF, Gutscheine, Absage bis 24 h vorher |
| **Hygiene & Geräte** | Sterilgut-Chargen (Freigabe endgültig), QR-Etiketten, **Rückverfolgung „wer wurde mit Charge X behandelt“**, Gerätebuch (unveränderbar) mit Wartungs-/Validierungs-/Prüffristen, Tages-Checkliste, Material mit Bestellliste |
| **Team** | Arbeitszeiten, Urlaub/Krankheit/Fortbildung, Warnung bei Terminen in Abwesenheiten |

Noch offen nach Phase 2: echter SMTP-Versand, fiskaly-Vertrag und DSFinV-K-Export, Vertrag mit einem Abrechnungszentrum, Verordnungs-OCR, Kundenportal-Buchung, Sterilgut-Prüfung direkt im Doku-Formular.

## Phase 3 (Stand 08.11.2026) – verkaufsfähig als SaaS
| Bereich | Umgesetzt |
|---|---|
| **Tarife & Abo** | Testphase 30 Tage, Starter/Praxis/Plus (Preise vorläufig in `src/lib/plans.ts`), Plätze je Behandler:in, Stripe-Checkout + Kundenportal + signierte Webhooks (idempotent, Reihenfolge geprüft, datensparsam gespeichert). Abo abgelaufen → **Nur-Lesen-Modus**: Lesen und Export bleiben immer möglich |
| **Onboarding** | Assistent `/willkommen` (Praxisdaten, Leistungsvorlage, Team, Import, Schnittstellen), Checkliste auf „Heute“; Registrierung nur mit AGB+AVV-Zustimmung (versioniert), Rate-Limit |
| **Plattform-Konsole** | `/plattform` nur für Betreiber mit 2FA: Praxen, Tarife, Testphase verlängern – **ohne Patientendaten** |
| **Support-Zugriff (Break-Glass)** | Praxis gibt Zugriff zeitlich begrenzt frei (1–72 h, standardmäßig nur lesen), jeder Seitenaufruf im Zugriffsprotokoll der Praxis, roter Hinweisbalken, Widerruf jederzeit. Kein Export, keine Kündigung, kein Import im Support-Modus |
| **Öffentliche Website** | Startseite, Funktionen, Preise, Sicherheit, Impressum, Datenschutz, AGB, AVV, Unterauftragnehmer (Texte als **Entwürfe** in `docs/legal/`) |
| **Daten & Kündigung** | Vollexport der Praxis als ZIP (alle Tabellen + entschlüsselte Fotos), Kündigung mit 30 Tagen Karenz, Lösch-Skript für den Betreiber (`scripts/purge-organizations.ts`, Probelauf als Standard) |
| **KI-Telefonagent (Pilot)** | Anbindung an Vapi: freie Termine nennen, Terminwunsch anlegen (immer zur Bestätigung im Posteingang, nie an eine bestehende Akte gehängt), Absage-/Rückrufwunsch, Praxisinfos. KI-Hinweis (AI Act) am Gesprächsbeginn, keine medizinische Beratung, Notfall → Arzt/112. Vorlage `src/integrations/voice/vapi-assistant.json`, Simulation unter `/telefon` |
| **Sicherheit** | Automatische Tests: jede Route/API/Server-Action ist geschützt oder ausdrücklich öffentlich, Sicherheits-Header; Pentest-Checkliste `docs/compliance/PENTEST-CHECKLISTE.md`; externe Reviews (4 Modelle) – alle kritischen/hohen Befunde behoben (`docs/reviews/code/phase3-*`) |

### Was du vor dem Verkauf tun musst
- Rechtstexte (`docs/legal/*`) und Platzhalter wie [FIRMENNAME] **anwaltlich prüfen lassen** und ausfüllen.
- Stripe-Konto anlegen, Produkte/Preise anlegen, `STRIPE_*`-Variablen setzen (siehe `.env.example`), Webhook auf `/api/billing/webhook`.
- Preise final festlegen (aktuell vorläufig).
- Für den Telefonagenten: Vapi-Konto + AVV mit Vapi, Telefonnummer, Vorlage einfügen.
- Externer Pentest vor dem ersten fremden Mandanten.

## Phase 4 (Stand 08.11.2026)
| Bereich | Umgesetzt |
|---|---|
| **TI / KIM** | KIM-Anbindung über das KIM-Clientmodul (POP3/SMTP mit TLS), Abruf in den Posteingang (manuell + Cron), Antwort per KIM, Zuordnung zu Kund:innen nur als Vorschlag. Einstellungsseite „TI & KIM“ mit Checkliste (SMC-B, eHBA, Konnektor/TI-Gateway, KIM-Anbieter). Echter Betrieb braucht diese Komponenten – siehe `docs/TI.md` |
| **eVerordnung** | Import eines FHIR-Bundles (Heilmittel) mit Vorschau → Verordnungsentwurf; doppelte Importe werden abgewiesen. Die Heilmittel-eVerordnung ist laut gematik geplant – Stand vor Echtbetrieb prüfen |
| **3D-Fuß** | Interaktives 3D-Fußmodell (iPad-tauglich) für Befundmarkierungen, umschaltbar 2D/3D, lädt nur bei Bedarf |
| **Verordnung per Foto** | KI liest das Muster-13-Foto aus, jedes Feld wird angezeigt und bestätigt, nichts wird ohne „Übernehmen“ gespeichert. Standardmäßig aus; echter Anbieter nur mit AVV-Bestätigung |
| **KI-Telefon für alle** | Zweiter Anbieter (Retell), Einrichtungs-Assistent, Minutenkontingent je Tarif bzw. Zusatzpaket, Monatsbericht; über dem Kontingent → Rückrufwunsch statt Buchung |
| **E-Mail** | Echter SMTP-Versand (Praxis-SMTP oder Plattform-Server), nur mit TLS, Testmail-Knopf, Ratenbegrenzung |
| **Sicherheit** | Support-Freigabe personengebunden, neue Sitzung bei Praxiswechsel, Sperren beenden Sitzungen, Export streamend, `__Host-`-Cookie, externe Reviews mit allen Befunden behoben (`docs/reviews/code/phase4-umsetzung.md`) |

**Online-Test:** `deploy/install-subdomain.sh` installiert PodoCRM neben einem vorhandenen Caddy (z. B. `podo.algoverdict.com`).

## Phase 5 (Stand 08.11.2026)
| Bereich | Umgesetzt |
|---|---|
| **Kasse / DSFinV-K** | Kassenbuch (Einlagen/Entnahmen, Gegenbuchung statt Änderung), Zählprotokoll, Tagesabschluss (Z-Bon) lückenlos nummeriert, append-only, Hash-Kette inkl. unveränderlichem Bon-Snapshot; Sperre abgeschlossener Zeiträume per DB-Trigger. **TSE-Signatur für jeden Kassenvorgang** (Bar, Karte, Gutschein; vollständig in `fiscal_transactions`), Meldung an fiskaly nach dem Commit mit „Meldung wiederholen“. DSFinV-K-Export (ZIP) mit Kettenprüfung; eigene Rechte `cash.read/write/export` (Export nur Inhaber:in/Steuerberatung). Details/offene Punkte: `docs/KASSE.md` |
| **Portal-Buchung** | `/portal/buchen`: online buchbare Leistungen, freie Zeiten (6 Wochen, Arbeits-/Öffnungszeiten, Abwesenheiten, Feiertage), Vorlaufzeit, Tageslimit, höchstens 3 offene Buchungen je Person, Verschieben bis 24 h vorher. Termin direkt an der Akte, Quelle **„Kundenportal“** (`portal`) |
| **Warteliste** | Wünsche als eigene Spalten (Leistung, Wochentage, Tageszeit, Notiz). Bei Absage Einmal-Link an bis zu 5 passende Personen (nur mit Einwilligung, nur über HTTPS-Links, Link direkt mit dem freien Termin verknüpft); wer zuerst annimmt, bekommt den Termin – unter Sperre erneut geprüft, auch wenn die Praxis den Termin inzwischen reaktiviert. Ohne Einwilligung: Anruf-Vorschlag an der Akte |
| **E2E** | Playwright (`e2e/`, `pnpm e2e`): Login, Kunde, Doku mit Fußpunkt, Rechnung, öffentliche Buchung, Portal (buchen/verschieben), Posteingang, Kasse (Kassenbuch, Formel-Schutz, Export-Seite), Abmelden, Routen-Schutz, keine Konsolenfehler; CI-Job `e2e` |
| **Betrieb** | `deploy/update.sh` mit Sicherung, Rollback und Sperre im Installationsverzeichnis; `deploy/restore.sh` (DB über Hilfsdatenbank, Dateien in leeres Verzeichnis + Quarantäne des Altbestands); `deploy/restore-test.sh` + `scripts/verify-hash-chains.ts` prüfen Behandlungsdoku **und Kassenabschlüsse** (lückenlose Z-Nummern, Kette, Inhalt); `/api/health/deep` nur mit eigenem `HEALTH_TOKEN`; Fehlerberichte an Sentry/Webhook ohne Fehlermeldungstexte (nur SQLSTATE) und ohne echte Pfade |
| **Sicherheit** | Externe Reviews (4 Modelle) geprüft, alle kritischen/hohen/mittleren Befunde behoben oder begründet offen: `docs/reviews/code/phase5-umsetzung.md` |

Schema-Wünsche Phase 5 erledigt (Migrationen 0016/0017): `docs/SCHEMA_REQUESTS.md`.

## Offen / nächste Schritte
- **fiskaly-Vertrag** und Abgleich mit der fiskaly-Doku: Kassenabschluss mit Einzeltransaktionen, `tse.csv` (Public Key,
  Zertifikate, Algorithmus), Prozessdaten; TSE-Pflichtangaben/QR-Code auf dem Beleg (`docs/KASSE.md`, Abschnitt 3)
- **Steuerberatung**: USt-Schlüssel (Kleinunternehmer), Gutschein-Geschäftsvorfälle, Soll-/Ist-Versteuerung, Meldung über ELSTER
- Vertrag mit Abrechnungszentrum; KIM/TI-Komponenten für den Echtbetrieb (`docs/TI.md`)
- Native iOS-Hülle (braucht Mac + Apple-Developer-Konto)
- Externer Pentest vor dem ersten fremden Mandanten

## Lokal ausprobieren
Siehe README. Demo-Login: `demo@podocrm.local` / `demo-passwort-123`.
