/**
 * Segmentbeschreibungen nach Technischer Anlage 1 (TA1) V21, Stand 15.01.2026.
 * Reihenfolge, Typ (AN/N), Länge und Feldart (M/K) sind 1:1 aus den Tabellen übernommen; Seitenangaben beziehen
 * sich auf die PDF-Fassung „Anlage_1_TP5_V21_20260115.pdf“. TA1 V22 (Stand 21.05.2026) ist für diese Segmente
 * wortgleich bis auf die Versionsnummer im UNH (Wortvergleich, siehe docs/GKV-302.md).
 */
import type { SegmentSpez } from "./edifact";
import {
  ART_DER_GENEHMIGUNG_HEILMITTEL,
  BELEGINFORMATION,
  BVG_SER,
  HEILMITTELBEREICH,
  RECHNUNGSARTEN,
  SUMMENSTATUS,
  UNFALLKENNZEICHEN,
  VERARBEITUNGSKENNZEICHEN,
  VERORDNUNGSART,
  VERORDNUNGSBESONDERHEIT,
  ZUZAHLUNGSKENNZEICHEN,
} from "./schluessel";

// ───────────── Service-Segmente, TA1 5.4 (S. 20–23) ─────────────

export const UNB: SegmentSpez = {
  kennung: "UNB",
  elemente: [
    { name: "Syntax", art: "M", teile: [
      { name: "Syntax-Kennung", typ: "AN", art: "M", laenge: 4, schluessel: ["UNOC"] },
      { name: "Syntax-Versionsnummer", typ: "N", art: "M", laenge: 1, schluessel: ["3"] },
    ] },
    // ..35 AN, genutzt werden die ersten 9 Stellen: IK
    { name: "Absenderbezeichnung", typ: "AN", art: "M", laenge: 9 },
    { name: "Empfängerbezeichnung", typ: "AN", art: "M", laenge: 9 },
    { name: "Datum/Uhrzeit", art: "M", teile: [
      { name: "Datum", typ: "N", art: "M", laenge: 8 },
      { name: "Uhrzeit", typ: "N", art: "M", laenge: 4 },
    ] },
    // ..14 AN, genutzt werden die ersten 5 Stellen mit führenden Nullen
    { name: "Datenaustauschreferenz", typ: "AN", art: "M", laenge: 5 },
    { name: "Leistungsbereich", typ: "AN", art: "M", laenge: 1, schluessel: ["B"] },
    // ..14 AN, genutzt werden die ersten 11 Stellen: logischer Dateiname
    { name: "Anwendungsreferenz", typ: "AN", art: "M", laenge: 11 },
    { name: "Testindikator", typ: "N", art: "M", laenge: 1, schluessel: ["0", "1", "2"] },
  ],
};

export const UNZ: SegmentSpez = {
  kennung: "UNZ",
  elemente: [
    { name: "Anzahl Nachrichten", typ: "N", art: "M", laenge: 6 },
    { name: "Datenaustauschreferenz", typ: "AN", art: "M", laenge: 5 },
  ],
};

export function unhSpez(version: string): SegmentSpez {
  return {
    kennung: "UNH",
    elemente: [
      { name: "Nachrichtenreferenznummer", typ: "AN", art: "M", laenge: 5 },
      { name: "Nachrichtenkennung", art: "M", teile: [
        { name: "Nachr-Typ-Kennung", typ: "AN", art: "M", laenge: 4, schluessel: ["SLGA", "SLLA"] },
        { name: "Versionsnummer", typ: "AN", art: "M", laenge: 2, schluessel: [version] },
        { name: "Freigabe-Nr. des Typs", typ: "AN", art: "M", laenge: 1, schluessel: ["0"] },
        { name: "Verwaltende Organisation", typ: "AN", art: "M", laenge: 1, schluessel: ["0"] },
      ] },
    ],
  };
}

export const UNT: SegmentSpez = {
  kennung: "UNT",
  elemente: [
    { name: "Anzahl Einheiten", typ: "N", art: "M", laenge: 6 },
    { name: "Nachrichtenreferenznummer", typ: "AN", art: "M", laenge: 5 },
  ],
};

