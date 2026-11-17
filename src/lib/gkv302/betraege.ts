/**
 * Betragsberechnung nach den Berechnungsregeln der TA1 V21, 5.5.3.3 (EHE, MWS, BES, GZF) und 5.5.2 (GES).
 * Alle Beträge in Cent als ganze Zahlen; „kaufmännisch runden“ = halbe Cent aufrunden.
 *
 * Auslegung (in docs/GKV-302.md vermerkt): Die Summenregeln „Summe über alle Abrechnungspositionen von (…)
 * kaufmännisch gerundet“ werden je Position gerundet und dann summiert. Bei ganzzahligen Mengen ist das Ergebnis
 * identisch mit einer Rundung der Summe.
 */
import type { Abrechnungsfall, Einzelleistung } from "./typen";

/** a / b kaufmännisch gerundet, a ≥ 0, b > 0, ganzzahlig */
function rundeDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** Zahl mit höchstens 2 Nachkommastellen → Hundertstel als ganze Zahl */
export function hundertstel(x: number): number {
  return Math.round(x * 100);
}

export interface PositionsBetraege {
  /** MWS Betrag Mehrwertsteuer (Einzelbetrag netto × Anzahl × Satz), oder 0 */
  mwstCent: number;
  /** EHE Betrag der Zuzahlung je Einheit: (Einzelbetrag + MwSt je Einheit) × Prozentsatz */
  zuzahlungJeEinheitCent: number;
  /** (Einzelbetrag × Anzahl) + MwSt */
  bruttoCent: number;
  /** Zuzahlung je Einheit × Anzahl */
  zuzahlungCent: number;
}

export function positionsBetraege(l: Einzelleistung, zuzahlungspflichtig: boolean, zuzahlungProzent: number): PositionsBetraege {
  const anzahlH = hundertstel(l.anzahl);
  const satzH = l.mehrwertsteuerProzent !== undefined ? hundertstel(l.mehrwertsteuerProzent) : 0;
  // MWS: EHE.Einzelbetrag (NETTO) × Anzahl × Satz, kaufmännisch gerundet
  const mwstCent = satzH ? rundeDiv(l.einzelpreisCent * anzahlH * satzH, 100 * 10000) : 0;
  // EHE Zuzahlung: MwSt „auf die einzelne Position mit dem Mengenfaktor 1 herunterzurechnen und kaufmännisch zu runden“
  const mwstJeEinheit = satzH ? rundeDiv(l.einzelpreisCent * satzH, 10000) : 0;
  const zuzahlungJeEinheitCent = zuzahlungspflichtig
    ? rundeDiv((l.einzelpreisCent + mwstJeEinheit) * hundertstel(zuzahlungProzent), 10000)
    : 0;
  const bruttoCent = rundeDiv(l.einzelpreisCent * anzahlH, 100) + mwstCent;
  const zuzahlungCent = rundeDiv(zuzahlungJeEinheitCent * anzahlH, 100);
  return { mwstCent, zuzahlungJeEinheitCent, bruttoCent, zuzahlungCent };
}

export interface FallBetraege {
  positionen: PositionsBetraege[];
  /** BES Gesamtbetrag Brutto */
  bruttoCent: number;
  /** BES Gesamtbetrag prozentuale Zuzahlung */
  prozentualeZuzahlungCent: number;
  /** BES pauschaler Zuzahlungsbetrag: Pauschale, höchstens Brutto − prozentuale Zuzahlung */
  pauschaleZuzahlungCent: number;
  /** BES Gesamtbetrag gesetzliche Zuzahlung = prozentual + pauschal */
  gesetzlicheZuzahlungCent: number;
  /** BES Pauschale Korrekturabzug (nur VKZ 04) */
  korrekturabzugCent: number;
}

/** Ob für eine Position Zuzahlung anfällt (Anlage 3 8.1.3): 3 immer, 0/1 nie, 2/4/5 laut Angabe je Position */
export function positionZuzahlungspflichtig(fall: Abrechnungsfall, l: Einzelleistung): boolean {
  switch (fall.zuzahlungskennzeichen) {
    case "3":
      return true;
    case "0":
    case "1":
      return false;
    default:
      return l.zuzahlungspflichtig === true;
  }
}

function pauschaleFaellt(fall: Abrechnungsfall): boolean {
  switch (fall.zuzahlungskennzeichen) {
    case "3":
      return true;
    case "0":
    case "1":
      return false;
    default:
      return fall.pauschaleZuzahlung === true;
  }
}

export function fallBetraege(fall: Abrechnungsfall, zuzahlungProzent: number, pauschaleCent: number): FallBetraege {
  const positionen = fall.leistungen.map((l) => positionsBetraege(l, positionZuzahlungspflichtig(fall, l), zuzahlungProzent));
  const bruttoCent = positionen.reduce((s, p) => s + p.bruttoCent, 0);
  const prozentualeZuzahlungCent = positionen.reduce((s, p) => s + p.zuzahlungCent, 0);
  const pauschaleZuzahlungCent = pauschaleFaellt(fall) ? Math.max(0, Math.min(pauschaleCent, bruttoCent - prozentualeZuzahlungCent)) : 0;
  return {
    positionen,
    bruttoCent,
    prozentualeZuzahlungCent,
    pauschaleZuzahlungCent,
    gesetzlicheZuzahlungCent: prozentualeZuzahlungCent + pauschaleZuzahlungCent,
    korrekturabzugCent: fall.pauschalerKorrekturabzugCent ?? 0,
  };
}
