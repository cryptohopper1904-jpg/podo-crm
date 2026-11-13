/**
 * Vergleichsseiten (/vergleich) – vergleichende Werbung nach § 6 UWG:
 *  - nur objektiv nachprüfbare, wesentliche und typische Eigenschaften,
 *  - jede Angabe zum Anbieter mit Quelle (öffentliche Herstellerwebsite) und Stand,
 *  - keine Herabsetzung, keine Logos – Produktnamen nur zur Identifikation,
 *  - was auf den genannten Seiten nicht steht, heißt „nicht angegeben“ (nicht „nein“).
 * Aufgenommen sind nur Anbieter, deren Website Podologie ausdrücklich als Zielgruppe nennt.
 * Vor jeder Änderung die Quellen erneut aufrufen und STAND anpassen.
 */
export const COMPARISON_STAND = "November 2026";
/** Tag des Abrufs der Herstellerseiten */
export const COMPARISON_RETRIEVED = "13.11.2026";

export type Source = { label: string; url: string };

export type CompareRow = {
  topic: string;
  podo: string;
  /** Angabe laut Herstellerwebsite; null = auf den genannten Seiten nicht angegeben */
  vendor: string | null;
  /** Index/Indizes in sources */
  source?: number | number[];
};

export type Competitor = {
  slug: string;
  name: string;
  vendor: string;
  /** Kurzbeschreibung laut Hersteller (sachlich, mit Quelle) */
  summary: string;
  sources: Source[];
  rows: CompareRow[];
  /** Wofür sich der Anbieter laut eigener Darstellung besonders eignet – fair und sachlich */
  strengths: string[];
  /** Was PodoHero (Stand heute) anders macht */
  podoDifferent: string[];
};

/** PodoHero-Werte (nur, was laut docs/STATUS.md eingebaut ist) – für alle Vergleiche gleich */
export const PODO = {
  audience: "nur Podologie",
  deployment: "im Browser, für iPad und iPhone optimiert; keine Installation",
  hosting: "Hetzner, Deutschland",
  footDoc: "Fußschema 2D und 3D-Fußmodell, Fotos direkt aus der Kamera (verschlüsselt)",
  booking: "eigene Online-Buchung; Patientenportal zum Buchen, Verschieben, Absagen (ab Tarif Praxis)",
  gkv: "Verordnungen mit Fristen-Ampel; Abrechnung per Export an ein Abrechnungszentrum (keine Direktabrechnung)",
  ti: "KIM-Postfach vorbereitet; Echtbetrieb mit eigenen TI-Komponenten (SMC-B, Konnektor, KIM-Anbieter)",
  invoices: "Rechnung, Quittung, Sammelrechnung, Gutscheine, USt-Prüfung nach § 4 Nr. 14 UStG",
  kasse: "Kassenbuch, Zählprotokoll, Z-Bon, DSFinV-K-Export; TSE über fiskaly im Testmodus",
  hygiene: "Sterilgut-Chargen mit Freigabe und Rückverfolgung, Gerätebuch, Tages-Checkliste",
  carehome: "Pflegeheim-Modus mit Besuchstag, Schnell-Doku und Sammelrechnung; Tourenplanung",
  free: "kostenloser Tarif: 1 Behandler:in, bis 20 Patient:innen, ohne Zeitlimit (eingeschränkter Funktionsumfang, siehe „Preise“)",
  trial: "30 Tage kostenlos, endet automatisch, keine Zahlungsdaten nötig",
} as const;

