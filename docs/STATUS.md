# Stand & Übergabe (07.11.2026, nachts)

## Was läuft (getestet)
- **88 automatische Tests grün**, darunter echte Datenbanktests für Mandantentrennung (RLS), unveränderbare Doku, GoBD-Rechnungsschutz, Audit-Log-Trennung und Excel-Import.
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
4. **Runde 3** (Webhooks, KI-Route, Kalender, Import, Buchung) → siehe `docs/reviews/code/round3-*`

## Was du morgen tun musst
1. **GitHub-Repo verbinden.** Ich konnte keins anlegen; das blockiert die Sitzung. Bitte ein **leeres privates Repo** anlegen (z. B. `podo-crm`) und in der Sitzung freigeben. Dann pushe ich alles (5 Commits) und öffne einen Pull Request.
2. **Server-Zugang** (Anbieter, IP, SSH-Zugang oder Coolify/Portainer), dazu eine **Domain**. Danach Installation nach `docs/BETRIEB.md`.
3. **Fachlich prüfen**: Fotopflichten (`src/lib/rules/brace.ts`) gegen die aktuelle Leistungsbeschreibung § 125, USt-Einstufung deiner Leistungen mit der Steuerberatung, Ausfallhonorar-Text.
4. **Für echte Schnittstellen**: lexoffice-API-Key, SumUp-Zugang + Reader-ID, Doctolib-Partneranfrage, Google-Business-API-Antrag, SMS-Anbieter, WhatsApp-BSP, EU-KI-Anbieter mit AVV.

## Offen / nächste Schritte
- PDF-Rechnungen (aktuell Druck über den Browser), Rechnungsversand per E-Mail
- SumUp-Terminalzahlung direkt aus der Rechnung starten (Adapter ist fertig, UI-Knopf fehlt)
- GKV-Abrechnung über ein Abrechnungszentrum (Phase 2), Verordnungs-OCR
- Erinnerungen automatisch versenden (Cron-Job), Rückhol-Kampagnen
- Dienstplan/Urlaub, Hygiene-Modul (Sterilisator-Chargen freigeben), Material/Bestellungen
- KI-Telefonagent anbinden (Platzhalter steht), Kundenportal
- 3D-Fuß, native iOS-Hülle bauen (Konfiguration liegt bei, braucht Mac + Apple-Developer-Konto)
- Pentest vor dem ersten fremden Mandanten

## Lokal ausprobieren
Siehe README. Demo-Login: `demo@podocrm.local` / `demo-passwort-123`.
