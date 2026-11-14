import { berlinParts } from "./calendar-grid";

/**
 * Begrüßung nach Berliner Uhrzeit. Die Stunde kommt aus `berlinParts` (Minuten ab Mitternacht) –
 * nicht aus einem formatierten String: `de-DE` liefert „07 Uhr“, `Number("07 Uhr")` ist NaN und ergab immer „Guten Abend“.
 */
export function greeting(now: Date = new Date()): string {
  const h = Math.floor(berlinParts(now).min / 60);
  return h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
}
