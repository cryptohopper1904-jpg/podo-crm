/**
 * Hilfe-Texte des Übernahme-Assistenten: Wo finde ich den Export in meiner bisherigen Software, was fehlt darin und
 * wie komme ich daran? Eigene Formulierungen auf Grundlage der Exportanalysen (Stand 11/2026), keine Texte oder
 * Bilder der Hersteller. Menüs können sich beim Hersteller ändern. Anrede „du“ wie im Rest der App.
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
  `Was der Export nicht enthält, kannst du ${where} als vollständige Datenkopie anfordern. Als Verantwortliche kannst du das jederzeit anweisen; spätestens bei Vertragsende muss der Anbieter dir die Daten nach deiner Wahl zurückgeben (Art. 28 Abs. 3 lit. a und g DSGVO, Auftragsverarbeitungsvertrag).`;

/** Aufbewahrung (Recht B2, Runde 2 B1) – in der Hilfe für alle Quellen und auf dem Ergebnis-Bildschirm */
export const RETENTION_HINT =
  "Rechnungen aus Online-Software (z. B. Tinana) legt PodoHero nur als PDF-Kopie bei der Patient:in ab – nicht als PodoHero-Rechnung, Zahlung oder Kassenbuchung. " +
  "Rechnungen aus dem Excel-Rechnungsmanager übernimmt PodoHero mit ihrer bisherigen Nummer als ausgestellte bzw. bezahlte Rechnungen, damit deine Nummernkreise lückenlos weiterlaufen. " +
  "Übertrage diese Rechnungen nicht noch einmal in deine Buchhaltung (z. B. Lexoffice), wenn sie dort schon erfasst sind. " +
  "In beiden Fällen ersetzen übernommene Rechnungen nicht deine Originalunterlagen: Bewahre den vollständigen Export deiner bisherigen Software bzw. deine Excel-Datei " +
  "(Rechnungen, Kassenbuch, Behandlungsdokumentation) selbst auf, möglichst im Originalformat, solange die Aufbewahrungsfristen laufen – in der Regel 8 Jahre für Rechnungen " +
  "und Buchungsbelege, 10 Jahre für Kassenbuch und andere Bücher (jeweils ab Ende des Kalenderjahres) und 10 Jahre nach Abschluss der Behandlung für die " +
  "Behandlungsdokumentation. Lass dir alle Daten vor der Kündigung vollständig geben und kündige deine bisherige Software erst, wenn du alles hast.";

/** Übernommene Zahlungen aus dem Excel-Rechnungsmanager (Buchhaltung K3) – Import-Seite und Vorschau */
export const EXCEL_PAYMENTS_HINT =
  "Übernommene Zahlungen werden nur an der Rechnung vermerkt. Sie erscheinen nicht in der Kasse, im Tagesabschluss oder im DSFinV-K-Export – sie sind im Kassenbuch deines bisherigen Systems erfasst.";

/** Wiederholter Upload nach vollständiger Löschung (Code-Review Runde 2) */
export const REUPLOAD_HINT =
  "Ein erneuter Upload legt nichts doppelt an. Ausnahme: Patient:innen, die du in PodoHero vollständig gelöscht hast (nicht nur ihre Kontaktdaten), kennt PodoHero nicht mehr – sie würden bei einem erneuten Upload derselben Exportdatei wieder angelegt.";

/** Einwilligungen (Recht, Empfehlung) – in der Hilfe für alle Quellen und auf dem Ergebnis-Bildschirm */
export const CONSENT_HINT =
  "Einwilligungen (z. B. Terminerinnerungen per SMS/E-Mail, Newsletter, Fotos) übernehmen wir aus keinem Fremdsystem, weil ihr Nachweis dort bleibt. " +
  "Hol sie in PodoHero neu ein; bis dahin verschickt PodoHero an neu übernommene Patient:innen keine Erinnerungen. Bei Personen, die schon in PodoHero geführt werden, gelten deren bisherige Einwilligungen in PodoHero weiter.";

