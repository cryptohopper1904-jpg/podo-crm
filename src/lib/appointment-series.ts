/**
 * Serientermine: reine Logik ohne DB.
 * Die Wanduhrzeit in Berlin bleibt über Zeitumstellungen gleich (12:00 MEZ → 12:00 MESZ),
 * weil das Kalenderdatum weitergezählt und erst dann in UTC umgerechnet wird –
 * nicht `start + i × 7 × 24 h`, das sich bei der Umstellung um eine Stunde verschiebt.
 */

import { addDaysIso } from "./calendar-grid";
import { berlinToUtc } from "./format";

/**
 * Startzeitpunkte (UTC) einer Terminserie.
 * - `dateIso`/`time`: erster Termin als Berliner Datum („YYYY-MM-DD“) und Uhrzeit („HH:MM“)
 * - `intervalWeeks`: Abstand in Wochen; 0 = einmaliger Termin
 * - `count`: Anzahl der Termine (bei `intervalWeeks` 0 immer genau einer)
 */
export function seriesStarts(dateIso: string, time: string, intervalWeeks: number, count: number): Date[] {
  const n = intervalWeeks > 0 ? Math.max(1, count) : 1;
  return Array.from({ length: n }, (_, i) => berlinToUtc(addDaysIso(dateIso, i * intervalWeeks * 7), time));
}
