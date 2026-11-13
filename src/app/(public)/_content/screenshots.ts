/**
 * Echte Screenshots aus PodoHero (public/screenshots, WebP). Aufgenommen mit ERFUNDENEN Demodaten
 * (Personen, Adressen, Praxis „Podologie Muster“ in „Musterstadt“, E-Mails @example.org, keine echten Fotos).
 * Neu erzeugen: lokale Demo-Datenbank + Playwright, siehe Commit-Beschreibung.
 */
export type Screenshot = {
  src: string;
  /** Pendant im Dunkelmodus (gleiche Maße) */
  darkSrc?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  device: "desktop" | "ipad" | "phone";
};

const desktop = (name: string, alt: string, caption: string, dark?: string): Screenshot => ({
  src: `/screenshots/${name}.webp`,
  darkSrc: dark ? `/screenshots/${dark}.webp` : undefined,
  width: 1920,
  height: 1200,
  alt,
  caption,
  device: "desktop",
});
const ipad = (name: string, alt: string, caption: string): Screenshot => ({ src: `/screenshots/${name}.webp`, width: 1536, height: 1152, alt, caption, device: "ipad" });

export const SHOTS = {
  heute: desktop(
    "heute-tagesueberblick",
    "PodoHero-Startseite „Heute“: Kennzahlen zu Terminen, Tageseinnahmen, offenen Posten und Nachrichten, darunter die Termine des Tages und der Posteingang",
    "Tagesüberblick: Termine, Einnahmen, offene Posten und neue Nachrichten auf einen Blick",
    "heute-tagesueberblick-dunkel",
  ),
  kalender: desktop("kalender-tagesansicht", "Kalender in der Tagesansicht mit Terminen zweier Behandlerinnen, Risiko-Hinweisen wie Diabetes und Schaltflächen für Doku, Anamnese und Absage", "Kalender mit Risiko-Hinweisen, Hausbesuchen und Herkunft der Buchung"),
  akte: desktop(
    "patientenakte",
    "Patientenakte von „Erika Muster“ (erfunden) mit Risiko-Markierung Diabetes, Kennzahlen und Zeitleiste aus Terminen, Behandlungsdoku und Rechnungen",
    "Patientenakte mit Zeitleiste – Termine, Doku und Belege an einem Ort",
    "patientenakte-dunkel",
  ),
  fussschema: ipad("doku-fussschema-ipad", "Behandlungsdoku am iPad: Fußschema rechts und links mit markierten Befundstellen, z. B. Nagel D1 und Großzehenballen, darunter Notizen je Stelle", "Doku am iPad: Befunde im Fußschema antippen und je Stelle notieren"),
  fuss3d: ipad("doku-3d-fussmodell-ipad", "Interaktives 3D-Fußmodell in der Behandlungsdoku mit markierter Stelle am Großzehennagel und Ansichten Oben, Sohle, Innen, Außen", "Alternativ am 3D-Fußmodell markieren – drehen, zoomen, antippen"),
  dokuEintrag: ipad("doku-eintrag-unveraenderbar-ipad", "Gespeicherter Behandlungseintrag mit Befund, Material, Sterilgut-Charge und Empfehlung, gekennzeichnet als unveränderbar", "Gespeichert und unveränderbar: Korrekturen nur als Nachtrag (§ 630f BGB)"),
  sammelrechnung: desktop("sammelrechnung-pflegeheim", "Sammelrechnung an ein Pflegeheim mit drei Positionen podologische Komplexbehandlung, Hinweis auf Steuerbefreiung nach § 4 Nr. 14 UStG und Zahlungsziel", "Sammelrechnung an das Pflegeheim – Positionen aus dem Besuchstag übernommen"),
  kasse: desktop("kasse-tagesabschluss", "Kasse mit offenen Einnahmen nach Zahlart, Kassenbestand, Einlagen und Entnahmen sowie Hinweis zum letzten Z-Bon", "Kasse: Kassenbuch, Zählprotokoll und Tagesabschluss (Z-Bon)"),
  pflegeheim: desktop("pflegeheim-bewohner", "Pflegeheim-Ansicht mit Bewohnerliste, Risiken und Rechnungsempfänger sowie Schaltflächen für Besuchstag und Sammelrechnung", "Pflegeheime: Bewohnerliste mit Risiken und Rechnungsempfänger"),
  besuchstag: ipad("pflegeheim-besuchstag-ipad", "Besuchstag im Pflegeheim am iPad: je Bewohner:in Leistungskürzel antippen, Kurzbefund eintragen und speichern", "Besuchstag: Schnell-Doku je Bewohner:in in einer Liste"),
  touren: desktop("touren-hausbesuche", "Tourenplanung für Hausbesuche mit Startort Praxis, Strecke und Fahrzeit sowie Navigation über Google Maps oder Apple Karten", "Touren: Hausbesuche in Reihenfolge, Strecke und Fahrzeit"),
  hygiene: desktop("hygiene-uebersicht", "Hygiene-Übersicht mit offenen Sterilgut-Chargen, anstehenden Geräte-Fristen, Materialbestand und Tages-Checkliste", "Hygiene: Chargen-Freigabe, Gerätefristen und Tages-Checkliste"),
  verordnungen: desktop("verordnungen-fristen", "Liste der GKV-Verordnungen mit Fristen-Ampel, Diagnosegruppe, Beginn-Frist, verbrauchten Einheiten und Status", "Verordnungen mit Fristen-Ampel und Einheiten bis zur Abrechnungsreife"),
  auswertung: desktop("auswertung", "Auswertung mit Umsatz und Behandlungen je Monat als Balkendiagramm, offenen Forderungen und Break-even-Rechnung", "Auswertung: Umsatz, Behandlungen und Break-even", "auswertung-dunkel"),
  portal: ipad("patientenportal-ipad", "Patientenportal: Begrüßung, nächster Termin mit Verschieben und Absagen sowie offene Rechnungen", "Patientenportal: eigene Termine sehen, verschieben, absagen"),
  website: desktop("praxis-website", "Automatisch erzeugte Praxis-Website „Podologie Muster“ mit Claim, Button „Termin online buchen“, Über-uns-Text und Leistungen mit Preisen", "Praxis-Website aus Ihren Praxisdaten – ohne Cookies und Tracking", "praxis-website-dunkel"),
  websiteEinstellungen: desktop("praxis-website-einstellungen", "Einstellungen der Praxis-Website mit Status online, Adresse, Hinweis zur eigenen Domain und Formular für Claim und Über-uns-Text", "Website-Baukasten: Texte, Zeiten und Hausbesuchsgebiet eintragen, veröffentlichen"),
} satisfies Record<string, Screenshot>;

export const PORTAL_PHONE: Screenshot = {
  src: "/screenshots/patientenportal-buchen-smartphone.webp",
  width: 860,
  height: 1864,
  alt: "Online-Buchung im Patientenportal auf dem Smartphone: Leistung gewählt, Tag ausgewählt und freie Uhrzeiten zur Auswahl",
  caption: "Online buchen: Leistung, Tag, freie Uhrzeit",
  device: "phone",
};

/** Galerien für /funktionen (id = Abschnitt in FEATURE_GROUPS) */
export const FEATURE_SHOTS: Record<string, Screenshot[]> = {
  akte: [SHOTS.akte],
  doku: [SHOTS.fussschema, SHOTS.fuss3d, SHOTS.dokuEintrag],
  termine: [SHOTS.kalender, SHOTS.portal, PORTAL_PHONE, SHOTS.website],
  verordnungen: [SHOTS.verordnungen],
  rechnungen: [SHOTS.sammelrechnung, SHOTS.kasse],
  kommunikation: [SHOTS.heute, SHOTS.websiteEinstellungen],
  praxis: [SHOTS.pflegeheim, SHOTS.besuchstag, SHOTS.touren, SHOTS.hygiene, SHOTS.auswertung],
};
