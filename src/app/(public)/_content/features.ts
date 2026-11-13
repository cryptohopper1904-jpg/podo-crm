/**
 * Funktionsbeschreibung für die Website – nur, was laut docs/STATUS.md tatsächlich umgesetzt ist.
 * status: "live" = nutzbar; "test" = eingebaut, externe Anbindung im Testmodus (Vertrag/AVV nötig);
 * "planned" = noch nicht verfügbar (ehrlich gekennzeichnet).
 */
export type FeatureStatus = "live" | "test" | "planned";

export type FeatureGroup = {
  id: string;
  title: string;
  lead: string;
  items: { text: string; status?: FeatureStatus }[];
};

export const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    id: "akte",
    title: "Patientenakte & CRM",
    lead: "Alles zu einer Person an einem Ort – mit Risiken immer im Blick.",
    items: [
      { text: "Stammdaten, Versicherung, abweichender Rechnungsempfänger (Angehörige, Betreuer, Pflegeheim)" },
      { text: "Risiko-Ampel: Diabetes, Blutverdünner, pAVK, Neuropathie, MRSA, Allergien" },
      { text: "Status Neu / Aktiv / Überfällig / Inaktiv nach Wunsch-Intervall" },
      { text: "Zeitleiste mit Terminen, Doku, Fotos und Rechnungen, Dubletten-Prüfung" },
      { text: "Versionierte Einwilligungen, Auskunft nach Art. 15 DSGVO als Datei" },
    ],
  },
  {
    id: "doku",
    title: "Behandlungsdoku am iPad und iPhone",
    lead: "Für den Behandlungsstuhl gebaut: große Touch-Ziele, wenige Schritte.",
    items: [
      { text: "Leistungen antippen, Fußschema mit Markierungen, Sterilgut-Charge per Barcode" },
      { text: "Befunde wahlweise im 2D-Schema oder am interaktiven 3D-Fußmodell markieren" },
      { text: "Fotos direkt aus der Kamera – verschlüsselt gespeichert, nie in der Mediathek" },
      { text: "Nagelspangen-Episoden mit Pflichtfoto-Assistent (fehlendes Foto nur mit Begründung)" },
      { text: "Unveränderbare Einträge (§ 630f BGB), Korrekturen als Nachtrag, Gegenzeichnung für Azubis" },
      { text: "Strukturierte Anamnese mit IWGDF-Risikoklasse, Online-Anamnese per Einmal-Link" },
      { text: "Sprachbericht: Diktat wird transkribiert und in Felder sortiert", status: "test" },
    ],
  },
  {
    id: "termine",
    title: "Termine & Online-Buchung",
    lead: "Kalender, der Leistungsdauer, Feiertage und Abwesenheiten kennt.",
    items: [
      { text: "Tages- und Wochenansicht, Serientermine, Hausbesuche, Doppelbuchungsprüfung" },
      { text: "Feiertage je Bundesland, Warnung bei Terminen in Urlaub oder Krankheit" },
      { text: "Eigene Buchungsseite für Selbstzahler-Termine und eigene Praxis-Website" },
      { text: "Patientenportal: Patient:innen buchen selbst und verschieben bis 24 h vorher" },
      { text: "Warteliste: Bei einer Absage bekommen passende Personen einen Link – wer zuerst annimmt, rückt nach (nur mit Einwilligung)" },
      { text: "Kalender-Feed (iCal) ohne Patientennamen" },
      { text: "Doctolib: CSV-Import und Auswertung von Bestätigungsmails", status: "test" },
      { text: "Kalender-Abo: Doctolib-Termine über Google Kalender (Docal.io/CalMedi) alle 5 Minuten übernehmen – nur lesend, nie automatisch zugeordnet", status: "test" },
    ],
  },
  {
    id: "verordnungen",
    title: "Verordnungen (GKV)",
    lead: "Fristen, Frequenz und Einheiten im Griff – bis zur Abrechnungsreife.",
    items: [
      { text: "Erfassung mit Positionen und Foto der Papierverordnung" },
      { text: "Ampeln für Behandlungsbeginn und Fristen, verbrauchte Einheiten, Zuzahlung" },
      { text: "Abrechnungslauf mit Export für ein Abrechnungszentrum (die Übermittlung nach § 302 SGB V übernimmt der Partner)" },
      { text: "Verordnung per Foto auslesen: jedes Feld wird angezeigt und erst nach Bestätigung übernommen", status: "test" },
      { text: "KIM-Postfach und Import der eVerordnung vorbereitet – Echtbetrieb braucht die TI-Komponenten (SMC-B, Konnektor, KIM-Anbieter)", status: "test" },
    ],
  },
  {
    id: "rechnungen",
    title: "Rechnungen, Kasse & Gutscheine",
    lead: "Lückenlose Nummernkreise und klare Umsatzsteuer-Logik.",
    items: [
      { text: "Rechnung, Quittung, Sammelrechnung, Ausfallhonorar, Storno – unveränderbar nach Ausstellung" },
      { text: "USt-Logik inkl. § 4 Nr. 14 UStG (mit Bestätigung) und Kleinunternehmerregelung" },
      { text: "Mischzahlung, Gutscheine mit Restwert, PDF-Rechnungen" },
      { text: "SumUp-Kartenterminal und Zahlungslink direkt aus der Rechnung", status: "test" },
      { text: "Kasse: Kassenbuch, Zählprotokoll, lückenlos nummerierter Tagesabschluss (Z-Bon), DSFinV-K-Export" },
      { text: "TSE-Signatur für jeden Kassenvorgang über fiskaly", status: "test" },
      { text: "Belege an lexoffice übertragen", status: "test" },
    ],
  },
  {
    id: "kommunikation",
    title: "Kommunikation & Erinnerungen",
    lead: "Weniger Ausfälle, mehr wiederkehrende Patient:innen – nur mit Einwilligung.",
    items: [
      { text: "Automatische Erinnerung 24 h vorher, Rückholung bei Überfälligkeit, Spangen-Kontrolle – ohne Doppelversand", status: "test" },
      { text: "Patientenportal: Termine, offene Rechnungen als PDF, Gutscheine, Buchen und Verschieben" },
      { text: "Posteingang für E-Mail, WhatsApp und SMS mit KI-Antwortvorschlägen", status: "test" },
      { text: "SMS, E-Mail-Versand und WhatsApp (nur Organisatorisches)", status: "test" },
      { text: "Google-Bewertungen lesen und beantworten (ohne Gesundheitsdetails)", status: "test" },
      { text: "KI-Telefonassistent: nimmt Anrufe an, nennt freie Termine, legt Terminwünsche zur Bestätigung an und notiert Rückrufwünsche", status: "test" },
    ],
  },
  {
    id: "praxis",
    title: "Praxis, Hygiene & Team",
    lead: "Die Dinge, die sonst in Ordnern und Tabellen stecken.",
    items: [
      { text: "Pflegeheime: Bewohnerlisten, Besuchstag mit Schnell-Doku, Sammelrechnung je Monat" },
      { text: "Sterilgut-Chargen mit Freigabe, QR-Etiketten und Rückverfolgung" },
      { text: "Gerätebuch mit Wartungs-, Validierungs- und Prüffristen, Tages-Checkliste, Materialliste" },
      { text: "Arbeitszeiten und Abwesenheiten, Rollen: Inhaber:in, Podolog:in, Empfang, Azubi, Steuerberatung" },
      { text: "Auswertungen: Umsatz und Behandlungen je Monat, Fixkosten, Break-even" },
      { text: "Import aus Excel-Vorlage und Doctolib-CSV mit Prüfbericht" },
    ],
  },
];

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  live: "verfügbar",
  test: "Testmodus – Echtbetrieb mit eigenem Anbietervertrag",
  planned: "geplant",
};
