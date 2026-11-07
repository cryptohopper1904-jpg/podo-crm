# PodoCRM – Masterplan (v0.1, Entwurf)

> Arbeitstitel „PodoCRM“ (Name noch offen). Ziel: Ein Praxis- und Kundensystem nur für Podologie-Praxen, erst für die eigene Praxis, danach als SaaS-Produkt für andere Podologien (mehrere Mandanten).
> Stand: 07.11.2026 · Status: **Entwurf v0.2, nach dem Review durch externe KIs (Kap. 14). Offene Fragen in Kap. 13 („Grill-Liste“).**

---

## 0. Kurzfassung

| | |
|---|---|
| **Problem** | Podologie-Praxen arbeiten mit Excel (siehe *Rechnungsmanager V0.9.2*), Papierakten, Doctolib, WhatsApp und lexoffice parallel. Daten werden doppelt gepflegt, die Fotos für die Pflichtdoku liegen auf dem privaten Handy, Abrechnung und Doku sind getrennt. |
| **Lösung** | Ein System für alles: Kundenakte, Termine (inkl. Doctolib-Sync), Pflichtdoku mit Fotos und Sprachbericht vom iPhone, Rechnungen/Kasse (lexoffice, SumUp), Kommunikation (E-Mail, WhatsApp, SMS, KI-Antworten, KI-Telefon), Bewertungen, Auswertungen. |
| **Abgrenzung** | pododesk und tinana sind stark bei **GKV-Abrechnung und TI**. Unsere Stärke soll **CRM, Kommunikation, KI, mobile Doku und Selbstzahler-Umsatz** sein. GKV/TI kommt in einer späteren Phase über Partner (siehe Kap. 6.4). |
| **Plattform** | Web-App (PWA, auf dem iPhone installierbar) mit nativer Kamera- und Mikrofon-Nutzung. Später optional eine native iOS-Hülle (Capacitor). |
| **Hosting** | Server in Deutschland (rechtlich reicht EU/EWR, DE senkt aber das Risiko und hilft beim Verkauf). Code auf GitHub. Details in Kap. 9. |

---

## 1. Ausgangslage: der Excel-Rechnungsmanager V0.9.2

Die Excel-Datei ist die beste Anforderungsquelle, weil sie zeigt, was heute wirklich genutzt wird. **Alles daraus wird in Phase 1 übernommen, und es gibt einen Import.**

| Tabellenblatt | Inhalt | Wird im CRM zu |
|---|---|---|
| Patienten | ID, Anrede, Titel, Name, Adresse, **Route (Google-Maps-Link)**, Geburtsdatum, Mobil, Festnetz, E-Mail, **bevorzugter Kanal (z. B. WhatsApp)**, Hinweis, offener Betrag, Umsatz, Anzahl Behandlungen, letzte Behandlung, **Status (Neu/Aktiv/Inaktiv…)** | Kundenakte und CRM-Kennzahlen, automatischer Status, Rückholaktionen |
| Rechnungen | Nummernkreis, Typ **R/Q/SR** (Rechnung/Quittung/Sammelrechnung), Zahlart (Bar, EC, Überweisung, Gutschein, **gemischt**), bis zu 10 Positionen (Leistung · Anzahl · Faktor), Status Quittung/SR | Rechnungsmodul, Kasse, lexoffice-Sync, SumUp |
| Rechnungsvorlage | Druckvorlage | PDF-Vorlagen pro Praxis (Logo, Farben) |
| Gutscheine | Nummer `G{Jahr}-…`, gültig bis 31.12. des 3. Folgejahres (§ 195 BGB), Restbetrag | Gutscheinverwaltung mit QR-Code, Teileinlösung, Online-Verkauf |
| Leistungen | Code (PK, OT, ON, TB, TU, AN …), Bezeichnung, Preis, Steuer (0 % = § 4 Nr. 14 UStG), Dauer | Leistungskatalog: Dauer bestimmt die Terminlänge, USt-Logik je Leistung (Heilbehandlung 0 % / kosmetisch 19 %) |
| Auswertung | Umsatz und Behandlungen pro Monat, Vorjahresvergleich | Dashboard |
| Kalkulation | Fixkosten mit Intervall und Fälligkeit, Arbeitstage, Urlaub, Umsatzplanung, Materialkosten pro Patient | Modul „Praxis-Finanzen und Planung“ (**kein Mitbewerber hat das, das ist ein Alleinstellungsmerkmal**) |
| System | Feiertage (Brandenburg), PLZ→Ort, Stammlisten | Stammdaten und Feiertags-API |
| DoctoLibExport | Patientenexport im Doctolib-Importformat (22 Felder) | Doctolib-Adapter (Kap. 6.2) |

**Erkenntnis:** Viele Kunden sind Selbstzahler (Privatleistungen, Gutscheine, Barzahlung). Es gibt Hausbesuche/Routen, und WhatsApp ist ein wichtiger Kanal. Das CRM muss also zuerst **Selbstzahler und Kommunikation** gut abdecken.

---

## 2. Wettbewerbsanalyse

### 2.1 pododesk (HELLMUT RUCK GmbH)
Quelle: pododesk.de/funktionen. Preise laut Drittquelle (Pabau-Blog): Kassenpraxis ab ca. 49,90 €/Monat, GKV-Abrechnung ab 0,95 % bis 1,75 % bei schneller Auszahlung. Testversion kostenlos bis 20 Patienten.

- **Kalender:** Tagesansicht, Ansicht pro Therapeut, „Termin finden“, Intervalltermine, Drag-and-Drop, Terminzettel, Kalender-URL (iCal) pro Mitarbeiter, externe Kalender importieren
- **Akte:** Stammdaten mit Foto, Dokumente, **Anamnese und Befund in 9 Schritten** (Diabetes, Durchblutung, Allergien, Medikation, Neurologie, Haut- und Nagelbefund), Verlauf
- **HVO:** **Verordnung per Foto scannen (OCR)** mit Plausibilitätsprüfung, Frequenz- und Mengenkontrolle, Fristen für den Behandlungsbeginn, Hausbesuch-km, Therapieberichte
- **GKV-Abrechnung:** digital, über 1.000 Vergütungsdatensätze, kassenspezifische Positionsnummern, DFS-Unterstützung
- **Privat:** Leistungskatalog, Rechnungen über **sevdesk**, Kassenbuch mit Zählprotokoll, Einlagen und Entnahmen
- **Doku:** **unveränderbare Einträge** (nur Nachträge), **Sterilgut-Chargennummer**, Fotos vom Handy mit Zuschneiden/Drehen, **3D-Fußmodell mit 98 Punkten** und Kürzelsystem aus der Ausbildung
- **Auto-ToDos:** fehlende Daten, fehlende Termine, fällige Therapieberichte
- **Mehrere Praxen** und Mitarbeiterprofile, **Online-Buchung nur für Privattermine**
- **TI/KIM:** KIM-Postfach, eArztbrief, TI-Vertrag
- **Schwächen:** kaum CRM oder Marketing, keine KI, keine Telefonie, keine WhatsApp-Anbindung, keine Bewertungen, keine Finanzplanung, Buchhaltung nur über sevdesk (kein lexoffice), kein SumUp

