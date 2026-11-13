/**
 * Kalender – Termine per Ziehen verschieben (vollständige Ansicht): reine Raster- und Positionslogik ohne DOM/DB.
 * Zeiten innerhalb eines Tages als Minuten ab Mitternacht (Berliner Ortszeit); der Zeitpunkt selbst wird immer
 * über berlinToUtc gebildet – so stimmen Sommer-/Winterzeit-Tage.
 */

import { appointmentEditLock } from "./appointment-edit";
import { berlinParts, SLOT_MIN, toHhmm } from "./calendar-grid";
import { berlinToUtc } from "./format";

const DAY_MIN = 24 * 60;
/** Gleiche Grenze wie beim Verschieben über das Formular (rescheduleAppointment) */
export const MAX_DURATION_MIN = 480;
export const MIN_DURATION_MIN = 5;
const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Auf das Raster runden (Standard 15 Minuten) */
export const snapMin = (min: number, step = SLOT_MIN) => Math.round(min / step) * step;

/** Dauer in ganzen Minuten (echte Zeitspanne – auch über die Zeitumstellung hinweg) */
export const durationOf = (startsAt: Date, endsAt: Date) => Math.max(1, Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000));

/**
 * Neue Startminute beim Ziehen in der Zeitachse: Zeigerposition in der Spalte (px ab Spaltenoberkante) minus
 * Griffversatz, aufs Raster gerundet und so begrenzt, dass der Termin in der sichtbaren Zeitachse bleibt.
 */
export function dropStartMin(p: { offsetPx: number; grabMin: number; pxPerMin: number; rangeStart: number; rangeEnd: number; durationMin: number; step?: number }): number {
  const raw = p.rangeStart + p.offsetPx / p.pxPerMin - p.grabMin;
  const snapped = snapMin(raw, p.step);
  const lo = Math.max(0, p.rangeStart);
  const hi = Math.min(DAY_MIN, p.rangeEnd) - Math.min(p.durationMin, DAY_MIN);
  return clamp(snapped, lo, hi);
}

/** Neue Dauer beim Ziehen am unteren Rand (mindestens ein Rasterschritt, höchstens 8 Stunden, nicht über Mitternacht). */
export function resizeDuration(p: { offsetPx: number; pxPerMin: number; rangeStart: number; startMin: number; step?: number }): number {
  const step = p.step ?? SLOT_MIN;
  const end = snapMin(p.rangeStart + p.offsetPx / p.pxPerMin, step);
  return clamp(end - p.startMin, step, Math.min(MAX_DURATION_MIN, DAY_MIN - p.startMin));
}

/**
 * Echte Dauer in Minuten zwischen zwei Uhrzeiten (Minuten ab Mitternacht) an einem Berliner Tag – am Tag der
 * Zeitumstellung weicht sie von der Differenz der Uhrzeiten ab (Sommerzeit −60, Winterzeit +60).
 * Liegt eine Uhrzeit in der Lücke der Sommerzeit-Umstellung, gilt die Differenz der Uhrzeiten.
 */
export function realDuration(dateIso: string, startMin: number, endMin: number): number {
  const s = localSlotToUtc(dateIso, startMin);
  const e = endMin >= DAY_MIN ? null : localSlotToUtc(dateIso, endMin);
  return s && e ? durationOf(s, e) : endMin - startMin;
}

/** Spalte unter dem Zeiger (Spaltenwechsel Tag ↔ Tag bzw. Behandler:in ↔ Behandler:in); -1 = keine */
export function columnIndexAt(cols: readonly { left: number; right: number }[], x: number): number {
  return cols.findIndex((c) => x >= c.left && x < c.right);
}

/** Zeitpunkt aus Berliner Datum + Minuten. In der Lücke der Sommerzeit-Umstellung (02:00–03:00) gibt es die Zeit nicht → null. */
export function localSlotToUtc(dateIso: string, min: number): Date | null {
  if (min < 0 || min >= DAY_MIN) return null;
  const d = berlinToUtc(dateIso, toHhmm(min));
  const back = berlinParts(d);
  return back.dateIso === dateIso && back.min === min ? d : null;
}

