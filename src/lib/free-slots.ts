/**
 * „Freien Termin finden“ (rein, ohne DB): nächste freie Zeiten ab einem Startdatum unter Beachtung von
 * Arbeitszeiten/Öffnungszeiten, Abwesenheiten, Feiertagen (über die Tagesfenster) und bestehenden Terminen.
 */

import { addDaysIso, toHhmm, toMin } from "./calendar-grid";
import { berlinToUtc } from "./format";

export type DayWindow = { dateIso: string; therapistId: string; ranges: { start: string; end: string }[] };
export type BusyRow = { startsAt: Date; endsAt: Date; status: string; therapistId: string | null };
export type FreeSlot = { dateIso: string; time: string; therapistId: string; startsAt: Date };

/** Schnellauswahl „ab wann“ → Startdatum (Berliner Datum) */
export const START_CHOICES = [
  ["sofort", "sofort"],
  ["morgen", "ab morgen"],
  ["1w", "in 1 Woche"],
  ["2w", "in 2 Wochen"],
  ["4w", "in 4 Wochen"],
  ["6w", "in 6 Wochen"],
] as const;
export type StartChoice = (typeof START_CHOICES)[number][0];

export function startDateFor(choice: StartChoice, todayIso: string): string {
  const days = { sofort: 0, morgen: 1, "1w": 7, "2w": 14, "4w": 28, "6w": 42 }[choice];
  return addDaysIso(todayIso, days);
}

/**
 * Sucht freie Zeiten im Raster `stepMin` (Standard 15 Min).
 * - nur innerhalb der Tagesfenster (`windows`; fehlt ein Fenster → an dem Tag nicht verfügbar)
 * - keine Überschneidung mit nicht abgesagten Terminen derselben Behandler:in oder Terminen ohne Zuordnung
 * - nicht in der Vergangenheit (`now`)
 * - bei mehreren Behandler:innen („egal“) je Startzeit nur ein Vorschlag (erste freie Person in `therapistIds`-Reihenfolge)
 */
export function findFreeSlots(input: {
  windows: readonly DayWindow[];
  busy: readonly BusyRow[];
  therapistIds: readonly string[];
  durationMin: number;
  now: Date;
  limit?: number;
  stepMin?: number;
}): FreeSlot[] {
  const { durationMin, now } = input;
  const limit = input.limit ?? 8;
  const step = input.stepMin ?? 15;
  const live = input.busy.filter((b) => b.status !== "cancelled");
  const order = new Map(input.therapistIds.map((id, i) => [id, i]));
  const dates = [...new Set(input.windows.map((w) => w.dateIso))].sort();
  const out: FreeSlot[] = [];
  for (const dateIso of dates) {
    const byStart = new Map<number, FreeSlot>();
    for (const w of input.windows) {
      if (w.dateIso !== dateIso || !order.has(w.therapistId)) continue;
      const own = live.filter((b) => b.therapistId === null || b.therapistId === w.therapistId);
      for (const r of w.ranges) {
        const rs = toMin(r.start), re = toMin(r.end);
        // Startzeiten auf das Raster ausrichten
        for (let m = Math.ceil(rs / step) * step; m + durationMin <= re; m += step) {
          const prev = byStart.get(m);
          if (prev && order.get(prev.therapistId)! <= order.get(w.therapistId)!) continue;
          const startsAt = berlinToUtc(dateIso, toHhmm(m));
          if (startsAt < now) continue;
          const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
          if (own.some((b) => b.startsAt < endsAt && b.endsAt > startsAt)) continue;
          byStart.set(m, { dateIso, time: toHhmm(m), therapistId: w.therapistId, startsAt });
        }
      }
    }
    for (const m of [...byStart.keys()].sort((a, b) => a - b)) {
      out.push(byStart.get(m)!);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
