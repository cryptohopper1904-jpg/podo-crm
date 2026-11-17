/**
 * Schlüssel aus Anlage 3 (Schlüsselverzeichnisse) V21 (Stand 19.09.2025), soweit für Heilmittel/Podologie nötig.
 * Anlage 3 V22 (Stand 23.09.2026) ändert keinen dieser Schlüssel (Wortvergleich, siehe docs/GKV-302.md).
 */

/** 8.1.5.1 Abrechnungscode – Heilmittelerbringer der Podologie */
export const ABRECHNUNGSCODE = { podologe: "71", medFusspfleger: "72" } as const;
export const ABRECHNUNGSCODES_PODOLOGIE = ["71", "72"] as const;
export type AbrechnungscodePodologie = (typeof ABRECHNUNGSCODES_PODOLOGIE)[number];

/** 8.1.14 Leistungserbringer-Sammelgruppenschlüssel: B = Heilmittel (UNB S005) */
export const SAMMELGRUPPE_HEILMITTEL = "B";

/** 8.1.7 Verarbeitungskennzeichen; zulässig für Heilmittel laut TA1 Kap. 7.1: 02, 03, 04 (10 nur Physiotherapie) */
export const VERARBEITUNGSKENNZEICHEN = ["01", "02", "03", "04"] as const;
export type Verarbeitungskennzeichen = (typeof VERARBEITUNGSKENNZEICHEN)[number];

/** 8.1.4 Rechnungsart (3 = Abrechnungsstelle mit Inkassovollmacht wird hier nicht unterstützt) */
export const RECHNUNGSARTEN = ["1", "2"] as const;

/** 8.1.6 Summenstatus */
export const SUMMENSTATUS = ["00", "11", "31", "51", "99"] as const;
export type Summenstatus = (typeof SUMMENSTATUS)[number];

/** 8.1.6 Anmerkung: erste Ziffer des Versichertenstatus 1 → 11, 3 → 31, 5 → 51, sonst 99 */
export function summenstatusAus(versichertenstatus: string | undefined): Exclude<Summenstatus, "00"> {
  switch (versichertenstatus?.[0]) {
    case "1":
      return "11";
    case "3":
      return "31";
    case "5":
      return "51";
    default:
      return "99";
  }
}

/** 8.1.3 Zuzahlungskennzeichen */
export const ZUZAHLUNGSKENNZEICHEN = ["0", "1", "2", "3", "4", "5"] as const;
export type Zuzahlungskennzeichen = (typeof ZUZAHLUNGSKENNZEICHEN)[number];

/** 8.1.12 Kennzeichen Verordnungsart bei Heilmitteln (belegt: 03, 04, 05; 99 laut TA1 ZHE für Fälle außerhalb der HeilM-RL) */
export const VERORDNUNGSART = ["03", "04", "05", "99"] as const;
export type Verordnungsart = (typeof VERORDNUNGSART)[number];

/** 8.1.11 Kennzeichen Verordnungsbesonderheiten (8 = nur Hilfsmittel, 3 = nicht belegt → hier ausgeschlossen) */
export const VERORDNUNGSBESONDERHEIT = ["1", "2", "4", "7", "9"] as const;

/** 8.1.2 Unfall/Sonstiges */
export const UNFALLKENNZEICHEN = ["1", "2", "3"] as const;
/** 8.1.2.1 BVG/SER */
export const BVG_SER = ["6"] as const;

/** 8.1.17 Art der Genehmigung – Bereich Heilmittel (B1 nicht belegt) */
export const ART_DER_GENEHMIGUNG_HEILMITTEL = ["B2"] as const;

/** 8.1.18 Beleginformation (2 erst bei flächendeckender elektronischer Verarbeitung) */
export const BELEGINFORMATION = ["0", "1", "2"] as const;

/** TA1 5.5.3.3 ZHE Heilmittel-Bereich: 2 = Podologische Therapie */
export const HEILMITTELBEREICH = ["1", "2", "3", "4", "5"] as const;

/** UNB 0035 Testindikator (TA1 5.4) */
export const TESTINDIKATOR = { test: "0", erprobung: "1", echt: "2" } as const;
export type Dateiart = keyof typeof TESTINDIKATOR;

/**
 * 8.1.5.2 Tarifkennzeichen, 5 Stellen: 1.–2. Tarifbereich (00–25, 50–75, 90, 91–99 belegt), 3.–5. Sondertarif
 * (Buchstaben nur als Großbuchstaben, TA1 5.5.3.3 EHE).
 */
export function istGueltigesTarifkennzeichen(tk: string): boolean {
  if (!/^\d{2}[0-9A-Z]{3}$/.test(tk)) return false;
  const bereich = Number(tk.slice(0, 2));
  return bereich <= 25 || (bereich >= 50 && bereich <= 75) || bereich >= 90;
}