### 2.2 tinana
Quelle: tinana.de, /preise. **79,90 €/Monat brutto** (1 Mitarbeiter, 1 Standort), **+9,90 € je weiterem Mitarbeiter, +59,90 € je weiterem Standort**, 14 Tage Test, monatlich kündbar, keine Einrichtungsgebühr.

- Für alle Heilmittel-Bereiche (Physio, Ergo, Logo, Podo), also **nicht auf Podologie spezialisiert**
- Kalender mit automatischer Terminsuche (2 Vorschläge), Online-Buchung, mehrere Standorte
- **Verordnung per Smartphone scannen**, Prüfung der Verordnung
- **GKV-Abrechnung selbst nach § 302**, ohne Abrechnungszentrum, die Praxis behält 100 %
- **KI-Therapieberichte**
- KIM und Verzeichnisdienst inklusive, TI über die TI-Pauschale refinanziert, **Doctolib Professional Partner**
- „Made & hosted in Germany“
- **Schwächen:** allgemein für alle Heilmittel, wenig Podologie-Tiefe (keine Fußgrafik, keine Spangen-Doku erkennbar), kein CRM oder Marketing, keine Telefonie

### 2.3 Weitere Anbieter (noch genauer zu prüfen)
| Anbieter | Profil | Bewertung |
|---|---|---|
| **THEORG** (SOVDWAER) | Klassiker für Heilmittel, Windows/Server, sehr umfangreich | Marktführer bei Physio, wirkt alt, teuer, ist für Podologie viel zu groß |
| **STARKE / buchnerFLOW** | Heilmittel-Software mit Abrechnung und TI | Preise nur auf Anfrage |
| **Doctolib Praxissoftware** | Doctolib bietet inzwischen eine eigene Praxissoftware an | Wettbewerber *und* Kanal, deshalb beobachten |
| **Pabau** | Internationales Kliniksystem (Ästhetik, Podiatry), stark im Marketing | Zeigt, wie CRM und Marketing aussehen können. Keine GKV, keine deutsche Tiefe |
| Branchen-CRMs (Salonized, Shore, Treatwell) | Kosmetik und Fußpflege | Sehr gute Buchung und Marketing, aber keine medizinische Doku |

> **Positionierung:** „Das moderne Podologie-System mit CRM und KI: Pflichtdoku in 60 Sekunden am iPhone, nie wieder Doppelpflege, mehr Selbstzahler-Umsatz.“ GKV-Abrechnung gibt es später als Zusatzmodul.

---

## 3. Rechtliche und fachliche Vorgaben (Dokumentation und Fotos)

> ⚠️ Die Verträge haben sich 2025 geändert. Vor dem Bauen muss jeder Punkt gegen die **aktuelle Lesefassung** des Vertrags nach § 125 Abs. 1 SGB V Podologie (GKV-Spitzenverband) und gegen die Heilmittel-Richtlinie geprüft werden. Fachliche Freigabe durch dich oder den Verband (VDP, ZFD).

### 3.1 Rechtsgrundlagen
- **§ 630f BGB** (Patientenrechtegesetz): Dokumentation in zeitlichem Zusammenhang mit der Behandlung. **Änderungen nur so, dass der ursprüngliche Inhalt erkennbar bleibt und der Zeitpunkt der Änderung sichtbar ist.** Daraus folgt technisch: nur Einträge anhängen, Versionierung, Audit-Log.
- **§ 630f Abs. 3 BGB:** Aufbewahrung **10 Jahre** nach Abschluss der Behandlung. Dazu kommen steuerliche Fristen (Rechnungen 8 Jahre seit BEG IV, Bücher 10 Jahre, § 147 AO).
- **§ 630g BGB:** Recht des Patienten auf Einsicht und Kopie. Daraus folgt: Export der Patientenakte als PDF.
- **Vertrag nach § 125 SGB V Podologie** (inkl. Leistungsbeschreibung): Verlaufsdokumentation je Behandlungseinheit, Befund, erbrachte Leistungen, Reaktion des Patienten, Material.
- **Heilmittel-Richtlinie (G-BA):** Indikationen für **DFS** (diabetisches Fußsyndrom), **Querschnittslähmung, Neuropathien** ohne Diabetes, **Nagelspangen UI1/UI2**. Verordnungsfristen und Frequenzen.
- **DSGVO Art. 9 + § 22 BDSG:** Gesundheitsdaten. Pflicht sind Auftragsverarbeitungsverträge, TOMs, ein Verzeichnis der Verarbeitungstätigkeiten und eine **DSFA** (Datenschutz-Folgenabschätzung, Pflicht bei KI und Gesundheitsdaten).
- **§ 203 StGB:** Schweigepflicht. IT-Dienstleister müssen ausdrücklich zur Verschwiegenheit verpflichtet werden.
- **Hygiene (IfSG § 23/§ 36, RKI/KRINKO, MPBetreibV):** Aufbereitung der Instrumente, **Chargenrückverfolgung Sterilgut ↔ Patient**, Validierung des Sterilisators, Gerätebuch.
- **GoBD + KassenSichV:** Bei Barzahlung über eine elektronische Kasse ist eine **TSE** (technische Sicherheitseinrichtung) nötig, und seit 2025 gibt es eine Meldepflicht für Kassen. → lexoffice/Lexware Office ist **keine** Kasse. Barumsätze laufen über ein TSE-Kassensystem (**SumUp POS** oder eine Cloud-TSE wie **fiskaly** im CRM), mit DSFinV-K-Export. Vorher steuerlich klären.
- **Gutscheine:** Verjährung nach § 195 BGB (3 Jahre bis Jahresende), Einzweck- oder Mehrzweckgutschein nach § 3 Abs. 13–15 UStG.
- **EU AI Act:** Für KI-Telefon und Chatbot gilt eine **Transparenzpflicht** (Art. 50): Kunden müssen wissen, dass sie mit einer KI sprechen. Ein Mensch kontrolliert alle medizinischen Aussagen.

