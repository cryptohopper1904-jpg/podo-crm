/**
 * Kalender – vollständige Ansicht (Tag/Woche/Monat) und Belegungsprüfung: reine Logik ohne DB.
 * Zeiten innerhalb eines Tages als Minuten ab Mitternacht (Berliner Ortszeit).
 */

import { TZ } from "./format";

export type CalendarMode = "simple" | "full";
export type FullView = "tag" | "woche" | "monat";

/** 15-Minuten-Raster, Standard-Zeitachse 07:00–20:00 */
export const SLOT_MIN = 15;
export const DEFAULT_RANGE = { startMin: 7 * 60, endMin: 20 * 60 } as const;

export const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Montag der Woche (ISO-Woche) */
export function mondayOfIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDaysIso(iso, -((d.getUTCDay() + 6) % 7));
}

/** Monatsübersicht: ganze Wochen (Mo–So), die den Monat von `iso` abdecken (4–6 Wochen). */
export function monthWeeks(iso: string): string[][] {
  const first = `${iso.slice(0, 7)}-01`;
  const start = mondayOfIso(first);
  const month = iso.slice(0, 7);
  const weeks: string[][] = [];
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, i) => addDaysIso(start, w * 7 + i));
    if (w > 0 && week[0].slice(0, 7) !== month) break;
    weeks.push(week);
  }
  return weeks;
}

/** Erster Tag des Vor-/Folgemonats */
export function shiftMonthIso(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  return d.toISOString().slice(0, 10);
}

const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Minuten ab Mitternacht (Berlin) und Berliner Datum eines Zeitpunkts */
export function berlinParts(d: Date): { dateIso: string; min: number } {
  return { dateIso: ymd.format(d), min: toMin(hm.format(d)) };
}

/**
 * Lage eines Termins an einem Tag (Minuten, auf den Tag beschnitten). null = Termin liegt nicht an diesem Tag.
 */
export function dayInterval(startsAt: Date, endsAt: Date, dateIso: string): { startMin: number; endMin: number } | null {
  const s = berlinParts(startsAt);
  const e = berlinParts(endsAt);
  if (s.dateIso > dateIso || e.dateIso < dateIso) return null;
  const startMin = s.dateIso < dateIso ? 0 : s.min;
  const endMin = e.dateIso > dateIso ? 24 * 60 : e.min;
  if (endMin <= startMin) return s.dateIso === dateIso ? { startMin, endMin: Math.min(24 * 60, startMin + SLOT_MIN) } : null;
  return { startMin, endMin };
}

/** Zeitachse: Standard 07:00–20:00, erweitert auf volle Stunden, wenn Termine früher/später liegen. */
export function gridRange(intervals: { startMin: number; endMin: number }[], base: { startMin: number; endMin: number } = DEFAULT_RANGE) {
  let startMin: number = base.startMin;
  let endMin: number = base.endMin;
  for (const i of intervals) {
    if (i.startMin < startMin) startMin = Math.floor(i.startMin / 60) * 60;
    if (i.endMin > endMin) endMin = Math.min(24 * 60, Math.ceil(i.endMin / 60) * 60);
  }
  return { startMin, endMin };
}

export type Positioned<T> = T & { lane: number; lanes: number };

/**
 * Nebeneinander-Darstellung überlappender Termine (wie Outlook): jede Gruppe sich überlappender Termine
 * wird auf Spalten („lanes“) verteilt; `lanes` = Spaltenzahl der Gruppe.
 */
export function layoutLanes<T extends { startMin: number; endMin: number }>(items: readonly T[]): Positioned<T>[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: Positioned<T>[] = [];
  let group: Positioned<T>[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;
  const flush = () => {
    for (const g of group) g.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const it of sorted) {
    if (it.startMin >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= it.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.endMin);
    } else laneEnds[lane] = it.endMin;
    const p = { ...it, lane, lanes: 1 };
    group.push(p);
    out.push(p);
    groupEnd = Math.max(groupEnd, it.endMin);
  }
  flush();
  return out;
}

export type BusyAppointment = { id: string; startsAt: Date; endsAt: Date; status: string; therapistId: string | null };

/**
 * Belegung einer Behandler:in im Zeitraum [start, end): eigene Termine und Termine ohne Zuordnung
 * (Online-/Portal-/Telefon-Buchungen) – abgesagte zählen nicht. Gleiche Regel wie die Prüfung beim Speichern.
 */
export function findClashes<T extends BusyAppointment>(rows: readonly T[], therapistId: string | null, start: Date, end: Date, excludeId?: string): T[] {
  return rows.filter(
    (r) =>
      r.id !== excludeId &&
      r.status !== "cancelled" &&
      (r.therapistId === null || (therapistId !== null && r.therapistId === therapistId)) &&
      r.startsAt < end &&
      r.endsAt > start,
  );
}

/** Ist ein Slot [startMin, endMin) durch eines der Intervalle belegt? */
export function isBusy(intervals: readonly { startMin: number; endMin: number }[], startMin: number, endMin: number): boolean {
  return intervals.some((i) => i.startMin < endMin && i.endMin > startMin);
}

