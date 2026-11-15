/**
 * Hilfe-Texte des Übernahme-Assistenten: Wo finde ich den Export in meiner bisherigen Software, was fehlt darin und
 * wie komme ich daran? Eigene Formulierungen auf Grundlage der Exportanalysen (Stand 11/2026), keine Texte oder
 * Bilder der Hersteller. Menüs können sich beim Hersteller ändern. Anrede „Sie“ wie im Rest der App.
 * Rechtstexte (Datenkopie, Aufbewahrung, Einwilligungen) nach Prüfung durch legal-compliance-checker – nur gemeinsam ändern.
 */
export interface SourceHelp {
  id: string;
  title: string;
  /** Online-Software (Auftragsverarbeitung) – nur dann gilt der Hinweis zur Datenkopie (Art. 28 DSGVO) */
  online: boolean;
  steps: string[];
  missing: string[];
  tips: string[];
}

/** Sichtbarer Stand der Anleitungen */
export const HELP_STAND = "Stand: November 2026, nach unseren Tests – Menüs und Exportinhalte können sich beim Hersteller ändern.";

/** Vollständige Datenkopie beim bisherigen Anbieter (Recht B1: kein Art. 20, sondern Weisung/Rückgabe nach Art. 28) */
export const dataCopyHint = (where: string) =>
  `Was der Export nicht enthält, können Sie ${where} als vollständige Datenkopie anfordern. Als Verantwortliche können Sie das jederzeit anweisen; spätestens bei Vertragsende muss der Anbieter Ihnen die Daten nach Ihrer Wahl zurückgeben (Art. 28 Abs. 3 lit. a und g DSGVO, Auftragsverarbeitungsvertrag).`;

/** Aufbewahrung (Recht B2) – in der Hilfe für alle Quellen und auf dem Ergebnis-Bildschirm */
export const RETENTION_HINT =
  "Übernommene Rechnungen sind in PodoHero nur Kopien zum Nachschlagen – sie werden nicht gebucht und ersetzen nicht die Originale. " +
  "Bewahren Sie den vollständigen Export Ihrer bisherigen Software (Rechnungen, Kassenbuch, Behandlungsdokumentation) selbst auf, solange die " +
  "Aufbewahrungsfristen laufen (Rechnungen/Buchungsbelege i. d. R. 8 Jahre, Behandlungsdokumentation 10 Jahre), oder lassen Sie ihn sich vor der " +
  "Kündigung vollständig geben. Kündigen Sie Ihre bisherige Software erst, wenn Sie alles haben.";

/** Einwilligungen (Recht, Empfehlung) – in der Hilfe für alle Quellen und auf dem Ergebnis-Bildschirm */
export const CONSENT_HINT =
  "Einwilligungen (z. B. Terminerinnerungen per SMS/E-Mail, Newsletter, Fotos) übernehmen wir aus keinem Fremdsystem, weil ihr Nachweis dort bleibt. " +
  "Holen Sie sie in PodoHero neu ein; bis dahin verschickt PodoHero an übernommene Patient:innen keine Erinnerungen.";