export const COMPETITORS: Competitor[] = [
  {
    slug: "pododesk",
    name: "pododesk",
    vendor: "pododesk",
    summary: "Laut Herstellerwebsite eine spezialisierte Praxissoftware für Podolog:innen und medizinische Fußpfleger:innen, nutzbar im Browser.",
    sources: [
      { label: "pododesk.de – Startseite", url: "https://pododesk.de/" },
      { label: "pododesk.de – Planmodelle", url: "https://pododesk.de/planmodelle/" },
      { label: "pododesk.de – Funktionen", url: "https://pododesk.de/funktionen/" },
    ],
    rows: [
      { topic: "Zielgruppe", podo: PODO.audience, vendor: "Podolog:innen und medizinische Fußpfleger:innen", source: 0 },
      { topic: "Nutzung", podo: PODO.deployment, vendor: "im Browser ohne Installation; genannt werden iOS, macOS und Windows", source: 0 },
      { topic: "Serverstandort", podo: PODO.hosting, vendor: "Serverstandorte in der EU", source: 0 },
      { topic: "Fußdokumentation", podo: PODO.footDoc, vendor: "3D-Fuß-Dokumentation mit 98 Koordinatenpunkten, Fotos je Punkt", source: 0 },
      { topic: "Online-Termine", podo: PODO.booking, vendor: "Online-Terminbuchung: Patient:innen können „Termine rund um die Uhr online anfragen“; die Funktion „verbindet Ihren pododesk-Praxiskalender direkt mit einer Online-Buchung“", source: [0, 2] },
      { topic: "Kassenabrechnung (GKV)", podo: PODO.gkv, vendor: "Kassenabrechnung mit HVO-Check; „Pro Abrechnung fällt lediglich eine geringe Gebühr (ab 0,95 %) an.“ Krankenkassen-Schnittstelle ab Plan „small“ enthalten", source: [0, 1] },
      { topic: "Telematikinfrastruktur / KIM", podo: PODO.ti, vendor: "„Jetzt buchbar: Ihr TI-Zugang mit pododesk“; genannt werden ePA, eRezept und KIM", source: 0 },
      { topic: "Private Rechnungen", podo: PODO.invoices, vendor: "Rechnungsstellung; Anbindung an externe Buchhaltung (z. B. sevdesk)", source: 0 },
      { topic: "Kasse", podo: PODO.kasse, vendor: "Kassenbuch und Kassenbericht inkl. Zählprotokoll; TSE nicht angegeben", source: 2 },
      { topic: "Hygiene", podo: PODO.hygiene, vendor: "Chargennummer der Sterilisation in der Behandlungsdoku; eigenes Hygienemodul nicht angegeben", source: 2 },
      { topic: "Pflegeheime / Hausbesuche", podo: PODO.carehome, vendor: "Hausbesuchspauschalen und Fahrstrecke in der Abrechnung genannt; Pflegeheim-Funktionen nicht angegeben", source: 2 },
      { topic: "Patientenportal", podo: "Termine, offene Rechnungen als PDF, Gutscheine (ab Tarif Praxis)", vendor: null },
      { topic: "Kostenloser Einstieg", podo: PODO.free, vendor: "Plan „free“: bis 20 Patient:innen, 1 Praxis", source: 1 },
    ],
    strengths: [
      "Laut Herstellerwebsite: Kassenabrechnung und TI-Anbindung aus einer Hand.",
      "Laut Herstellerwebsite: 3D-Fußdokumentation mit festen Koordinatenpunkten.",
    ],
    podoDifferent: [
      "Behandlungsalltag am iPad: Fotos direkt aus der Kamera, Fußschema in 2D oder 3D, unveränderbare Einträge mit Nachträgen.",
      "Selbstzahler und Patientenbindung: Patientenportal, Warteliste, Erinnerungen, Gutscheine, eigene Praxis-Website.",
      "Praxisbetrieb: Hygiene mit Sterilgut-Chargen und Gerätebuch, Pflegeheim-Modus mit Sammelrechnung, Touren und Kasse mit Z-Bon.",
      "GKV-Abrechnung bewusst über ein Abrechnungszentrum (Export) – keine Direktabrechnung.",
    ],
  },
  {
    slug: "tinana",
    name: "tinana",
    vendor: "tinana",
    summary: "Laut Herstellerwebsite eine cloudbasierte Praxissoftware für Heilmittelpraxen – Physiotherapie, Ergotherapie, Logopädie und Podologie – mit eigener Seite für Podologie.",
    sources: [
      { label: "tinana.de – Startseite", url: "https://www.tinana.de/" },
      { label: "tinana.de – Podologie", url: "https://www.tinana.de/fuer/podologie" },
      { label: "tinana.de – Preise", url: "https://www.tinana.de/preise" },
    ],
    rows: [
      { topic: "Zielgruppe", podo: PODO.audience, vendor: "Heilmittelpraxen: Physiotherapie, Ergotherapie, Logopädie, Podologie", source: 0 },
      { topic: "Nutzung", podo: PODO.deployment, vendor: "„100% Cloudbasiert“; mobile Ansicht für das Tablet am Behandlungsstuhl", source: [0, 1] },
      { topic: "Serverstandort", podo: PODO.hosting, vendor: "„Made & hosted in Germany“", source: 0 },
      { topic: "Dokumentation", podo: PODO.footDoc, vendor: "Befund, Wundverlauf, Maßnahmen; Vorlagen für DFS-Kontrollen; Fotodokumentation des Wundverlaufs", source: 1 },
      { topic: "Verordnungsprüfung", podo: "Fristen-Ampel (Behandlungsbeginn, Fristen), verbrauchte Einheiten, Zuzahlung", vendor: "prüft Diagnosegruppe, Heilmittel, Menge und Frequenz sowie Fristen", source: 1 },
      { topic: "Kassenabrechnung (GKV)", podo: PODO.gkv, vendor: "Abrechnung nach § 302 SGB V direkt mit den Krankenkassen, „ohne Rechenzentrum, ohne prozentuale Gebühren“", source: 1 },
      { topic: "Telematikinfrastruktur / KIM", podo: PODO.ti, vendor: "KIM-Postfach und Verzeichnisdienst in der Software; TI-Anschluss über einen TI-Anbieter", source: 0 },
      { topic: "KI-Funktionen", podo: "Sprachbericht und Verordnung per Foto (Testmodus, Felder werden bestätigt)", vendor: "Therapieberichte mit KI", source: 0 },
      { topic: "Kasse", podo: PODO.kasse, vendor: "integriertes Kassensystem für Verkäufe an der Theke „mit Steuersatz & Beleg“; TSE nicht angegeben", source: 1 },
      { topic: "Hygiene", podo: PODO.hygiene, vendor: null },
      { topic: "Pflegeheime / Hausbesuche", podo: PODO.carehome, vendor: null },
      { topic: "Online-Buchung", podo: PODO.booking, vendor: "integrierte Online-Buchung: Patient:innen „reservieren … rund um die Uhr selbst“", source: 1 },
      { topic: "Patientenportal", podo: "Termine, offene Rechnungen als PDF, Gutscheine (ab Tarif Praxis)", vendor: null },
      { topic: "Test / kostenloser Einstieg", podo: `${PODO.trial}; ${PODO.free}`, vendor: "„14 Tage gratis. Keine Kreditkarte. Monatlich kündbar.“", source: 2 },
    ],
    strengths: [
      "Laut Herstellerwebsite: GKV-Abrechnung nach § 302 SGB V direkt mit den Krankenkassen.",
      "Laut Herstellerwebsite: eine Software für mehrere Heilmittel-Berufe und Standorte.",
    ],
    podoDifferent: [
      "Ausschließlich für Podologie gebaut: Fußschema in 2D und 3D, Nagelspangen-Episoden mit Pflichtfoto-Assistent, Risiko-Ampel.",
      "Pflegeheim-Modus, Tourenplanung mit Fahrtenbuch-Hilfe und Hygiene mit Sterilgut-Rückverfolgung sind eingebaut.",
      "Selbstzahler-Funktionen: Gutscheine, Patientenportal, Praxis-Website.",
      "GKV-Abrechnung über ein Abrechnungszentrum per Export statt Direktabrechnung.",
    ],
  },
  {
    slug: "buchnerflow",
    name: "buchnerFLOW",
    vendor: "Buchner & Partner GmbH",
    summary: "Laut Herstellerwebsite eine Software für Praxen der Physiotherapie, Ergotherapie, Logopädie und Podologie mit Terminplanung, Dokumentation und Abrechnung.",
    sources: [
      { label: "buchner.de – buchnerFLOW", url: "https://www.buchner.de/buchnerflow/" },
      { label: "buchner.de – Startseite", url: "https://www.buchner.de/" },
    ],
    rows: [
      { topic: "Zielgruppe", podo: PODO.audience, vendor: "Praxen der Physiotherapie, Ergotherapie, Logopädie und Podologie", source: 0 },
      { topic: "Nutzung", podo: PODO.deployment, vendor: "„für die mobile Nutzung optimiert“, Bedienung an Handy, Tablet oder PC", source: 0 },
      { topic: "Serverstandort", podo: PODO.hosting, vendor: null },
      { topic: "Termine", podo: "Tages- und Wochenansicht, Serientermine, Hausbesuche, Warteliste", vendor: "automatische Terminplanung", source: 0 },
      { topic: "Dokumentation", podo: PODO.footDoc, vendor: "strukturierte Dokumentation, unterstützt durch KI; Therapieberichte mit KI-Assistent", source: 0 },
      { topic: "Abrechnung", podo: PODO.gkv, vendor: "digitale Abrechnung mit allen Kostenträgern, automatische Verordnungsprüfung", source: 0 },
      { topic: "Telematikinfrastruktur", podo: PODO.ti, vendor: "Anbindung über buchnerTI", source: 1 },
      { topic: "Online-Buchung / Patientenportal", podo: PODO.booking, vendor: null },
      { topic: "Kasse", podo: PODO.kasse, vendor: null },
      { topic: "Hygiene", podo: PODO.hygiene, vendor: null },
      { topic: "Pflegeheime / Hausbesuche", podo: PODO.carehome, vendor: "für die mobile Nutzung optimiert und laut Hersteller für Hausbesuche geeignet; Pflegeheim-Funktionen nicht angegeben", source: 0 },
      { topic: "Test / Demo", podo: `${PODO.trial}; ${PODO.free}`, vendor: "Klick-Demo auf der Website; Termin für eine Softwareberatung vereinbar", source: 0 },
    ],
    strengths: [
      "Laut Herstellerwebsite: Abrechnung mit allen Kostenträgern und automatische Verordnungsprüfung.",
      "Laut Herstellerwebsite: TI-Anbindung aus demselben Haus (buchnerTI).",
    ],
    podoDifferent: [
      "Ausschließlich für Podologie gebaut – mit Fußschema in 2D und 3D und Fotos direkt am iPad.",
      "Kostenloser Tarif (eingeschränkter Funktionsumfang) und 30 Tage Test ohne Zahlungsdaten.",
      "Patientenportal, Online-Buchung, Praxis-Website, Hygiene, Pflegeheim-Modus und Kasse sind eingebaut.",
      "GKV-Abrechnung über ein Abrechnungszentrum per Export statt Direktabrechnung.",
    ],
  },
];

export const competitorBySlug = (slug: string) => COMPETITORS.find((c) => c.slug === slug);