### 3.2 Pflichtinhalte der Dokumentation (als Formulare im System)
1. **Anamnese** (beim Erstbesuch, danach regelmäßig aktualisieren): Diabetes (Typ, HbA1c, seit wann), pAVK/Durchblutung, Neuropathie, Antikoagulation (Blutungsgefahr!), Allergien (Latex, Desinfektionsmittel), Medikation, Infektionen (MRSA, Hepatitis), Schuhversorgung, Einlagen, Hausarzt
2. **Befund** (Fuß links/rechts getrennt): Haut (Hyperkeratose, Clavus, Rhagaden, Mykose, Ulkus), Nägel (Onychomykose, Unguis incarnatus, Onychogryposis, Involution), Durchblutung (Fußpulse), Sensibilität (**Monofilament 10 g, Stimmgabel 128 Hz**), Temperatur, Fehlstellungen (Hallux valgus, Hammerzehen). **DFS-Einstufung nach Wagner/Armstrong**, Risikoklasse
3. **Behandlung pro Termin:** Datum, Uhrzeit, Behandler, Leistungen (Positionsnummer), Material, **Sterilgut-Charge**, Reaktion und Besonderheiten, Empfehlung, nächster Termin
4. **Nagelspangen:** Spangentyp/Produkt, Stadium, Setzen/Wechsel/Abnahme, **Begründung bei Wechsel des Spangentyps**
5. **Therapiebericht an den Arzt** (bei Bedarf, z. B. bei Verschlechterung)
6. **Einwilligungen:** Datenschutz, Fotos, Kommunikationskanal (WhatsApp, E-Mail), Erinnerungen, Bewertungsanfragen, KI-Verarbeitung

### 3.3 Fotodokumentation (Pflicht und Standard)
| Anlass | Pflicht? | Umsetzung im System |
|---|---|---|
| **Nagelspange vor Beginn** | Pflicht (G-BA/§ 125, UI2) | Schritt „Foto vorher“ ist für das Setzen einer Spange Pflicht und blockiert sonst den Abschluss |
| **Nagelspange bei Verschlechterung oder Komplikation** | Pflicht, sofort | Auswahl „Verschlechterung“ öffnet die Kamera |
| **Nagelspange nach Abschluss** | Pflicht | Bei der Abnahme ist das Foto Pflicht |
| DFS/Ulkus, Wunden | dringend empfohlen (Verlauf, Haftung) | Vorlage mit Messlineal |
| Erstbefund | empfohlen | Standardansichten (siehe unten) |
| Vorher/Nachher Selbstzahler | optional, nur mit Einwilligung | auch für Marketing (gesonderte Einwilligung) |

**Foto-Standard (wird in der App vorgegeben):** Ansichten plantar, dorsal, medial, lateral und Nahaufnahme des betroffenen Zehs. Gleiche Entfernung und gleiches Licht über ein Overlay-Raster in der Kamera. Optional ein Maßstab/Lineal. Seitenangabe L/R und Zehennummer (D1–D5) sind Pflichtfelder. Das Foto wird dem Befundpunkt in der Fußgrafik zugeordnet. **Fotos werden nie auf der iPhone-Kamerarolle gespeichert**, sondern direkt verschlüsselt hochgeladen. Metadaten (Zeit, Gerät, Behandler) bleiben unveränderbar.

---

## 4. Funktionsumfang (Module)

Legende: **P1** = MVP für die eigene Praxis · **P2** = Ausbau · **P3** = SaaS und Zusatzmodule

### 4.1 Kundenakte und CRM (P1)
- Stammdaten wie im Excel, dazu Krankenkasse/Versichertenstatus (GKV/PKV/Selbstzahler/Beihilfe), Hausarzt, Kontakt für Angehörige oder Betreuer, **Hausbesuch-Adresse mit Route**
- **Zeitleiste** mit allem an einem Ort: Termine, Doku, Fotos, Rechnungen, E-Mails, WhatsApp, Anrufe, Bewertungen
- **Risiko-Ampel** im Kopf der Akte: Diabetes, Blutverdünner, Allergien, MRSA (immer sichtbar)
- Automatischer Status: Neu / Aktiv / Überfällig (z. B. kein Termin seit über 8 Wochen, Intervall je Kunde) / Inaktiv
- Segmente und Tags, Dubletten-Erkennung, Familienverknüpfung (z. B. Ehepaare)
- Excel-Import (V0.9.2), CSV-Import, **Doctolib-Import und -Export**

### 4.2 Termine (P1)
- Tages-, Wochen- und Behandleransicht, Räume/Stühle als Ressourcen, Drag-and-Drop, Intervall-/Serientermine
- Terminlänge aus dem Leistungskatalog (Dauer)
- **Tourenplanung für Hausbesuche** (Reihenfolge optimieren, km für die Abrechnung)
- Wartelisten: Bei einer Absage wird automatisch der nächste Kunde von der Warteliste gefragt
- Erinnerungen per SMS, WhatsApp oder E-Mail (24 h / 2 h vorher), Absage- und Verschiebelink
- iCal-Abo pro Mitarbeiter, Google-Kalender-Sync
- Online-Buchung: eigenes Widget **und** Doctolib (Kap. 6.2)

### 4.3 Mobile Doku-App fürs iPhone (P1, Kernfunktion)
- PWA mit „Heute“-Ansicht: nächster Kunde, Risiko-Ampel, letzte Behandlung, letzte Fotos
- **Kamera im CRM** mit Overlay, Seiten- und Zehenauswahl, Pflichtfoto-Assistent (Spange)
- **Sprachbericht:** Aufnahme, Transkription (Whisper o. Ä., EU-Hosting), dann **KI-Strukturierung** in die Felder Befund, Leistung, Material und Empfehlung. Der Behandler prüft und bestätigt, danach ist der Eintrag unveränderbar. Die Audiodatei wird nach der Bestätigung gelöscht (Datensparsamkeit, einstellbar).
- **Fußgrafik** (2D in P1, 3D in P2) mit Markierungspunkten, Kürzel-System
- Sterilgut-Charge per **Barcode/QR-Scan** des Sterilguts
- Offline-Modus: Aufnahmen werden lokal verschlüsselt zwischengespeichert und später synchronisiert
- Face ID / Passkey zum Entsperren, automatische Sperre

### 4.4 Rechnungen, Kasse, Zahlungen (P1)
- Rechnung, Quittung, Sammelrechnung (wie im Excel), Faktor, Mischzahlung, Gutschein-Einlösung
- USt-Logik: Heilbehandlung steuerfrei (§ 4 Nr. 14 UStG), kosmetische Fußpflege oder Produktverkauf 19 %
- **lexoffice ist führend für Belege** (Rechnung wird in lexoffice angelegt, PDF und Nummer kommen zurück), alternativ eigener Nummernkreis
- **SumUp:** Kartenzahlung über die Cloud-API am Solo-Terminal, Zahlungslink/QR für Vorkasse, Webhook setzt die Rechnung auf „bezahlt“
- Offene Posten, Mahnstufen, Zahlungserinnerung per WhatsApp/E-Mail
- PKV/Beihilfe: **keine** eigene Gebührenordnung für Podologen (GebüH gilt nur für Heilpraktiker). Stattdessen eigener Privat-Preiskatalog, Honorarvereinbarung mit Hinweis zur möglichen Nichterstattung, beihilfetauglicher Ausdruck
- Produktverkauf (Cremes, Einlagen) mit einfacher Lagerverwaltung