export const SOURCE_HELP: SourceHelp[] = [
  {
    id: "tinana",
    title: "Tinana",
    online: true,
    steps: [
      "Unten links auf das Zahnrad (Einstellungen) → „Allgemein“ → „Datenexport“.",
      "Nacheinander die Datentypen „Patienten“, „Termine“, „Verordnungen“, „Ärzte“ und „Rechnungen“ als CSV herunterladen („CSV“ und „Excel (CSV)“ sind gleich).",
      "Für die Rechnungs-PDFs bei „Rechnungen“ das Format „Rechnungs-PDFs (ZIP)“ wählen. Große Praxen: den Zeitraum z. B. je Jahr einschränken, damit jede ZIP-Datei unter 20 MB bleibt.",
      "Der Export gilt nur für den gerade aktiven Standort. Bei mehreren Standorten oben rechts den Standort wechseln und alles je Standort exportieren – Sie können alle Dateien zusammen hochladen.",
      "Berichte (Umsatz, Mitarbeiter, Heilmittel, Verordnungsbericht) sind Auswertungen und werden nicht übernommen.",
    ],
    missing: [
      "Versicherungsdetails stehen nur an den Verordnungen – PodoHero übernimmt Kasse und Versichertennummer aus der jüngsten Verordnung.",
      "Dokumente, Fotos, Anhänge der Behandlungsdokumentation, Kontakte (z. B. Pflegeheim), Zuzahlungsbefreiungen, eigene Felder, Produkte und das Kassenbuch sind nicht im Export.",
      "Der Bearbeitungsstand der Verordnungen (offen/abgerechnet) fehlt – deshalb fragt der Assistent, wie übernommene Verordnungen markiert werden sollen.",
      "Rechnungs-PDFs werden nur Personen aus der mit hochgeladenen Patientendatei zugeordnet. Laden Sie die Patientendatei deshalb immer mit hoch.",
    ],
    tips: [dataCopyHint("beim Tinana-Support")],
  },
  {
    id: "pododesk",
    title: "Pododesk",
    online: true,
    steps: [
      "Kassenbuch: „Berichte“ → „Kassenbuch“ → „als CSV herunterladen“ → Zeitraum wählen (z. B. das ganze Jahr) → herunterladen.",
      "Gesamtexport der Praxisdaten: im Startbereich mit der Maus auf die Praxiskachel → Wolken-Symbol „Praxisdaten exportieren“ → „Export anfordern“. Der Link kommt per E-Mail an die Inhaber:in und gilt 72 Stunden – laden Sie ihn rechtzeitig herunter.",
    ],
    missing: [
      "Das Kassenbuch wird nicht nachgebucht (Kassensicherung, GoBD). PodoHero zeigt Ihnen den letzten Kassenbestand – tragen Sie ihn unter „Kasse“ als Anfangsbestand ein und bewahren Sie den Export selbst auf.",
      "Die Patientendatei aus dem Gesamtexport erkennt der Assistent noch nicht automatisch, weil uns noch kein echter Export vorliegt. Sie wird als „nicht erkannt“ angezeigt; es wird nichts verändert.",
      "Rechnungen werden bei Pododesk in der Regel über die sevdesk-Anbindung erstellt und sind daher nicht im Pododesk-Export.",
    ],
    tips: [dataCopyHint("bei der Hellmut Ruck GmbH")],
  },
  {
    id: "doctolib",
    title: "Doctolib",
    online: true,
    steps: ["Die Patientenliste aus Doctolib als CSV herunterladen (falls Ihr Konto keinen Export anbietet: beim Doctolib-Support anfordern) und hier hochladen."],
    missing: [
      "Der Doctolib-Export enthält nur Patient:innen. Termine kommen über das Kalender-Abo (Einstellungen → Kalender-Abo).",
      "Geburtsname und Beruf werden nicht übernommen (nicht nötig für die Behandlung).",
    ],
    tips: [],
  },
  {
    id: "excel",
    title: "Excel „Podologie Rechnungsmanager“",
    online: false,
    steps: ["Die Excel-Datei (.xlsx) direkt hochladen – Patienten, Leistungen, Gutscheine, Rechnungen und Fixkosten werden wie beim bisherigen Excel-Import übernommen. Je Durchlauf eine Excel-Datei; Dateien mit Makros (.xlsm) bitte vorher als .xlsx speichern."],
    missing: [],
    tips: ["Bereits übernommene Patient:innen (gleiche ID aus der Tabelle, ohne ID: gleicher Name und gleiches Geburtsdatum) und Rechnungsnummern werden beim erneuten Hochladen übersprungen."],
  },
];

/** Nur für Online-Software (Auftragsverarbeitung), nicht für die eigene Excel-Datei */
export const DSGVO_HINT =
  "Sie sind für die Daten Ihrer Patient:innen verantwortlich, Ihre bisherige Online-Software verarbeitet sie in Ihrem Auftrag. " +
  "Sie können jederzeit eine vollständige Kopie verlangen; bei Vertragsende muss sie Ihnen die Daten nach Ihrer Wahl zurückgeben (Art. 28 Abs. 3 lit. g DSGVO). " +
  "Schreiben Sie dazu formlos an den Support: „Bitte stellen Sie mir alle Daten meiner Praxis einschließlich Dokumenten, Fotos und Dokumentation in einem gängigen, " +
  "maschinenlesbaren Format bereit (z. B. CSV und PDF).“";
