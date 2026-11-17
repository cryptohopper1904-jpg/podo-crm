/**
 * Strenge Betragseingabe in Euro (z. B. „Zuzahlung erhalten“, PR #111 Review-Runde 2).
 *
 *  - Tausenderpunkte nur im deutschen Muster `1.234` / `1.234,56` / `12.345.678,9` (Gruppen zu genau drei Ziffern).
 *  - Sonst ist ein einzelner Punkt Dezimaltrenner: „12.5“ = 12,50 €, „12.34“ = 12,34 € (nicht 125 € bzw. 1.234 €).
 *  - Erlaubt sind nur `^\d+([.,]\d{1,2})?$` oder das Tausender-Muster; Leerzeichen und „€“ werden ignoriert.
 *
 * Mehrdeutig bleibt „1.234“: nach dem Tausender-Muster 1.234,00 € (deutsche Schreibweise hat Vorrang).
 * Rückgabe: Cent, `null` bei leerer Eingabe, `{ error }` bei ungültiger Eingabe.
 */
const THOUSANDS = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/;
const PLAIN = /^\d+([.,]\d{1,2})?$/;

export function parseEuroInputCents(input: string | null | undefined): number | null | { error: string } {
  const s = (input ?? "").replace(/[\s €]/g, "");
  if (!s) return null;
  let normalized: string;
  if (THOUSANDS.test(s)) normalized = s.replace(/\./g, "").replace(",", ".");
  else if (PLAIN.test(s)) normalized = s.replace(",", ".");
  else return { error: "Betrag ungültig – bitte z. B. 12,50 eingeben." };
  const [euro, frac = ""] = normalized.split(".");
  const cents = Number(euro) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : { error: "Betrag ist zu groß." };
}
