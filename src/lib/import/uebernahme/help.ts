/**
 * Hilfe-Texte des Übernahme-Assistenten: Wo finde ich den Export in meiner bisherigen Software, was fehlt darin und
 * wie komme ich daran? Eigene Formulierungen auf Grundlage der Exportanalysen (Stand 11/2026), keine Texte oder
 * Bilder der Hersteller. Menüs können sich beim Hersteller ändern.
 */
export interface SourceHelp {
  id: string;
  title: string;
  steps: string[];
  missing: string[];
  tips: string[];
}

export const SOURCE_HELP: SourceHelp[] = [
  {
    id: "tinana",
    title: "Tinana",
    steps: [
      "Unten links auf das Zahnrad (Einstellungen) → „Allgemein“ → „Datenexport“.",
      "Nacheinander die Datentypen „Patienten“, „Termine“, „Verordnungen“, „Ärzte“ und „Rechnungen“ als CSV herunterladen („CSV“ und „Excel (CSV)“ sind gleich).",
      "Für die Rechnungs-PDFs bei „Rechnungen“ das Format „Rechnungs-PDFs (ZIP)“ wählen. Große Praxen: den Zeitraum z. B. je Jahr einschränken, damit jede ZIP-Datei unter 20 MB bleibt.",
      "Der Export gilt nur für den gerade aktiven Standort. Bei mehreren Standorten oben rechts den Standort wechseln und alles je Standort exportieren – du kannst alle Dateien zusammen hochladen.",
      "Berichte (Umsatz, Mitarbeiter, Heilmittel, Verordnungsbericht) sind Auswertungen und werden nicht übernommen.",
    ],
    missing: [
      "Versicherungsdetails stehen nur an den Verordnungen – PodoHero übernimmt Kasse und Versichertennummer aus der jüngsten Verordnung.",
      "Dokumente, Fotos, Anhänge der Behandlungsdokumentation, Kontakte (z. B. Pflegeheim), Zuzahlungsbefreiungen, eigene Felder, Produkte und das Kassenbuch sind nicht im Export.",
      "Der Bearbeitungsstand der Verordnungen (offen/abgerechnet) fehlt – deshalb fragt der Assistent, wie übernommene Verordnungen markiert werden sollen.",
      "Einwilligungen (z. B. Erinnerungen per E-Mail/SMS) werden nicht übernommen und müssen neu eingeholt werden.",
    ],
    tips: [
      "Was der Self-Service-Export nicht enthält, kannst du beim Tinana-Support als vollständige Datenkopie anfordern (Datenübertragbarkeit, Art. 20 DSGVO, und Rückgabe der Daten durch den Auftragsverarbeiter, Art. 28 Abs. 3 lit. g DSGVO).",
    ],
  },
  {
    id: "pododesk",
    title: "Pododesk",
    steps: [
      "Kassenbuch: „Berichte“ → „Kassenbuch“ → „als CSV herunterladen“ → Zeitraum wählen (z. B. das ganze Jahr) → herunterladen.",
      "Gesamtexport der Praxisdaten: im Startbereich mit der Maus auf die Praxiskachel → Wolken-Symbol „Praxisdaten exportieren“ → „Export anfordern“. Der Link kommt per E-Mail an die Inhaber:in und gilt 72 Stunden – rechtzeitig herunterladen.",
    ],
    missing: [
      "Das Kassenbuch wird nicht nachgebucht (Kassensicherung, GoBD). PodoHero zeigt dir den letzten Kassenbestand – trage ihn unter „Kasse“ als Anfangsbestand ein und bewahre den Export selbst auf.",
      "Die Patientendatei aus dem Gesamtexport erkennt der Assistent noch nicht automatisch, weil uns noch kein echter Export vorliegt. Sie wird als „nicht erkannt“ angezeigt; es wird nichts verändert.",
      "Rechnungen liegen bei Pododesk in sevdesk und sind nicht im Pododesk-Export.",
    ],
    tips: [
      "Fehlen Anamnese, Dokumentation, Verordnungen oder Fotos im Export, fordere sie bei der Hellmut Ruck GmbH als vollständige Datenkopie an (Art. 20 DSGVO bzw. Rückgabe durch den Auftragsverarbeiter, Art. 28 Abs. 3 lit. g DSGVO).",
    ],
  },
  {
    id: "doctolib",
    title: "Doctolib",
    steps: ["Die Patientenliste aus Doctolib als CSV herunterladen (falls dein Konto keinen Export anbietet: beim Doctolib-Support anfordern) und hier hochladen."],
    missing: ["Der Doctolib-Export enthält nur Patient:innen. Termine kommen über das Kalender-Abo (Einstellungen → Kalender-Abo)."],
    tips: [],
  },
  {
    id: "excel",
    title: "Excel „Podologie Rechnungsmanager“",
    steps: ["Die Excel-Datei (.xlsx) direkt hochladen – Patienten, Leistungen, Gutscheine, Rechnungen und Fixkosten werden wie beim bisherigen Excel-Import übernommen."],
    missing: [],
    tips: ["Bereits übernommene Patient:innen (gleiche ID aus der Tabelle) und Rechnungsnummern werden beim erneuten Hochladen übersprungen."],
  },
];

export const DSGVO_HINT =
  "Du bist für die Daten deiner Patient:innen verantwortlich, deine bisherige Software verarbeitet sie in deinem Auftrag. " +
  "Bei Vertragsende muss sie dir alle Daten zurückgeben (Art. 28 Abs. 3 lit. g DSGVO). Schreib dazu formlos an den Support: " +
  "„Bitte stellt mir alle Daten meiner Praxis einschließlich Dokumenten, Fotos und Dokumentation in einem gängigen, " +
  "maschinenlesbaren Format bereit (z. B. CSV und PDF).“";
