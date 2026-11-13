# Unterauftragnehmer und verbundene Dienste

> **Entwurf – vor Verwendung anwaltlich prüfen lassen.** Grundlage ist die interne Übersicht `docs/compliance/UNTERAUFTRAGNEHMER.md`. Konkrete Anbieter, Verträge und Standorte sind vom Betreiber vor dem Echtbetrieb einzutragen und zu prüfen.
>
> Version 0.2 · Stand 13.11.2026

## 1. Unterauftragnehmer des Betreibers

Diese Dienstleister setzen wir selbst ein, um PodoHero zu betreiben. Sie verarbeiten Daten nur nach unserer Weisung, mit Auftragsverarbeitungsvertrag und Verpflichtung auf die Verschwiegenheit nach § 203 StGB (siehe [AVV](/avv) § 6).

| Dienst | Zweck | Standort | Daten | Status |
|---|---|---|---|---|
| Hetzner Online GmbH (PodoHero-Cloud) | Server, Datenbank, verschlüsselte Dateiablage, Datensicherung | Deutschland | alle Praxisdaten (Fotos und Dokumente verschlüsselt) | AVV und § 203-Verpflichtung **abzuschließen** |
| Hetzner Online GmbH (Storage Box) | zweite Kopie der bereits verschlüsselten Datensicherung | Deutschland | nur verschlüsselte Sicherungen (Schlüssel liegt nicht beim Speicheranbieter) | **einzurichten** |

<!-- TODO (Betreiber): System-E-Mail-Versand (SMTP_URL in deploy/.env) – Anbieter und Standort hier eintragen, sobald festgelegt; bis dahin versenden Praxen über ihren eigenen SMTP-Zugang (Abschnitt 2). -->

**Hinweis Zahlungsabwicklung:** Für die Abrechnung des Abonnements der Praxis nutzen wir Stripe Payments Europe Ltd., Dublin (Irland). Stripe verarbeitet nur Rechnungs- und Zahlungsdaten der Praxis, **keine Patientendaten**, und handelt dabei als eigenständig Verantwortlicher – das ist **keine Auftragsverarbeitung** (siehe [Datenschutzerklärung](/datenschutz), Abschnitt 5).

## 2. Dienste, die die Praxis selbst aktiviert

Die folgenden Schnittstellen sind in PodoHero vorbereitet. Sie sind standardmäßig im **Testmodus** (es werden keine Daten übertragen). Für den Echtbetrieb schließt die Praxis einen eigenen Vertrag mit dem jeweiligen Anbieter; diese Anbieter sind dann **nicht** Unterauftragnehmer des Betreibers.

| Dienst | Zweck | Standort | Hinweis |
|---|---|---|---|
| lexoffice / Lexware | Buchhaltung (Belege) | DE | keine Gesundheitsdaten übertragen |
| SumUp | Kartenzahlung, Zahlungslinks | EU | nur Betrag und Referenz |
| Doctolib | Online-Termine | EU/DE | CSV-Import; Partner-API beantragt |
| Google Business Profile | Bewertungen lesen und beantworten | USA (Data Privacy Framework) | keine Gesundheitsdaten in Antworten |
| WhatsApp Business (über einen Business Solution Provider) | organisatorische Nachrichten | EU/USA | nur mit Einwilligung, keine Befunde; AVV mit dem Anbieter |
| SMS-Anbieter | Terminerinnerungen | DE | AVV mit dem Anbieter |
| KI/LLM (EU-Anbieter) | Sprachbericht strukturieren, Antwortvorschläge | EU | **nur mit AVV und Zero Data Retention**; vorher technisch gesperrt |
| Transkription | Sprachbericht | EU oder selbst gehostet | **nur mit AVV**; vorher technisch gesperrt |
| KI-Telefon | Anrufannahme | je nach gewähltem Anbieter (vor Aktivierung prüfen) | Pilot; Hinweis auf KI zu Beginn des Gesprächs (AI Act) |
| Abrechnungszentrum (GKV) | Übermittlung nach § 302 SGB V | DE | Export als CSV, Vertrag der Praxis mit dem Zentrum |

**Adress-Vorschläge (Photon, Komoot GmbH, OpenStreetMap-Daten, EU – `photon.komoot.io`):** Wird nur genutzt, solange die Funktion eingeschaltet ist (Betreiber-Einstellung `ADDRESS_PROVIDER`, derzeit standardmäßig an; abschaltbar mit `ADDRESS_PROVIDER=off` oder durch eine selbst gehostete Instanz über `PHOTON_URL`, dann ohne Dritte). Übertragen wird nur der eingetippte Adresstext bzw. die PLZ – keine Namen, keine Gesundheitsdaten, keine Client-IP. Öffentlicher Dienst ohne AVV.

## 3. Änderungen

Über beabsichtigte Änderungen an Abschnitt 1 informieren wir die Praxen mindestens vier Wochen im Voraus in Textform.