// ───────────── SLGA, TA1 5.5.2 (S. 31–38) ─────────────

export const SLGA_FKT: SegmentSpez = {
  kennung: "FKT",
  elemente: [
    { name: "Verarbeitungskennzeichen", typ: "N", art: "M", laenge: 2, schluessel: VERARBEITUNGSKENNZEICHEN },
    { name: "Sammelrechnung", typ: "AN", art: "K", laenge: 1, schluessel: ["J"] },
    { name: "IK des Rechnungsstellers/Leistungserbringers", typ: "N", art: "M", laenge: 9 },
    { name: "IK des Kostenträgers", typ: "N", art: "M", laenge: 9 },
    { name: "IK der Krankenkasse", typ: "N", art: "K", laenge: 9 },
    { name: "IK Absender der Datei", typ: "N", art: "M", laenge: 9 },
  ],
};

/** REC ist in SLGA und SLLA identisch (S. 32–34 bzw. S. 43–45) */
export const REC: SegmentSpez = {
  kennung: "REC",
  elemente: [
    { name: "Rechnungsnummer", art: "M", teile: [
      { name: "Sammel-Rechnungsnummer", typ: "AN", art: "M", max: 14 },
      { name: "Einzel-Rechnungsnummer", typ: "AN", art: "M", max: 6 },
    ] },
    { name: "Datum", typ: "N", art: "M", laenge: 8 },
    { name: "Rechnungsart", typ: "N", art: "M", laenge: 1, schluessel: RECHNUNGSARTEN },
  ],
};

export const UST: SegmentSpez = {
  kennung: "UST",
  elemente: [
    { name: "Steuernummer/Umsatzsteuer-Identifikationsnummer", typ: "AN", art: "M", max: 20 },
    { name: "Kennung UST-Befreiung", typ: "AN", art: "K", laenge: 1, schluessel: ["J"] },
  ],
};

export const SKO: SegmentSpez = {
  kennung: "SKO",
  elemente: [
    { name: "Skonto in Prozent", typ: "N", art: "M", max: 4, dezimal: 2 },
    { name: "Zahlungsziel", typ: "N", art: "M", max: 3 },
  ],
};

export const GES: SegmentSpez = {
  kennung: "GES",
  elemente: [
    { name: "Status", typ: "N", art: "M", laenge: 2, schluessel: SUMMENSTATUS },
    { name: "Gesamtrechnungsbetrag", typ: "N", art: "M", max: 10, dezimal: 2 },
    { name: "Gesamtbruttobetrag", typ: "N", art: "M", max: 10, dezimal: 2 },
    { name: "Gesamtbetrag Zuzahlung und/oder Eigenanteil und/oder Pauschale Korrekturbetrag", typ: "N", art: "K", max: 10, dezimal: 2 },
  ],
};

export const NAM: SegmentSpez = {
  kennung: "NAM",
  elemente: [
    { name: "Name 1", typ: "AN", art: "M", max: 30 },
    { name: "Name 2", typ: "AN", art: "K", max: 30 },
    { name: "Name 3", typ: "AN", art: "K", max: 30 },
    { name: "Name 4", typ: "AN", art: "K", max: 70 },
  ],
};

// ───────────── SLLA Basis-Segmente, TA1 5.5.3.1 (S. 41–48) ─────────────

export const SLLA_FKT: SegmentSpez = {
  kennung: "FKT",
  elemente: [
    { name: "Verarbeitungskennzeichen", typ: "N", art: "M", laenge: 2, schluessel: VERARBEITUNGSKENNZEICHEN },
    { name: "Freifeld", typ: "AN", art: "K", laenge: 1 },
    { name: "IK des Leistungserbringers", typ: "N", art: "M", laenge: 9 },
    { name: "IK des Kostenträgers", typ: "N", art: "M", laenge: 9 },
    { name: "IK der Krankenkasse", typ: "N", art: "M", laenge: 9 },
    { name: "IK des Rechnungsstellers", typ: "N", art: "K", laenge: 9 },
  ],
};

