# Review: x-ai/grok-4.7

## 1) Fehler und veraltete Angaben

- **Art. 9 DSGVO ist die falsche Norm fürs Hosting.** Art. 9 regelt die Zulässigkeit besonderer Kategorien, nicht den Standort. Maßgeblich sind Art. 28, 32, 44 ff. DSGVO und **§ 203 Abs. 4 StGB** (Podologen: § 203 Abs. 1 Nr. 1, staatlich geregelter Heilberuf). „Server in DE“ heilt Meta, Google, OpenAI oder Vercel nicht.
- **GebüH/BEB ist fachlich falsch.** GebüH = Heilpraktiker, BEB = Zahntechnik. PKV/Beihilfe: Behandlungsvertrag, eigene Privatpreisliste, Pflichtangaben der jeweiligen Beihilfeverordnung. Kein Gebührenverzeichnis „einbauen“.
- **USt zu grob.** § 4 Nr. 14 UStG hängt am therapeutischen Zweck der konkreten Behandlung, nicht am Kürzel. Dieselbe Leistung kann bei DFS steuerfrei und kosmetisch 19 % sein. **§ 19 UStG (Kleinunternehmer, Schwellen seit 2025)** fehlt. Bei steuerpflichtigen Umsätzen gelten § 14 UStG-Pflichtfelder; eine Quittung ersetzt die Rechnung nicht.
- **TSE-Auslagerung ist ein Fehlschluss.** § 146a AO / KassenSichV trifft das System, das Barumsätze aufzeichnet. SumUp-Terminal oder lexoffice-Belegbild ist keine eigene Bar-/Mischkasse. Ein führendes System braucht TSE, Tagesabschluss, lückenlosen Nummernkreis und die Kassenmeldung (seit 2025). CRM-Nummernkreis *und* lexoffice als führend verletzt GoBD.
- **Fristen vermischt.** § 630f Abs. 3 BGB: 10 Jahre ab *Behandlungsabschluss*. § 147 AO: Bücher 10 Jahre, Buchungsbelege seit BEG IV (1.1.2025) 8 Jahre. Löschen nach 8 Jahren wäre rechtswidrig. § 199 Abs. 2 BGB (30 Jahre absolut) spricht gegen automatische Löschung.
- **Gutschein:** § 195 BGB ist Verjährung, keine automatische Gültigkeit. Einzweck/Mehrzweck (§ 3 Abs. 13–15 UStG) nicht in einer Regel vermischen. Onlineverkauf: § 312j BGB, Widerruf §§ 312g, 355 BGB.
- **DSFA** nicht „automatisch wegen KI“, sondern Art. 35 / DSK-Liste (Gesundheitsdaten: voraussichtlich ja). Art. 50 AI Act (seit 2.8.2026) genügt nicht: **§ 201 StGB** bei Aufzeichnung, TDDDG.
- Foto-Pflicht erst nach aktueller Leistungsbeschreibung § 125 SGB V hart schalten. Fehlendes Foto darf den Abschluss nicht blockieren. Podologie: typisch **§ 36 IfSG** und LandeshygieneVO, nicht pauschal § 23/KRINKO. `<input capture>` landet auf iOS oft in der Kamerarolle. Doctolib-Mail-Parsing kann AGB-widrig sein. Klarnamen echter Patienten gehören nicht ins Konzept. „eVerordnung 2027“ ist kein Planungsfakt.

## 2) Fehlende Anforderungen

Einwilligungen versioniert (Behandlung, Foto, WhatsApp, Marketing, KI, Aufzeichnung). **Terminerinnerung ≠ Werbung (§ 7 UWG).** Lösch-/Sperrkonzept trotz Aufbewahrung. GoBD-Verfahrensdokumentation, Kassenbuch, Kleinunternehmer-Schalter. Betreuer/Sorgerecht mit Nachweis. Sterilgut-Stammsatz (Zyklus, Freigabe) *vor* dem Scan. Fristen und Positionsnummern versioniert, nicht hart codiert. Art. 15 und Exit-Export. Art.-33-Prozess. Gutschein-Widerruf. Self-hosted Routing statt Google-Adressen. Steuerberater-Rolle ohne DATEV/CSV ist leer. GKV nur nach Scope-Gate: Verordnung, Zuzahlung § 61 SGB V, Frequenz, ICD-10, km.

