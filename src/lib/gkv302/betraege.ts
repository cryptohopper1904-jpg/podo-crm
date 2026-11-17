/**
 * Betragsberechnung nach den Berechnungsregeln der TA1 V21, 5.5.3.3 (EHE, MWS, BES, GZF) und 5.5.2 (GES).
 * Alle Beträge in Cent als ganze Zahlen; „kaufmännisch runden“ = halbe Cent aufrunden.
 *
 * Auslegung (in docs/GKV-302.md vermerkt): Die Summenregeln „Summe über alle Abrechnungspositionen von (…)
 * kaufmännisch gerundet“ werden je Position gerundet und dann summiert. Bei ganzzahligen Mengen ist das Ergebnis
 * identisch mit einer Rundung der Summe. Bei Mengen mit Nachkommastellen (z. B. 12,5 km) kann die Summe der
 * gerundeten Positionen geringfügig (höchstens ½ Cent je Position) von der gerundeten Summe abweichen; die Lesart
 * ist im Erprobungsverfahren mit der Datenannahmestelle zu bestätigen (Anhang 2 Kap. 6).
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

/**
 * Ob für eine Position Zuzahlung anfällt.
 * - Grundvoraussetzung: Die Position unterliegt laut Vergütungsliste der Zuzahlung (`zuzahlungsfaehig`, Standard ja;
 *   `false` z. B. für Positionen ohne Zuzahlungsbetrag in der Vergütungsvereinbarung Podologie, Anlage 2).
 * - VKZ 03 (Zuzahlungsforderung): unabhängig vom Zuzahlungskennzeichen, das hier nur den Grund nennt (1, 2 oder 5);
 *   gefordert wird die Zuzahlung aller übermittelten Positionen, „auch nur Teile … z. B. nur ein Teil der Termine“
 *   (TA1 V21 7.4.2.1–7.4.2.4, S. 167–168). Einzelne Positionen lassen sich mit `zuzahlungspflichtig: false` ausnehmen.
 * - sonst Anlage 3 V21 8.1.3: 3 immer, 0/1 nie, 2/4/5 laut Angabe je Position.
 */
export function positionZuzahlungspflichtig(fall: Abrechnungsfall, l: Einzelleistung, vkz: string = "01"): boolean {
  if (l.zuzahlungsfaehig === false) return false;
  if (vkz === "03") return l.zuzahlungspflichtig !== false;
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

/** Pauschale je Verordnung (TA1 V21 5.5.3.3 BES/GZF, S. 73–74); bei VKZ 03 Standard ja, `false` nimmt sie aus. */
function pauschaleFaellt(fall: Abrechnungsfall, vkz: string): boolean {
  if (vkz === "03") return fall.pauschaleZuzahlung !== false;
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

/**
 * Beträge eines Falls. `vkz` ist das Verarbeitungskennzeichen der Gesamtrechnung (Standard „01“); bei „03“ wird die
 * Zuzahlung unabhängig vom Zuzahlungskennzeichen gefordert (siehe `positionZuzahlungspflichtig`).
 */
export function fallBetraege(fall: Abrechnungsfall, zuzahlungProzent: number, pauschaleCent: number, vkz: string = "01"): FallBetraege {
  const positionen = fall.leistungen.map((l) => positionsBetraege(l, positionZuzahlungspflichtig(fall, l, vkz), zuzahlungProzent));
  const bruttoCent = positionen.reduce((s, p) => s + p.bruttoCent, 0);
  const prozentualeZuzahlungCent = positionen.reduce((s, p) => s + p.zuzahlungCent, 0);
  const pauschaleZuzahlungCent = pauschaleFaellt(fall, vkz) ? Math.max(0, Math.min(pauschaleCent, bruttoCent - prozentualeZuzahlungCent)) : 0;
  return {
    positionen,
    bruttoCent,
    prozentualeZuzahlungCent,
    pauschaleZuzahlungCent,
    gesetzlicheZuzahlungCent: prozentualeZuzahlungCent + pauschaleZuzahlungCent,
    korrekturabzugCent: fall.pauschalerKorrekturabzugCent ?? 0,
  };
}