export const INV: SegmentSpez = {
  kennung: "INV",
  elemente: [
    { name: "Versicherten-Nummer", typ: "AN", art: "K", max: 12 },
    { name: "Versichertenstatus", typ: "AN", art: "K", laenge: 5 },
    { name: "Beleginformation", typ: "AN", art: "K", laenge: 1, schluessel: BELEGINFORMATION },
    { name: "Belegnummer", typ: "AN", art: "M", max: 10 },
    { name: "Kennzeichen Besondere Versorgungsform", typ: "AN", art: "K", max: 25 },
  ],
};

export const URI: SegmentSpez = {
  kennung: "URI",
  elemente: [
    { name: "ursprüngliches IK des Leistungserbringers", typ: "N", art: "M", laenge: 9 },
    { name: "ursprüngliche Rechnungsnummer", art: "M", teile: [
      { name: "ursprüngliche Sammel-Rechnungsnummer", typ: "AN", art: "M", max: 14 },
      { name: "ursprüngliche Einzel-Rechnungsnummer", typ: "AN", art: "M", max: 6 },
    ] },
    { name: "ursprüngliches Rechnungsdatum", typ: "N", art: "M", laenge: 8 },
    { name: "ursprüngliche Belegnummer", typ: "AN", art: "M", max: 10 },
  ],
};

export const NAD: SegmentSpez = {
  kennung: "NAD",
  elemente: [
    { name: "Vers.-Nachname", typ: "AN", art: "M", max: 47 },
    { name: "Vers.-Vorname", typ: "AN", art: "M", max: 30 },
    { name: "Vers.-Geburtsdatum", typ: "N", art: "M", laenge: 8 },
    { name: "Vers.-Straße/Nr.", typ: "AN", art: "K", max: 30 },
    { name: "Vers.-PLZ", typ: "AN", art: "K", max: 7 },
    { name: "Vers.-Wohnort", typ: "AN", art: "K", max: 25 },
    { name: "Vers.-Länderkennzeichen", typ: "AN", art: "K", max: 3 },
  ],
};

export const EVO: SegmentSpez = {
  kennung: "EVO",
  elemente: [{ name: "eVO-ID", typ: "AN", art: "M", min: 22, max: 256 }],
};

// ───────────── SLLA:B Heilmittel, TA1 5.5.3.3 (S. 63–75) ─────────────

export const EHE: SegmentSpez = {
  kennung: "EHE",
  elemente: [
    { name: "Leistungserbringergruppe", art: "M", teile: [
      { name: "Abrechnungscode", typ: "AN", art: "M", laenge: 2 },
      { name: "Tarifkennzeichen", typ: "AN", art: "M", laenge: 5 },
    ] },
    { name: "Art der abgegebenen Leistung (Abrechnungspositionsnummer)", typ: "AN", art: "M", max: 5 },
    { name: "Anzahl/Menge", typ: "N", art: "M", max: 4, dezimal: 2 },
    { name: "Einzelbetrag der Abrechnungsposition", typ: "N", art: "M", max: 10, dezimal: 2 },
    { name: "Datum der Leistungserbringung", typ: "N", art: "M", laenge: 8 },
    { name: "Betrag der Zuzahlung", typ: "N", art: "K", max: 10, dezimal: 2 },
    { name: "Gefahrene Kilometer", typ: "N", art: "K", max: 6 },
  ],
};

export const TXT: SegmentSpez = {
  kennung: "TXT",
  elemente: [{ name: "Text", typ: "AN", art: "M", max: 70 }],
};

export const MWS: SegmentSpez = {
  kennung: "MWS",
  elemente: [
    { name: "Mehrwertsteuersatz", typ: "N", art: "M", max: 5, dezimal: 2 },
    { name: "Betrag Mehrwertsteuer", typ: "N", art: "M", max: 10, dezimal: 2 },
  ],
};