## 3) Architektur- und Sicherheitsrisiken

6–8 Wochen für diesen P1 sind unrealistisch. iOS-PWA: Storage-Eviction, kein verlässliches Offline für Befundfotos, WebAuthn im Standalone-Modus fragil. RLS schützt nicht vor Superuser, Backups, Sentry, Coolify, Actions-Logs. Eine Hash-Kette beweist nichts gegen den Admin; § 630f braucht Append-only plus Nachtrag, nicht Kryptografie-Theater. Phase 0 „Echtdaten importieren“ widerspricht „dev = Testdaten“. Super-Admin ohne Break-Glass verletzt § 203. WhatsApp Cloud API offenbart Inhalte gegenüber Meta. Sprache nur self-hosted bzw. mit AVV, nie OpenRouter/OpenAI. iCal mit Patientennamen ist ein Leak. KI in die Akte: Halluzination und Rubber-Stamp. Bild-/Befund-KI erst nach schriftlicher MDR-Qualifikation (MDCG 2019-11).

## 4) Wettbewerb

Sekundärpreise (Pabau-Blog) und behauptete Schwächen tragen die Positionierung nicht. Es fehlen die realen Bindungen: **DMRZ**, Portale von **opta data, AZH, Noventi**, neben Doctolib **samedi** und **jameda**, **RED medical** (Cloud/TI), kosmetisch **Fresha/Phorest**. pododesk hängt am Ruck-Sortiment und an Schulung; Wechselkosten fehlen. „Niemand hat Finanzplanung“ ist unbelegt und kein Kaufgrund. 59 € gegen tinana 79,90 € vergleicht ein CRM ohne TI/§ 302 mit einem Heilmittel-PVS.

## 5) Priorisierung

Widersprüche: WhatsApp-Erinnerung und Tourenplanung in 4.2 als P1, Module aber P2; alle Adapter „in P1 anlegen“. Finanzplanung, News, KI-Telefon, Kampagnen, Fußgrafik-Tiefe ersetzen Excel nicht. GKV/TI in Phase 4 nur, wenn der GKV-Anteil nahe null ist – sonst bleibt die Praxis bei pododesk/DMRZ plus Excel. P1: Mandant, Rollen, Einwilligung, Akte, Kalender, manuelle Doku mit Foto über getUserMedia, Spangen-Episode mit Ausnahme, Rechnung/Gutschein in *einem* GoBD-System, lexoffice nur als Export, Bar nur in zertifizierter Kasse. KI, WhatsApp, SumUp-Cloud, Planung, Portal: danach. Realistisch mehrere Quartale, nicht 8 Wochen.

## 6) Top-10

1. Rechtsmatrix korrigieren: Art. 9 ≠ Standort; GebüH/BEB streichen; § 19, § 7 UWG, § 146a, § 203, § 201.
2. GKV-Anteil als Go/No-Go vor jeder Schätzung.
3. MVP auf Excel-Ersatz plus rechtssichere Doku kürzen; Timeline ehrlich machen.
4. Ein Aufzeichnungssystem für Bar; TSE nicht über SumUp „dazudenken“.
5. Einwilligung, Sperrung, Aufbewahrung vor jeder Kampagne.
6. Keine Gesundheitsdaten an Meta, Google, Vercel, OpenRouter; STT und Routing selbst betreiben.
7. Doku am Stuhl nativ oder per iPad; PWA nicht als Garantie gegen die Kamerarolle.
8. KI schreibt nie allein in die Akte; MDR-Intended-Purpose vor Feature-Bau.
9. Threat Model: Prod-Zugriff, Logs, iCal-Tokens, Restore-Probe, Art.-33-Runbook; Pentest vor Echtdaten, nicht erst vor SaaS.
10. Wettbewerb um DMRZ, Abrechnungszentren und Wechselkosten ergänzen; Preise nur aus Primärquellen.