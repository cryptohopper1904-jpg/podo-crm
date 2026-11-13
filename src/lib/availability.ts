/**
 * Verfügbarkeit von Behandler:innen (rein, ohne DB): Arbeitszeiten je Wochentag minus
 * Abwesenheiten, Feiertage und Sperrzeiten (Pause, Schulung … – src/lib/calendar-blocks.ts). Genutzt von src/server/staff.ts (Kalender, Online-Buchung).
 * Ohne gepflegte Arbeitszeiten gelten die Öffnungszeiten der Praxis je Wochentag (src/lib/opening-hours.ts).
 */

import { DEFAULT_WEEK, hoursOnWeekday, type TimeRange, type WeekHours } from "./opening-hours";

export type { TimeRange };

export const WEEKDAYS = [
  [1, "Montag"],
  [2, "Dienstag"],
  [3, "Mittwoch"],
  [4, "Donnerstag"],
  [5, "Freitag"],
  [6, "Samstag"],
  [7, "Sonntag"],
] as const;

export const ABSENCE_KINDS = ["vacation", "sick", "training", "other"] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];
export const ABSENCE_LABELS: Record<AbsenceKind, string> = {
  vacation: "Urlaub",
  sick: "Krank",
  training: "Fortbildung",
  other: "Sonstiges",
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** 1 = Montag … 7 = Sonntag (wie working_hours.weekday). */
export function isoWeekday(dateIso: string): number {
  const d = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Sortiert und verschmilzt überlappende/angrenzende Zeitfenster; ungültige werden verworfen. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const valid = ranges
    .filter((r) => HHMM.test(r.start) && HHMM.test(r.end) && toMin(r.end) > toMin(r.start))
    .map((r) => [toMin(r.start), toMin(r.end)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out.map(([s, e]) => ({ start: toHhmm(s), end: toHhmm(e) }));
}

/**
 * Parst „08:00-12:00, 13:00-17:30“ (auch „8-12“, „8:30–12“). Leer = frei.
 * Gibt einen Fehlertext zurück, wenn etwas nicht lesbar ist.
 */
export function parseRanges(text: string): { ranges: TimeRange[]; error?: string } {
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const ranges: TimeRange[] = [];
  const norm = (t: string) => {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t.trim().replace(".", ":"));
    if (!m) return null;
    const v = `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
    return HHMM.test(v) ? v : null;
  };
  for (const p of parts) {
    const [a, b, ...rest] = p.split(/\s*[-–]\s*/);
    const start = a ? norm(a) : null;
    const end = b ? norm(b) : null;
    if (!start || !end || rest.length) return { ranges: [], error: `„${p}“ ist keine gültige Zeitspanne (z. B. 08:00-12:00).` };
    if (toMin(end) <= toMin(start)) return { ranges: [], error: `„${p}“: Ende muss nach dem Beginn liegen.` };
    ranges.push({ start, end });
  }
  return { ranges: mergeRanges(ranges) };
}

export const formatRanges = (r: TimeRange[]) => r.map((x) => `${x.start}-${x.end}`).join(", ");

/**
 * Zieht Zeitfenster in Minuten (z. B. Sperrzeiten) von verfügbaren Bereichen ab. Ergebnis sortiert;
 * Reststücke kürzer als eine Minute entfallen.
 */
export function subtractRanges(ranges: TimeRange[], cuts: readonly { startMin: number; endMin: number }[]): TimeRange[] {
  let cur = mergeRanges(ranges).map((r) => [toMin(r.start), toMin(r.end)] as [number, number]);
  for (const c of cuts) {
    if (!(c.endMin > c.startMin)) continue;
    cur = cur.flatMap(([s, e]): [number, number][] => {
      if (c.endMin <= s || c.startMin >= e) return [[s, e]];
      const parts: [number, number][] = [];
      if (c.startMin > s) parts.push([s, c.startMin]);
      if (c.endMin < e) parts.push([c.endMin, e]);
      return parts;
    });
  }
  return cur.filter(([s, e]) => e > s).map(([s, e]) => ({ start: toHhmm(s), end: toHhmm(e) }));
}

export type AvailabilityReason = "absence" | "holiday" | "no_hours" | "block" | null;
export type Availability = {
  available: boolean;
  ranges: TimeRange[];
  reason: AvailabilityReason;
  /** Woher die Zeiten stammen: eigene Arbeitszeiten oder (falls keine gepflegt) Öffnungszeiten der Praxis */
  source: "working_hours" | "opening_hours";
  absenceKind?: string;
  holiday?: string;
  /** Arbeitszeit ohne Abzug der Sperrzeiten (für „außerhalb der Arbeitszeit“ vs. „Sperrzeit“) */
  hoursRanges?: TimeRange[];
};

export function computeAvailability(input: {
  dateIso: string;
  /** alle Arbeitszeit-Zeilen der Person (alle Wochentage) */
  hours: { weekday: number; startTime: string; endTime: string }[];
  absences: { startsOn: string; endsOn: string; kind: string }[];
  holiday?: string | null;
  /** Fallback, wenn für die Person gar keine Arbeitszeiten gepflegt sind: Öffnungszeiten der Praxis je Wochentag (practiceHours) */
  opening?: WeekHours;
  /** Sperrzeiten an diesem Tag (eigene und ganze Praxis; Minuten Berliner Ortszeit, Ende bis 1440) */
  blocks?: readonly { startMin: number; endMin: number }[];
}): Availability {
  const { dateIso, hours, absences } = input;
  const configured = hours.length > 0;
  const source = configured ? "working_hours" : "opening_hours";
  const absence = absences.find((a) => a.startsOn <= dateIso && dateIso <= a.endsOn);
  if (absence) return { available: false, ranges: [], reason: "absence", source, absenceKind: absence.kind };
  if (input.holiday) return { available: false, ranges: [], reason: "holiday", source, holiday: input.holiday };
  const wd = isoWeekday(dateIso);
  const ranges = configured
    ? mergeRanges(hours.filter((h) => h.weekday === wd).map((h) => ({ start: h.startTime, end: h.endTime })))
    : mergeRanges(hoursOnWeekday(input.opening ?? DEFAULT_WEEK, wd));
  if (ranges.length === 0) return { available: false, ranges: [], reason: "no_hours", source };
  const free = input.blocks?.length ? subtractRanges(ranges, input.blocks) : ranges;
  if (free.length === 0) return { available: false, ranges: [], reason: "block", source, hoursRanges: ranges };
  return { available: true, ranges: free, reason: null, source, hoursRanges: ranges };
}

/** Liegt ein Zeitfenster (HH:MM) vollständig in den verfügbaren Bereichen? */
export function fitsInRanges(ranges: TimeRange[], start: string, end: string): boolean {
  return ranges.some((r) => toMin(r.start) <= toMin(start) && toMin(end) <= toMin(r.end));
}