/** Liegt `dateIso` in einer Abwesenheit (Datum von–bis, inklusive)? */
export function absentOn(absences: readonly { startsOn: string; endsOn: string }[], dateIso: string): boolean {
  return absences.some((a) => a.startsOn <= dateIso && dateIso <= a.endsOn);
}

/** Lesbare Liste belegter Zeiten, z. B. „09:00–09:30 Uhr, 10:15–11:00 Uhr“ (Datum nur, wenn abweichend). */
export function describeClashes(clashes: readonly { startsAt: Date; endsAt: Date }[], dateIso?: string): string {
  return clashes
    .map((c) => {
      const s = berlinParts(c.startsAt);
      const e = berlinParts(c.endsAt);
      const day = dateIso && s.dateIso === dateIso ? "" : `${s.dateIso.slice(8, 10)}.${s.dateIso.slice(5, 7)}. `;
      return `${day}${toHhmm(s.min)}–${toHhmm(e.min)} Uhr`;
    })
    .join(", ");
}

/** Bereiche außerhalb der verfügbaren Zeitfenster (für die Schattierung „außerhalb der Arbeitszeit“) */
export function outsideRanges(ranges: readonly { start: string; end: string }[], startMin: number, endMin: number): { startMin: number; endMin: number }[] {
  const inside = ranges.map((r) => [toMin(r.start), toMin(r.end)] as const).sort((a, b) => a[0] - b[0]);
  const out: { startMin: number; endMin: number }[] = [];
  let cur = startMin;
  for (const [s, e] of inside) {
    if (e <= cur) continue;
    if (s > cur) out.push({ startMin: cur, endMin: Math.min(s, endMin) });
    cur = Math.max(cur, e);
    if (cur >= endMin) break;
  }
  if (cur < endMin) out.push({ startMin: cur, endMin });
  return out.filter((r) => r.endMin > r.startMin);
}

/** URL-Parameter → Ansicht (unbekannt → null) */
export function parseMode(v: unknown): CalendarMode | null {
  return v === "voll" ? "full" : v === "einfach" ? "simple" : null;
}
export const modeParam = (m: CalendarMode) => (m === "full" ? "voll" : "einfach");

/** URL-Parameter → Zeitraum; ohne gültige Angabe der Standard (`fallback`, siehe defaultFullView) */
export function parseFullView(v: unknown, fallback: FullView = "woche"): FullView {
  return v === "tag" || v === "woche" || v === "monat" ? v : fallback;
}

/**
 * Cookie „schmaler Bildschirm“ (< 640 px, gesetzt von viewport-default.tsx): Der Server kennt die Fensterbreite nicht,
 * soll auf dem Handy aber die Tagesansicht statt der (dort zu breiten) Woche öffnen.
 */
export const NARROW_COOKIE = "podo-schmal";
/** Breite, unter der der Kalender die Handy-Darstellung nutzt (Tailwind `sm`) */
export const NARROW_QUERY = "(max-width: 639.98px)";
export const isNarrowCookie = (v: string | undefined) => v === "1";
/** Standard-Zeitraum der vollständigen Ansicht ohne `ansicht`: Handy Tag, sonst Woche */
export const defaultFullView = (narrow: boolean): FullView => (narrow ? "tag" : "woche");

const WD_SHORT_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTH_SHORT_DE = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];

/**
 * Kurzer Titel für den Kalenderkopf auf dem Handy: „Mo 16.11.“, „9.–15. Nov.“ (Monatswechsel „30. Nov. – 6. Dez.“),
 * „Nov. 2026“. Datumsangaben als JJJJ-MM-TT (Kalendertag, keine Zeitzone).
 */
export function shortCalendarTitle(view: FullView, iso: string): string {
  const d = Number(iso.slice(8, 10));
  const m = Number(iso.slice(5, 7));
  if (view === "tag") return `${WD_SHORT_DE[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${d}.${m}.`;
  if (view === "monat") return `${MONTH_SHORT_DE[m - 1]} ${iso.slice(0, 4)}`;
  const start = mondayOfIso(iso);
  const end = addDaysIso(start, 6);
  const [sd, sm, ed, em] = [Number(start.slice(8, 10)), Number(start.slice(5, 7)), Number(end.slice(8, 10)), Number(end.slice(5, 7))];
  return sm === em ? `${sd}.–${ed}. ${MONTH_SHORT_DE[em - 1]}` : `${sd}. ${MONTH_SHORT_DE[sm - 1]} – ${ed}. ${MONTH_SHORT_DE[em - 1]}`;
}

/** Initialen für enge Spaltenköpfe („Toni Beispielkraft-Langname“ → „TB“) */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : (parts[0][1] ?? "");
  return `${first}${last}`.toUpperCase();
}

/** Gültige Uhrzeit HH:MM für Vorbelegung (sonst null) */
export function parseHhmm(v: unknown): string | null {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
}
