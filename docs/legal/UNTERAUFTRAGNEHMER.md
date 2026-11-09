# Unterauftragnehmer und verbundene Dienste

> **Entwurf – vor Verwendung anwaltlich prüfen lassen.** Grundlage ist die interne Übersicht `docs/compliance/UNTERAUFTRAGNEHMER.md`. Konkrete Anbieter, Verträge und Standorte sind vom Betreiber vor dem Echtbetrieb einzutragen und zu prüfen.
>
> Version 0.1 · Stand 08.11.2026

## 1. Unterauftragnehmer des Betreibers

Diese Dienstleister setzen wir selbst ein, um PodoHero zu betreiben. Sie verarbeiten Daten nur nach unserer Weisung, mit Auftragsverarbeitungsvertrag und Verpflichtung auf die Verschwiegenheit nach § 203 StGB (siehe [AVV](/avv) § 6).

| Dienst | Zweck | Standort | Daten | Status |
|---|---|---|---|---|
| [HOSTER] | Server, Datenbank, verschlüsselte Dateiablage, Datensicherung | Deutschland | alle Praxisdaten (Fotos und Dokumente verschlüsselt) | AVV und § 203-Verpflichtung **abzuschließen** |
| [BACKUP-SPEICHERORT] | zweite Kopie der verschlüsselten Datensicherung | Deutschland | verschlüsselte Sicherungen | **einzurichten** |
| [ZAHLUNGSDIENSTLEISTER, z. B. STRIPE] | Abrechnung des Abonnements der Praxis | [STANDORT] | Rechnungs- und Zahlungsdaten der Praxis, **keine Patientendaten** | vorgesehen |
| [E-MAIL-VERSAND] | Versand von System-E-Mails (z. B. Rechnungen, Erinnerungen) | [STANDORT] | Empfängeradresse, Inhalt der Nachricht | vorgesehen, AVV **abzuschließen** |

## 2. Dienste, die die Praxis selbst verbindet

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
| KI-Telefon | Anrufannahme | [STANDORT PRÜFEN] | Pilot; Hinweis auf KI zu Beginn des Gesprächs (AI Act) |
| Abrechnungszentrum (GKV) | Übermittlung nach § 302 SGB V | DE | Export als CSV, Vertrag der Praxis mit dem Zentrum |

## 3. Änderungen

Über beabsichtigte Änderungen an Abschnitt 1 informieren wir die Praxen mindestens vier Wochen im Voraus in Textform.
