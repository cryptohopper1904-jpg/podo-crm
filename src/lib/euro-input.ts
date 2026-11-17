/**
 * Strenge Betragseingabe in Euro (z. B. „Zuzahlung erhalten“, PR #111 Review-Runden 2 und 3).
 *
 *  - Tausendertrenner nur im deutschen Muster: Punkt `1.234` / `1.234,56` oder Leerzeichen `1 234,56` (Gruppen zu genau
 *    drei Ziffern; auch geschütztes Leerzeichen).
 *  - Sonst ist ein einzelner Punkt Dezimaltrenner: „12.5“ = 12,50 €, „12.34“ = 12,34 € (nicht 125 € bzw. 1.234 €).
 *  - Erlaubt sind nur `^\d+([.,]\d{1,2})?$` oder die Tausender-Muster. Leerzeichen und „€“ nur am Rand; „12 50“ → Fehler.
 *  - Höchstens `EURO_INPUT_MAX_CENTS` (10.000 €) – größere Zahlen werden nie an die DB gereicht (integer-Spalte).
 *
 * Mehrdeutig bleibt „1.234“: nach dem Tausender-Muster 1.234,00 € (deutsche Schreibweise hat Vorrang).
 * Rückgabe: Cent, `null` bei leerer Eingabe, `{ error }` bei ungültiger Eingabe.
 */
export const EURO_INPUT_MAX_CENTS = 1_000_000;
/** Höchstlänge der Eingabe (Formular `maxLength` und Server-Schema) */
export const EURO_INPUT_MAX_LENGTH = 20;

const THOUSANDS_DOT = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/;
const THOUSANDS_SPACE = /^\d{1,3}( \d{3})+(,\d{1,2})?$/;
const PLAIN = /^\d+([.,]\d{1,2})?$/;
const EDGE = /^[\s €]+|[\s €]+$/g;

export function parseEuroInputCents(input: string | null | undefined): number | null | { error: string } {
  const s = (input ?? "").replace(EDGE, "").replace(/ /g, " ");
  if (!s) return null;
  let normalized: string;
  if (THOUSANDS_DOT.test(s)) normalized = s.replace(/\./g, "").replace(",", ".");
  else if (THOUSANDS_SPACE.test(s)) normalized = s.replace(/ /g, "").replace(",", ".");
  else if (PLAIN.test(s)) normalized = s.replace(",", ".");
  else return { error: "Betrag ungültig – bitte z. B. 12,50 eingeben." };
  const [euro, frac = ""] = normalized.split(".");
  // Ganzzahl-Euro zuerst begrenzen (lange Ziffernfolgen nicht in Number rechnen)
  if (euro.replace(/^0+/, "").length > 6) return { error: "Betrag ist zu groß." };
  const cents = Number(euro) * 100 + Number(frac.padEnd(2, "0"));
  return cents > EURO_INPUT_MAX_CENTS ? { error: "Betrag ist zu groß." } : cents;
}