### 4.5 Kommunikation und Posteingang (P1/P2)
- **Ein Posteingang** für E-Mail (IMAP/SMTP, Gmail, Microsoft 365), **WhatsApp Business (Cloud API)**, SMS und Webformular
- Nachrichten werden automatisch dem Kunden zugeordnet (über E-Mail-Adresse oder Telefonnummer)
- **KI-Antwortassistent:** liest Nachricht und Kontext (Termine, offene Rechnungen) und schlägt eine Antwort vor, z. B. „Termin verschieben? Hier 2 freie Slots“. Der Mensch gibt frei. Auto-Senden nur für unkritische Kategorien (Öffnungszeiten, Anfahrt), und nur wenn es eingeschaltet ist.
- Vorlagen und Kampagnen: Geburtstag, Rückholung (überfällig), Saison (Sandalenzeit), Gutscheinverkauf zu Weihnachten
- Recall nach Spangenabschluss, Kontrolle nach 6 Wochen

### 4.6 KI-Telefonagent (P2, in P1 nur als Platzhalter)
- Schnittstelle `VoiceAgentProvider` mit Adaptern z. B. für **Vapi, Retell, ElevenLabs Agents, Fonio (DE), sipgate AI Flow**
- Aufgaben: Anrufe außerhalb der Öffnungszeiten, Termin buchen/verschieben/absagen (über unsere Termin-API), FAQ, Rückrufbitte
- **Keine medizinische Beratung**, bei Notfällen (Wunde, Entzündung beim Diabetiker) Weiterleitung oder Hinweis auf den Arzt
- Ansage „Sie sprechen mit einem KI-Assistenten“ (AI Act). Aufzeichnung und Transkript nur mit Einwilligung, Ablage in der Zeitleiste

### 4.7 Bewertungen und Reputation (P2)
- **Google Business Profile API:** Bewertungen einlesen, KI-Antwortvorschlag, Antwort veröffentlichen
- Automatische Bewertungsanfrage nach dem Termin, **nur mit Einwilligung, an alle Kunden gleich** (kein „Review Gating“, das verstößt gegen die Google-Richtlinien und das UWG)
- Hinweis: **Keine Gesundheitsdetails in öffentlichen Antworten** (Schweigepflicht! Schon die Bestätigung „Sie waren bei uns in Behandlung“ ist heikel)

### 4.8 Auswertungen und Praxisfinanzen (P1/P2)
- Umsatz, Behandlungen, Auslastung, Umsatz pro Stunde, Neukunden, Wiederkehrrate, No-Show-Quote
- **Fixkosten, Fälligkeiten, Break-even, Planung nach Arbeitstagen und Urlaub** (aus dem Kalkulationsblatt)
- Materialkosten pro Behandlung, Marge pro Leistung

### 4.9 News und Wissen (P2)
- Feeds aus RSS und Webseiten: Fachverbände (VDP, ZFD), Fachzeitschriften (DER FUSS, Podologie-Fachmagazine), Hersteller (Ruck, Gehwol, Podofix, BS-Spangen), G-BA/GKV-SV (Vertragsänderungen!), Messen (Podologie-Kongresse)
- **KI-Zusammenfassung und Kategorien:** Recht & Abrechnung · Techniken · Geräte · Produkte · Fortbildung
- „Für dich relevant“: z. B. ein neues Spangensystem, wenn die Praxis viele Spangen-Patienten hat
- **Regel-Wächter:** Änderungen am Vertrag nach § 125 oder an der HeilM-RL werden hervorgehoben und als Aufgabe angelegt
- Fortbildungsnachweise der Mitarbeiter

### 4.10 Benutzer und Rechte (P1)
- Rollen: **Inhaber**, **Podologe/Therapeut**, **Empfang/Verwaltung** (keine medizinischen Inhalte), **Azubi/Praktikant** (nur lesen, Doku mit Gegenzeichnung), **Steuerberater** (nur Finanzen), **Super-Admin (SaaS-Betreiber)**
- Rechte auf Feldebene (z. B. Empfang sieht keine Befunde), Passkeys/2FA Pflicht
- **Audit-Log** jedes Lesezugriffs auf Gesundheitsdaten, Notfallzugriff mit Protokoll

### 4.11 SaaS und Mandantenfähigkeit (P3, Architektur ab P1)
- Mandant = Praxis (Organisation) mit mehreren Standorten
- Selbstregistrierung, Testphase, Abrechnung des Abos über **Stripe Billing** (oder SumUp/lexoffice)
- Preismodell-Idee: Basis **59 €/Monat** inkl. 1 Behandler (unter tinana), **+15 €** je weiterem Behandler, Zusatzmodule KI-Telefon (nutzungsbasiert), GKV-Abrechnung (prozentual oder pauschal), White-Label-Buchungsseite
- Onboarding-Assistent mit Excel-/Doctolib-Import, Vorlagen-Bibliothek (Leistungskatalog, Formulare)
- Rechtlich: AVV-Muster, § 203-Verpflichtung, TOMs, SLA, Datenexport beim Kündigen

### 4.12 Weitere Ideen (zur Auswahl, siehe Grill-Liste)
1. **Kunden-Portal/App:** eigene Termine, Rechnungen, Gutscheine, Fotos (nur mit Freigabe), Anamnesebogen vorab ausfüllen
2. **Digitaler Anamnesebogen** per Link oder Tablet am Empfang mit Unterschrift, wird automatisch in die Akte übernommen
3. **Gutscheinshop online** (SumUp-Zahlungslink), zu Weihnachten und Muttertag ein großer Umsatzbringer
4. **Abos/Pakete:** „Fußpflege-Flat“ oder 10er-Karte mit Abbuchung
5. **KI-Fotovergleich:** Vorher/Nachher nebeneinander, Ausrichtung automatisch; KI-*Hinweis* auf Veränderungen, **keine Diagnose** (sonst wäre es ein Medizinprodukt nach MDR!)
6. **Hygiene-Modul:** Sterilisator-Chargen, Freigabe, Gerätebuch, Wartungs- und Prüffristen (DGUV V3, Validierung) mit Erinnerung
7. **Material- und Bestellmanagement** mit Mindestbestand und Bestellliste beim Händler
8. **Arztbrief/Therapiebericht per KI** aus der Doku, Versand per KIM (P3) oder PDF
9. **Verordnungs-OCR** (wie pododesk/tinana): Foto der Verordnung, Daten werden ausgelesen und geprüft
10. **Mitarbeiter:** Dienstplan, Urlaub, Arbeitszeiterfassung (Pflicht nach BAG-Urteil), Provision
11. **Mehrsprachigkeit** (DE/EN/TR/RU/PL) für Kundenkommunikation
12. **Empfehlungsprogramm** Kunde wirbt Kunde (Gutschein als Belohnung)
13. **Barrierefreiheit** (BFSG seit 06/2025 für Online-Buchung relevant)
14. **Partner-Marktplatz** für Händler/Hersteller (siehe Kap. 8)

---

## 5. Datenmodell (Kern, vereinfacht)