/** Monatsansicht: an einen anderen Tag ziehen, die Uhrzeit bleibt (Berliner Ortszeit). */
export function moveToDay(startsAt: Date, dateIso: string): Date | null {
  return localSlotToUtc(dateIso, berlinParts(startsAt).min);
}

/** Anzeige im Geisterbild und in der Ansage, z. B. „Di 10:30–11:10“ (Ende an anderem Tag: „Di 23:30–Mi 00:30“). */
export function moveLabel(startsAt: Date, endsAt: Date): string {
  const s = berlinParts(startsAt);
  const e = berlinParts(endsAt);
  const wd = (iso: string) => WD_SHORT[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7];
  return `${wd(s.dateIso)} ${toHhmm(s.min)}–${e.dateIso === s.dateIso ? "" : `${wd(e.dateIso)} `}${toHhmm(e.min)}`;
}

/** Lange Ansage für Bildschirmleser, z. B. „Di 17.11. 10:30–11:10 Uhr“ */
export function moveLabelLong(startsAt: Date, endsAt: Date): string {
  const s = berlinParts(startsAt);
  const label = moveLabel(startsAt, endsAt);
  const cut = label.indexOf(" ");
  const [wd, rest] = [label.slice(0, cut), label.slice(cut + 1)];
  return `${wd} ${Number(s.dateIso.slice(8, 10))}.${Number(s.dateIso.slice(5, 7))}. ${rest} Uhr`;
}

/** Automatisches Scrollen am Rand: px je Bild (negativ = nach oben/links), 0 = nicht scrollen. */
export function autoScrollDelta(pos: number, start: number, end: number, edge = 48, max = 18): number {
  if (end - start < edge * 3) return 0;
  if (pos < start + edge) return -Math.ceil(max * Math.min(1, (start + edge - pos) / edge));
  if (pos > end - edge) return Math.ceil(max * Math.min(1, (pos - (end - edge)) / edge));
  return 0;
}

export type DragLockInput = {
  source: string;
  status: string;
  therapistId: string | null;
  startsAt: Date;
  endsAt: Date;
  fromCalendarFeed: boolean;
  billed: boolean;
};

/**
 * Darf der Termin im Kalender gezogen werden? null = ja, sonst der Hinweis, warum nicht. (Ohne Schreibrecht,
 * im Support-Lesemodus und im Nur-Lesen-Modus gibt es gar keinen Griff – das prüft die Seite vorher.)
 * Grundlage ist dieselbe Sperre wie beim Formular (appointmentEditLock: Doctolib, Kalender-Abo, abgerechnet, abgesagt);
 * zusätzlich nicht per Ziehen (serverseitig ebenso gesperrt, forDrag): erledigte und nicht erschienene Termine,
 * Termine ohne Behandler:in; außerdem sehr kurze (< 5 min) und sehr lange Termine (Formular „Ändern“).
 */
export function dragLock(a: DragLockInput): string | null {
  const lock = appointmentEditLock(a, a.fromCalendarFeed, a.billed);
  if (lock) return lock.message;
  if (a.status === "done") return "Erledigte Termine werden nicht per Ziehen verschoben – bei Bedarf über „Termin öffnen → Datum und Uhrzeit ändern“.";
  if (a.status === "no_show") return "Nicht erschienene Termine werden nicht per Ziehen verschoben – bitte einen neuen Termin anlegen.";
  if (!a.therapistId) return "Termin ohne Behandler:in – bitte über „Termin öffnen → Datum und Uhrzeit ändern“ zuordnen.";
  if (durationOf(a.startsAt, a.endsAt) < MIN_DURATION_MIN) return "Sehr kurze Termine (unter 5 Minuten) bitte über „Termin öffnen → Datum und Uhrzeit ändern“ verschieben.";
  if (durationOf(a.startsAt, a.endsAt) > MAX_DURATION_MIN) return "Sehr lange Termine bitte über „Termin öffnen → Datum und Uhrzeit ändern“ verschieben.";
  return null;
}