export const SOURCE_HELP: SourceHelp[] = [
  {
    id: "tinana",
    title: "Tinana",
    online: true,
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
      "Rechnungs-PDFs werden nur Personen aus der mit hochgeladenen Patientendatei zugeordnet. Lade die Patientendatei deshalb immer mit hoch.",
    ],
    tips: [dataCopyHint("beim Tinana-Support")],
  },
  {
    id: "pododesk",
    title: "Pododesk",
    online: true,
    steps: [
      "Gesamtexport der Praxisdaten (nur Inhaber:in): Im Startbereich die Praxis betreten bzw. mit der Maus auf die Praxiskachel zeigen → Symbol „Praxisdaten exportieren“ (Wolke) → „Export anfordern“. Den Download-Link schickt Pododesk per E-Mail an die Inhaber:in; er gilt 72 Stunden – lade das ZIP rechtzeitig herunter.",
      "Lade das ZIP unverändert hier hoch (oder die sechs CSV-Dateien einzeln): patienten.csv, termine.csv, leistungenPrivat.csv, aerzte.csv, users.csv und praxisstammdaten.csv. Der Assistent erkennt jede Datei an ihrer Kopfzeile. Lade patienten.csv und termine.csv immer gemeinsam hoch: Termine werden nur Personen aus der mitgeladenen patienten.csv zugeordnet. Steht eine Pododesk-ID schon bei einer Person in PodoHero, wird sie nur bei gleichem Namen und Geburtsdatum automatisch zugeordnet; andernfalls entscheidest du in der Vorschau (voreingestellt: nicht verknüpfen). Mehrere Pododesk-Praxen in einem PodoHero-Konto werden derzeit nicht unterstützt – bitte wende dich an den Support.",
      "Übernommen werden Patient:innen (mit Pododesk-ID, ohne Einwilligungen), deine privaten Leistungen (vorhandene Kürzel bleiben unverändert – auch archivierte Leistungen in PodoHero werden nur zugeordnet, nicht wieder aktiviert; in Pododesk gelöschte Leistungen werden nicht angelegt) und Termine. Haus- und Fachärzt:innen werden als Namen bei der Patient:in eingetragen. Mitarbeitende werden nur über den Namen deinem Team zugeordnet – leg das Team vorher unter Einstellungen → Team an. Aus den Praxisstammdaten zeigt die Vorschau nur Vorschläge (z. B. Terminraster); Bankverbindung und Zugangsdaten werden nicht gelesen.",
      "Kassenbuch (getrennter Export): „Berichte“ → „Kassenbuch“ → „als CSV herunterladen“ → Zeitraum wählen (z. B. das ganze Jahr) → herunterladen.",
      "Stand: Format nach einem echten Pododesk-Export vom November 2026.",
    ],
    missing: [
      "Rechnungen und Zahlungen: Pododesk erstellt Rechnungen in der Regel über die sevdesk-Anbindung, sie sind daher nicht im Pododesk-Export. Exportiere Rechnungsliste und Belege in sevdesk und bewahre sie dort bzw. selbst auf.",
      "Behandlungsdokumentation, Anamnese/Befund, Fotos, Therapieberichte und Verordnungen (HVO) sind nicht im Gesamtexport. Kassenleistungen an Terminen stehen dort nur als Verweis ohne Preis – PodoHero vermerkt sie in der Terminnotiz.",
      "Produktverkäufe an Terminen, organisatorische Termine (z. B. Besprechungen), Terminfarben und die Online-Buchbarkeit der Leistungen werden nicht übernommen. Vergangene Termine werden als erledigt übernommen, weil Pododesk nicht exportiert, ob jemand nicht erschienen ist.",
      "Das Kassenbuch wird nicht nachgebucht (Kassensicherung, GoBD). PodoHero zeigt dir den letzten Kassenbestand – trag ihn unter „Kasse“ als Anfangsbestand ein und bewahre den Export selbst auf.",
    ],
    tips: [dataCopyHint("beim Pododesk-Support")],
  },
  {
    id: "doctolib",
    title: "Doctolib",
    online: true,
    steps: ["Die Patientenliste aus Doctolib als CSV herunterladen (falls dein Konto keinen Export anbietet: beim Doctolib-Support anfordern) und hier hochladen."],
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
  "Du bist für die Daten deiner Patient:innen verantwortlich, deine bisherige Online-Software verarbeitet sie in deinem Auftrag. " +
  "Du kannst jederzeit eine vollständige Kopie anweisen; bei Vertragsende muss sie die Daten nach deiner Wahl zurückgeben oder löschen (Art. 28 Abs. 3 lit. a und g DSGVO) – wähle die Rückgabe. " +
  "Schreib dazu formlos an den Support: „Bitte stellen Sie mir alle Daten meiner Praxis einschließlich Dokumenten, Fotos und Dokumentation in einem gängigen, " +
  "maschinenlesbaren Format bereit (z. B. CSV und PDF).“";