```
organization (Mandant) ─┬─ location (Standort) ── room/chair
                        ├─ user ── membership(role, location)
                        ├─ patient ─┬─ consent (Typ, Version, Zeitpunkt, Kanal)
                        │           ├─ anamnesis (versioniert)
                        │           ├─ finding (Befund; foot_side, toe, point_id)
                        │           ├─ treatment_record (append-only) ─┬─ service_item
                        │           │                                  ├─ sterile_batch
                        │           │                                  ├─ media (Foto/Audio, verschlüsselt)
                        │           │                                  └─ addendum (Nachtrag)
                        │           ├─ brace_episode (Nagelspange: Typ, Stadium, Pflichtfotos)
                        │           ├─ prescription (HVO, P3)
                        │           ├─ appointment ── appointment_service
                        │           ├─ invoice ── invoice_line, payment (Bar/EC/SumUp/GS/Überweisung)
                        │           ├─ voucher_redemption
                        │           └─ conversation ── message (E-Mail/WA/SMS/Call/Review)
                        ├─ service_catalog (Code, Preis, USt, Dauer, GKV-Pos.)
                        ├─ voucher
                        ├─ fixed_cost, plan
                        ├─ integration_connection (Anbieter, verschlüsselte Tokens, Status)
                        ├─ webhook_event (Eingang, Idempotenz)
                        ├─ news_item, news_source
                        └─ audit_log (wer, was, wann, Lesen und Schreiben)
```
Alle Tabellen haben `organization_id` und **Row-Level-Security**. Medizinische Einträge sind **append-only** (Trigger verhindert UPDATE/DELETE) und haben eine Hash-Kette zum Nachweis der Unverändertheit.

---

## 6. Schnittstellen (alle in P1 als Adapter angelegt)

Architekturprinzip: **Ports & Adapters.** Jede Integration implementiert ein Interface, hat einen eigenen Verbindungsstatus pro Mandant, verschlüsselte Zugangsdaten, Webhook-Eingang mit Signaturprüfung, Retry-Queue und Sync-Log. So kann jede Schnittstelle zuerst als „Mock“ laufen und später echt angebunden werden.

| # | Integration | Zweck | Technik | Status/Risiko |
|---|---|---|---|---|
| 6.1 | **lexoffice (Lexware Office)** | Kontakte, Rechnungen, Gutschriften, Zahlungsstatus, Belege | Public REST API (`api.lexoffice.io` bzw. `api.lexware.io`), API-Key pro Mandant, Event-Subscriptions (Webhooks) | ✅ gut dokumentiert. API-Zugang ist in dieser Umgebung bereits freigeschaltet. Rate-Limit ca. 2 Anfragen/s |
| 6.2 | **Doctolib** | Termine und Patienten synchronisieren | **Partner-API nur für zugelassene Partner** (Doku passwortgeschützt). Bis dahin: **CSV-Import/-Export** (wie im Excel-Blatt) und **iCal/E-Mail-Bestätigungen parsen** | ⚠️ größtes Risiko. Früh Partnerantrag stellen. Alternative: eigenes Buchungs-Widget |
| 6.3 | **SumUp** | Kartenzahlung am Terminal, Zahlungslinks, Transaktionen | REST API, OAuth2, **Cloud API für Solo-Reader**, Checkouts, Webhooks | ✅ gut machbar |
| 6.4 | **GKV-Abrechnung / TI / KIM** | § 302-Datenträgeraustausch, **TI-Anschluss für Heilmittelerbringer laut DigiG ab 01.01.2026 Pflicht**, eVerordnung Heilmittel geplant (Termin prüfen), KIM | Über einen **Abrechnungszentrum-Partner** (z. B. opta data, AZH, RZH) oder TI-Dienstleister, kein Eigenbau in P1 | ⚠️ hoher Aufwand und Zertifizierung, deshalb P3 |
| 6.5 | **Google Business Profile** | Bewertungen lesen und beantworten | Google My Business API (Freischaltung beantragen), OAuth | ⚠️ Antrag bei Google nötig |
| 6.6 | **E-Mail** | Posteingang | IMAP/SMTP, Gmail API, Microsoft Graph | ✅ |
| 6.7 | **WhatsApp Business** | Kommunikation, Erinnerungen | Meta Cloud API über BSP (z. B. 360dialog, EU), Vorlagen-Freigabe | ✅, ⚠️ Datenschutz (Meta) → Einwilligung |
| 6.8 | **SMS** | Erinnerungen | z. B. sipgate, seven.io (DE) | ✅ |
| 6.9 | **Telefon/KI-Agent** | Anrufe annehmen | sipgate/Placetel + Vapi/Retell/Fonio | P2 |
| 6.10 | **Transkription und KI** | Sprachbericht, Antworten, News | LLM über EU-Endpunkt (z. B. Azure OpenAI EU, Mistral, Claude über AWS Bedrock Frankfurt), Whisper EU | AVV und **kein Training** auf Kundendaten |
| 6.11 | **Kalender** | iCal-Feed, Google Calendar | ICS-Feed, Google API | ✅ |
| 6.12 | **Stripe** | SaaS-Abos | Stripe Billing | P3 |
| 6.13 | **DATEV / sevdesk** | für andere Praxen ohne lexoffice | DATEV-Export (CSV), sevdesk API | P3 |
| 6.14 | **Karten/Routen** | Hausbesuche | Google Maps/OSRM | P2 |
| 6.15 | **Feiertage** | Kalender | feiertage-api.de | ✅ |

---

## 7. Technik-Architektur (Vorschlag)

- **Frontend:** Next.js (React, TypeScript) + Tailwind + shadcn/ui, **PWA** (Kamera über `getUserMedia`/`<input capture>`, Mikrofon über MediaRecorder), später Capacitor für den App Store
- **Backend:** Next.js API + Hintergrund-Jobs (BullMQ/Redis) **oder** Supabase (Postgres + Auth + Storage + Edge Functions) **selbst gehostet** auf deutschem Server
- **Datenbank:** PostgreSQL mit RLS, `pgcrypto`, verschlüsselte Spalten für sensible Felder, append-only-Trigger
- **Dateien:** S3-kompatibel in DE (Hetzner Object Storage oder MinIO), serverseitige Verschlüsselung, signierte URLs mit kurzer Laufzeit
- **Auth:** Passkeys/WebAuthn + TOTP, Sitzungen mit kurzer Laufzeit, Geräteverwaltung
- **Infrastruktur:** Docker Compose auf deinem Server (oder Hetzner Cloud, Falkenstein/Nürnberg), Coolify als Deployment-Oberfläche, tägliche verschlüsselte Backups an einem zweiten Standort, Monitoring (Uptime Kuma, Sentry selbst gehostet)
- **Code:** GitHub (privates Repo), CI mit GitHub Actions (Tests, Lint, Build, Deploy)
- **Design-System:** flach, modern, helle frische Farben, **Hell/Dunkel-Umschalter** (siehe Design-Vorschau). Primärfarbe Mint/Türkis (Frische, Medizin), Akzent Koralle (Aktionen), viel Weißraum, große Touch-Ziele (≥ 44 px) fürs iPhone