export const ZHE: SegmentSpez = {
  kennung: "ZHE",
  elemente: [
    { name: "Betriebsstättennummer", typ: "AN", art: "M", max: 9 },
    { name: "Lebenslange Arztnummer", typ: "AN", art: "M", max: 9 },
    { name: "Verordnungsdatum", typ: "N", art: "M", laenge: 8 },
    { name: "Zuzahlungskennzeichen", typ: "N", art: "M", laenge: 1, schluessel: ZUZAHLUNGSKENNZEICHEN },
    { name: "Diagnosegruppe / Indikationsgruppe", typ: "AN", art: "M", max: 4 },
    { name: "Kennzeichen Verordnungsart bei Heilmitteln", typ: "N", art: "M", laenge: 2, schluessel: VERORDNUNGSART },
    { name: "Kennzeichen Verordnungsbesonderheiten", typ: "N", art: "K", laenge: 1, schluessel: VERORDNUNGSBESONDERHEIT },
    { name: "Unfallkennzeichen", typ: "N", art: "K", laenge: 1, schluessel: UNFALLKENNZEICHEN },
    { name: "Kennzeichen BVG/Sonstiges/SER", typ: "N", art: "K", laenge: 1, schluessel: BVG_SER },
    // „Dieses Feld wird nicht mehr gefüllt. Das Feld wird als Leerfeld übermittelt.“ (S. 70)
    { name: "Behandlungsbeginn", typ: "N", art: "K", max: 0 },
    { name: "Therapiebericht angefordert", typ: "N", art: "K", laenge: 1, schluessel: ["1"] },
    { name: "Hausbesuch", typ: "N", art: "K", laenge: 1, schluessel: ["1"] },
    { name: "Leitsymptomatik", typ: "AN", art: "M", laenge: 4 },
    { name: "Patientenindividuelle Leitsymptomatik", typ: "AN", art: "K", max: 70 },
    { name: "Dringlicher Behandlungsbedarf", typ: "N", art: "M", laenge: 1, schluessel: ["0", "1"] },
    { name: "Heilmittel-Bereich", typ: "N", art: "K", laenge: 1, schluessel: HEILMITTELBEREICH },
    { name: "Therapiefrequenz", typ: "N", art: "M", laenge: 1 },
  ],
};

export const DIA: SegmentSpez = {
  kennung: "DIA",
  elemente: [
    { name: "Diagnoseschlüssel", typ: "AN", art: "K", max: 12 },
    { name: "Diagnosetext", typ: "AN", art: "K", max: 70 },
  ],
};

export const SKZ: SegmentSpez = {
  kennung: "SKZ",
  elemente: [
    { name: "Genehmigungskennzeichen", typ: "AN", art: "M", max: 20 },
    { name: "Datum der Genehmigung", typ: "N", art: "M", laenge: 8 },
    { name: "Art der Genehmigung", typ: "AN", art: "M", laenge: 2, schluessel: ART_DER_GENEHMIGUNG_HEILMITTEL },
  ],
};

export const BES: SegmentSpez = {
  kennung: "BES",
  elemente: [
    { name: "Gesamtbetrag Brutto", typ: "N", art: "M", max: 10, dezimal: 2 },
    { name: "Gesamtbetrag gesetzliche Zuzahlung", typ: "N", art: "K", max: 10, dezimal: 2 },
    { name: "Gesamtbetrag prozentuale Zuzahlung", typ: "N", art: "K", max: 10, dezimal: 2 },
    { name: "pauschaler Zuzahlungsbetrag", typ: "N", art: "K", max: 10, dezimal: 2 },
    { name: "Pauschale Korrekturabzug", typ: "N", art: "K", max: 10, dezimal: 2 },
  ],
};

export const GZF: SegmentSpez = {
  kennung: "GZF",
  elemente: [
    { name: "Gesamtbetrag Forderung gesetzliche Zuzahlung", typ: "N", art: "M", max: 10, dezimal: 2 },
    { name: "Gesamtbetrag Forderung prozentuale Zuzahlung", typ: "N", art: "K", max: 10, dezimal: 2 },
    { name: "Forderung pauschaler Zuzahlungsbetrag", typ: "N", art: "K", max: 10, dezimal: 2 },
  ],
};