> Hinweis: Die verbundenen Dienste **Vercel** und **Supabase Cloud** sind für Prototyp und Demo mit Testdaten praktisch. Für **echte Patientendaten** empfehle ich deutsches Hosting mit AVV (Supabase EU-Region Frankfurt geht grundsätzlich mit AVV; Vercel ist für Gesundheitsdaten nicht zu empfehlen).

---

## 8. Affiliate und Partnerschaften (Apotheken, Sanitätshäuser, Hersteller)

**Kurz: Ja, es gibt Affiliate-Programme, aber im Gesundheitswesen gelten strenge Grenzen.**

| Modell | Erlaubt? | Begründung |
|---|---|---|
| Provision dafür, dass der Podologe **Patienten an ein Sanitätshaus oder eine Apotheke schickt** (Einlagen, Hilfsmittel, Arzneimittel) | ❌ **nein** | **§ 299a/§ 299b StGB** (Bestechlichkeit im Gesundheitswesen gilt auch für Podologen als staatlich geregelten Heilberuf), **§ 128 SGB V** (Verbot von Zuwendungen bei Hilfsmitteln), Heilmittelwerbegesetz |
| Provision für Patienten-Links zu **Online-Apotheken** (z. B. Shop Apotheke, DocMorris über Awin) für frei verkäufliche Pflegeprodukte | ⚠️ Grauzone | Rechtlich prüfen lassen. Wenn überhaupt: offen kennzeichnen, keine Bindung an die Behandlung, freie Wahl des Patienten |
| **Eigener Produktverkauf** in der Praxis (Cremes, Strümpfe) | ✅ | Normaler Handel mit 19 % USt, Beratung neutral halten |
| **B2B-Affiliate/Partner für Praxisbedarf** (Instrumente, Spangen, Verbrauchsmaterial, z. B. Ruck, Gehwol, Podo-Shops) | ✅ | Das CRM verdient am Einkauf der Praxis, nicht am Patienten. Passt gut zum Material-Bestellmodul und zur News-Rubrik „Geräte“ |
| **Software-Partnerprogramme** (lexoffice, SumUp, sipgate haben Partner-/Empfehlungsprogramme) | ✅ | Einnahmen für die SaaS, wenn neue Praxen über uns diese Dienste buchen |
| Gesponserte News/Produktvorstellungen | ✅ mit Kennzeichnung „Anzeige“ | Trennung von Redaktion und Werbung |

**Empfehlung:** Einnahmen über **B2B-Partner (Praxisbedarf und Software)** planen, **nicht** über Patientenzuweisung. Vor dem Start einmal durch einen Medizinrechtler prüfen lassen (ca. 1–2 h Beratung).

---

## 9. Server und Zusammenarbeit
- **Code:** GitHub-Repository (privat). Ich lege die Struktur an, du verbindest das Repo mit dieser Sitzung, dann pushe ich, und wir arbeiten über Pull Requests.
- **Server:** Für Entwicklung und Test mit Testdaten reicht dein Server oder ein Hetzner CX32 (ca. 7–10 €/Monat) mit Docker und Coolify. Für den echten Betrieb: AVV mit dem Hoster, Server in DE, Backup an einem zweiten Standort.
- **Umgebungen:** `dev` (Testdaten, jeder Push), `staging` (Demo für andere Podologen), `prod` (echte Daten, nur freigegebene Versionen).

---

## 10. Roadmap

| Phase | Dauer (Schätzung, 1 Entwickler + KI) | Inhalt | Ergebnis |
|---|---|---|---|
| **0 – Fundament** | 2 Wochen | Repo, CI, Server, Auth/Rollen, Mandanten, Design-System Hell/Dunkel, Datenmodell, Excel-Import | Login, leere App, eigene Daten importiert |
| **1 – MVP eigene Praxis** | 6–8 Wochen | Akte + CRM, Kalender, Leistungen, Doku-App (Fotos, Sprachbericht, Fußgrafik, Spangen-Pflichtfotos, Charge), Rechnungen/Gutscheine, **lexoffice**, **SumUp**, Doctolib-CSV, E-Mail-Posteingang, Dashboard + Finanzen | Excel kann abgeschaltet werden |
| **2 – Kommunikation und KI** | 6 Wochen | WhatsApp, SMS-Erinnerungen, KI-Antworten, Kampagnen, Google-Bewertungen, News, Kundenportal und Online-Anamnese, Tourenplanung, KI-Telefon (Pilot) | Weniger Telefon, mehr Umsatz |
| **3 – SaaS** | 6–8 Wochen | Selbstregistrierung, Stripe, Onboarding, Vorlagen, Marketing-Website, AVV/Rechtstexte, Support | Erste 5–10 Pilotpraxen |
| **4 – GKV und TI** | offen | Partner-Abrechnung § 302, Verordnungs-OCR, KIM, eVerordnung | Gleichstand mit pododesk/tinana |

---

## 11. Risiken
1. **Doctolib-API** ist nicht offen zugänglich. → CSV/iCal als Übergang, Partnerantrag, eigene Buchung als Plan B
2. **Datenschutz/Gesundheitsdaten:** DSFA, AVVs mit allen Unterauftragnehmern (KI, WhatsApp, SMS, Hosting), Pentest vor dem SaaS-Start
3. **MDR-Falle:** KI-Funktionen dürfen **keine Diagnose oder Therapieempfehlung** geben, sonst gelten sie als Medizinprodukt. → nur Dokumentationshilfe, der Mensch entscheidet
4. **GKV-Abrechnung** ist komplex. → bewusst später und über einen Partner
5. **Haftung beim KI-Telefon** (falsche Auskunft). → strenge Grenzen, Protokoll, Übergabe an einen Menschen
6. **Kassengesetz:** Bar nur über SumUp POS oder fiskaly-TSE. Vorher mit dem Steuerberater klären

---

## 12. Nächste Schritte
1. Du beantwortest die Grill-Liste (unten)
2. GitHub-Repo anlegen und mit der Sitzung verbinden, Server-Zugang klären
3. Ich baue Phase 0 und den klickbaren Prototyp der Doku-App
4. lexoffice- und SumUp-Testkonten, Doctolib-Partneranfrage, Antrag für die Google Business Profile API
5. Termin mit Datenschutz und Medizinrecht (DSFA, AVV-Muster, Affiliate-Prüfung)

---

## 13. Grill-Liste (offene Fragen an dich)

**A. Praxis und Zielbild**
1. Wie viele Behandler, Standorte und Patienten pro Woche hast du? Machst du Hausbesuche, und wie viele?
2. Welcher Anteil sind GKV-Verordnungen, PKV und Selbstzahler? Rechnest du heute GKV ab, und wenn ja, über wen?
3. Ist das System erst für dich, und der Verkauf kommt danach? Oder soll es von Anfang an als Produkt gebaut werden (Name, Marke, GmbH)?
4. Wer entwickelt mit? Nur wir beide, oder gibt es weitere Entwickler oder Designer?

**B. Doku und Fotos**
5. Welche Geräte nutzt ihr: nur iPhone oder auch iPad am Behandlungsstuhl? Darf ein Handy pro Behandler genutzt werden (Firmengerät)?
6. Fußgrafik: reicht 2D mit Punkten, oder ist 3D (wie pododesk) wichtig?
7. Sterilgut: Gibt es Barcodes/Etiketten aus dem Sterilisator (welches Gerät)?
8. Sprachbericht: Soll die Audiodatei gelöscht oder aufbewahrt werden?

**C. Termine und Doctolib**
9. Läuft heute *alles* über Doctolib, oder auch Telefon und WhatsApp? Soll Doctolib bleiben oder langfristig durch eine eigene Buchung ersetzt werden?
10. Gibt es einen Doctolib-Vertrag mit Kalender-Sync (Doctolib-Agenda), und welche Exportmöglichkeiten hast du dort?

**D. Geld**
11. lexoffice: Welcher Tarif? Sollen Rechnungen *in* lexoffice entstehen oder im CRM (lexoffice bekommt dann nur den Beleg)?
12. SumUp: Welches Terminal (Solo, Air)? Gibt es SumUp-Kasse oder eine andere Kasse mit TSE?
13. Gutscheine: auch online verkaufen?

**E. Kommunikation und KI**
14. Welche E-Mail nutzt du (Gmail, Outlook, IONOS …)? WhatsApp Business App oder schon die API?
15. KI-Antworten: nur Vorschläge, oder darf die KI bei einfachen Fragen selbst antworten?
16. KI-Telefon: Welche Telefonanlage/Nummer (sipgate, Telekom, Fritzbox)? Nur außerhalb der Öffnungszeiten oder immer?
17. Welche KI-Anbieter sind ok? (Nur EU-Hosting? OpenRouter ist schon verbunden, aber für Patientendaten nicht geeignet)

**F. SaaS**
18. Preisvorstellung? Soll es eine kostenlose Basisversion geben?
19. White-Label (Praxis-Logo/Farben auf Buchungsseite und Rechnungen) ja oder nein?
20. Brauchen Kunden-Praxen GKV-Abrechnung zwingend, oder gibt es genug reine Selbstzahler- und Mischpraxen als ersten Markt?

**G. Technik und Server**
21. „kuthib“: Meinst du **GitHub**? Welches Konto oder welche Organisation?
22. Dein Server: Anbieter, Standort (DE?), Betriebssystem, Root-Zugang, Docker vorhanden? Domain vorhanden?
23. Sollen wir für den Prototyp Supabase/Vercel (schon verbunden) nehmen und später umziehen, oder gleich selbst hosten?

---

## 14. Review-Ergebnis (GPT-5.6, Gemini Pro, Mistral Large) und Änderungen in v0.2

Die vollständigen Reviews stehen in `docs/reviews/`. Was **übereinstimmend** kritisiert wurde und was daraus folgt:

### 14.1 Korrigierte Fehler
- GebüH/BEB gilt nicht für Podologen → korrigiert (eigener Privatkatalog)
- „lexoffice-Kasse mit TSE“ gibt es nicht → korrigiert (SumUp POS/fiskaly)
- TI-Pflicht für Heilmittelerbringer ab 01.01.2026 (DigiG) → ergänzt. **Das macht GKV/TI strategisch wichtiger** (siehe 14.3)
- **USt:** 0 % nach § 4 Nr. 14 UStG nur bei Heilbehandlung mit therapeutischem Ziel. Das lässt sich nicht pauschal je Leistungscode festlegen. Bei Selbstzahlern muss der Nachweis (Privatrezept, Diagnose, Befund) hinterlegt sein → **USt-Wächter** pro Behandlung, Klärung mit dem Steuerberater
- Rechtsgrundlage für die Doku ist **Art. 9 Abs. 2 lit. h DSGVO + § 22 BDSG**, nicht die Einwilligung. Einwilligungen nur für Marketing, Fotos zu Werbezwecken, WhatsApp, Aufzeichnungen und KI-Telefon
- Aufbewahrung bei **Minderjährigen**: länger (Volljährigkeit plus Frist), Löschmatrix je Datenklasse
- Gutscheine: § 195/§ 199 BGB betreffen die Verjährung, nicht automatisch die Gültigkeit. Befristung per AGB rechtlich prüfen
- Pflichtfelder in der Anamnese (HbA1c, Stimmgabel …) **indikationsabhängig** machen, nicht pauschal (Datensparsamkeit). DFS-Risiko zusätzlich nach **IWGDF 0–3** (NVL DFS)
- Foto- und Spangenpflichten genau aus der **aktuell gültigen Leistungsbeschreibung** modellieren (2025 geändert) und als **versionierte Regeln** hinterlegen
- MDR: Maßgeblich ist die **Zweckbestimmung** (Regel 11). KI-Fotovergleich und Risikopriorisierung nur als Anzeige- und Ablagehilfe, ohne medizinische Bewertung

### 14.2 Neue Anforderungen
- **Abweichender Rechnungsempfänger** (Betreuer, Angehörige, **Pflegeheim**) ab Tag 1 im Datenmodell
- **Pflegeheim-Modus:** viele Patienten an einem Ort, Listen-Doku, Sammelrechnung
- **Ausfallhonorar** (§ 615 BGB) mit AGB-Zustimmung bei der Buchung und 1-Klick-Rechnung
- **Storno/Gutschrift/Korrektur-Workflow** für Rechnungen. Doku-Nachträge statt Änderungen
- **Strukturierte Wunddoku** (TIME-Schema, Größe, Exsudat) für DFS
- **Hygiene-Checklisten** und Gerätebuch (bisher nur als Idee)
- DSGVO-Prozesse: Auskunft (auch maschinenlesbar), Löschung vs. Aufbewahrung, Datenpannen nach Art. 33/34, Exit-Export, Löschung des Mandanten inkl. Backups
- **Handschuh-Bedienung:** große Buttons, Sprachsteuerung („Foto D1 rechts“, „Spange gesetzt“)
- Migrationsbericht beim Excel-Import (Dubletten, Fehler, Herkunft)

### 14.3 Strategie-Entscheidung (wichtigste offene Frage)
Alle Reviewer betonen: **Echte Podologie-Praxen haben oft 70–90 % GKV-Umsatz.** Ohne Verordnungsmanagement und GKV-Abrechnung lässt sich das SaaS an diese Praxen kaum verkaufen. Optionen:
- **A) Selbstzahler- und Mischpraxen zuerst** (wie deine Excel-Datei), GKV über einen Partner ab Phase 2
- **B) Von Anfang an GKV:** Verordnungsmanagement (Fristen, Frequenz, Zuzahlung) im MVP, Abrechnung über ein Abrechnungszentrum (opta data, Optica, noventi/azh, RZH) ab Phase 2, TI/KIM über einen Partner

→ **Meine Empfehlung: B-light.** Verordnungsmanagement ins MVP, Abrechnung über einen Partner in Phase 2. So kann die eigene Praxis sofort damit arbeiten, und der Verkauf ist nicht blockiert.

### 14.4 Architektur-Änderungen
- **Capacitor (native iOS-Hülle) ab Tag 1** statt reiner PWA. Grund: iOS löscht PWA-Speicher, Kamera direkt ohne Kamerarolle (AVFoundation), Schlüssel in Keychain/Secure Enclave
- **Kein Offline-Speicher für Fotos/Audio im MVP.** Upload sofort. Nur Firmengeräte, ideal mit MDM
- **Schlüsselverwaltung** extern (KMS/Vault), Rotation. Datenbank-Admin hat keinen Klartext-Zugriff
- Audit-Log für Lesezugriffe im **API-Layer**, nicht über DB-Trigger
- Manipulationsnachweis: Hash-Kette **plus externe Signatur/WORM-Speicher** (Object Lock)
- Mandantentrennung: `tenant_id` serverseitig aus der Sitzung, RLS als zweite Schicht, auch Storage, Jobs, Logs, Exporte prüfen
- Super-Admin **ohne** Dauerzugriff auf Patientendaten: Just-in-time-Supportzugang mit Freigabe durch die Praxis
- Sentry, Logs, CI: Gesundheitsdaten herausfiltern (PHI-Redaction)
- SaaS-Betrieb: managed PostgreSQL mit Point-in-Time-Recovery, festgelegte RPO/RTO-Ziele, **Restore-Tests**, Pentest vor dem ersten fremden Mandanten
- Routen nicht mit Patientennamen an Google senden (nur Adresse), alternativ OSRM selbst gehostet
- **WhatsApp:** nur Organisatorisches (Termine), keine medizinischen Inhalte, ausdrückliche Einwilligung mit Risikohinweis. SMS/E-Mail als Standard
- KI-Anbieter: AVV mit **Zero Data Retention** und ohne Training auf Kundendaten
- **lexoffice nur als Ziel für Belege** (Voucher-API). Rechnungsnummern, Mischzahlung und Gutscheine sind im CRM führend
- Doctolib: Partnerantrag hat Priorität. Bis dahin CSV-Import und optional ein **Parser für Bestätigungsmails** (Vertrag prüfen, Konflikte manuell auflösen)

### 14.5 Neue Roadmap (realistisch)
| Phase | Dauer | Inhalt |
|---|---|---|
| 0 | 3 Wochen | Repo, CI, Server, Auth (Passkeys), Rollen, Mandanten, Design-System, **DSFA/TOMs/Löschkonzept (Entwurf)**, Excel-Import mit Bericht |
| 1a | 6 Wochen | Akte, Kalender, Leistungskatalog, Doku mit Fotos (Capacitor) und indikationsabhängigen Formularen, Spangen-Pflichtfotos, Charge, Rechnung/Quittung/Gutschein im CRM, Export an lexoffice, SumUp-Kartenzahlung |
| 1b | 5 Wochen | Sprachbericht + KI-Strukturierung, Verordnungsmanagement (Fristen/Frequenz), Pflegeheim-Modus, Doctolib-CSV, Dashboard. **Die eigene Praxis läuft ohne Excel.** |
| 2 | 8 Wochen | Posteingang (E-Mail, SMS, später WhatsApp), KI-Antworten, Erinnerungen, Google-Bewertungen, News, Online-Anamnese, Kundenportal, **GKV-Abrechnung über Partner**, Kasse/TSE |
| 3 | 8 Wochen | SaaS: Registrierung, Stripe, Onboarding, Pentest, AVV-Paket, Pilotpraxen. KI-Telefon im Pilot |
| 4 | offen | TI/KIM, eVerordnung, 3D-Fuß, KI-Telefon in allen Praxen |

**Gesamt bis zum produktiven Einsatz in der eigenen Praxis: ca. 4 Monate. Bis zum SaaS: ca. 8–9 Monate.**

### 14.6 Weitere Mitbewerber (laut Review, noch zu prüfen)
opta data (thevea), Optica (Viva), noventi/azh (TiM), RZH, THEORG Go, buchnerFLOW, appointmed, lemniscus, Thera-Pi (Open Source), mediDOK (Bildarchiv), Samedi (Buchung). → Ziel: **15–20 Interviews mit Podologen** vor dem SaaS-Start.

---

## 15. Entscheidungen (07.11.2026)
| Thema | Entscheidung | Folge |
|---|---|---|
| GKV | **B-light** | Verordnungsmanagement im MVP (Phase 1b), GKV-Abrechnung über ein Abrechnungszentrum in Phase 2, TI/KIM über einen Partner |
| Code/Server | **GitHub + eigener Server** | Offen: Zugangsdaten, Anbieter, Standort (DE?), Betriebssystem, Docker, Domain |
| Geräte | **iPad am Stuhl + iPhone** | Capacitor-App für beide, Layout für iPad zuerst (Split-View: links Akte/Fußgrafik, rechts Doku), iPhone für Fotos und Sprache unterwegs/Hausbesuch |
| Kanäle zuerst | **Doctolib, WhatsApp, E-Mail, Telefon** | Phase 1b: Doctolib-CSV + Mail-Parser, E-Mail-Posteingang nach vorne (Phase 1b statt 2), WhatsApp-Cloud-API nur für Organisatorisches, Telefon: Anrufliste und Platzhalter für den KI-Agenten |

### 15.1 Zusätzliche Punkte aus dem Grok-Review
- **Keine echten Patientendaten im Repo oder in Konzepten.** Die Excel-Vorlage enthält echte Namen und Kontaktdaten, deshalb liegt sie nicht im Repo. Import nur auf dem Produktivserver
- **Kleinunternehmer-Schalter** (§ 19 UStG) und GoBD-Verfahrensdokumentation für SaaS-Kunden
- **Ein führender Nummernkreis** (CRM). lexoffice bekommt nur Belege, sonst GoBD-Konflikt
- Fehlendes Pflichtfoto blockiert den Abschluss **nicht**, sondern erzeugt eine Warnung und eine Begründungspflicht
- Terminerinnerung ist keine Werbung, Newsletter und Kampagnen aber schon (§ 7 UWG). Getrennte Einwilligungen
- iCal-Feeds **ohne Patientennamen** (nur Initialen/Leistung)
- Sprache/Transkription nur mit AVV (self-hosted Whisper oder EU-Anbieter), **nie über OpenRouter mit Echtdaten**
- Gutschein-Onlineverkauf: Widerrufsbelehrung, Button-Lösung (§ 312j BGB)
- Hygiene in der Podologie typischerweise **§ 36 IfSG + Landeshygieneverordnung**
