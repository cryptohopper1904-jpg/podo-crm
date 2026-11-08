/**
 * KI-Telefon: Minutenverbrauch je Kalendermonat (Europe/Berlin) aus voice_calls.duration_sec.
 * Reine Funktionen – die Datenbankabfrage liegt in src/server/voice.ts.
 */
import { berlinDateIso, berlinToUtc } from "./format";

/** Ab diesem Anteil wird gewarnt (Balken gelb, Hinweis für die Inhaberin/den Inhaber). */
export const VOICE_USAGE_WARN_PERCENT = 80;

/** „YYYY-MM“ des Zeitpunkts in Berlin */
export const berlinMonth = (now: Date = new Date()) => berlinDateIso(now).slice(0, 7);

export function isMonth(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** UTC-Grenzen eines Kalendermonats in Berlin: [from, to) */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: berlinToUtc(`${month}-01`, "00:00"), to: berlinToUtc(`${next}-01`, "00:00") };
}

/** Vormonate inkl. des aktuellen Monats, neuester zuerst */
export function recentMonths(now: Date, n: number): string[] {
  const [y, m] = berlinMonth(now).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const t = y * 12 + (m - 1) - i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

export type VoiceUsage = {
  usedSeconds: number;
  /** angefangene Minuten, aufgerundet */
  usedMinutes: number;
  includedMinutes: number;
  remainingMinutes: number;
  /** 0–100 (gedeckelt) */
  percent: number;
  /** Kontingent ausgeschöpft → keine Buchungen mehr, nur Rückrufbitten */
  exceeded: boolean;
  warn: boolean;
};

export function voiceUsage(usedSeconds: number, includedMinutes: number): VoiceUsage {
  const sec = Math.max(0, Math.round(Number.isFinite(usedSeconds) ? usedSeconds : 0));
  const usedMinutes = Math.ceil(sec / 60);
  const included = Math.max(0, Math.floor(includedMinutes));
  const percent = included > 0 ? Math.min(100, Math.round((usedMinutes / included) * 100)) : 100;
  const exceeded = usedMinutes >= included;
  return {
    usedSeconds: sec,
    usedMinutes,
    includedMinutes: included,
    remainingMinutes: Math.max(0, included - usedMinutes),
    percent,
    exceeded,
    warn: !exceeded && percent >= VOICE_USAGE_WARN_PERCENT,
  };
}

export type VoiceMonthRow = { month: string; calls: number; booked: number; callbacks: number; totalSec: number; avgSec: number | null };

/** Monatsbericht aus Einzelanrufen (rein; Ausgang laut voice_calls.outcome). */
export function voiceMonthReport(calls: { startedAt: Date; durationSec: number | null; outcome: string | null }[], months: string[]): VoiceMonthRow[] {
  const rows = new Map(months.map((m) => [m, { month: m, calls: 0, booked: 0, callbacks: 0, totalSec: 0, timed: 0 }]));
  for (const c of calls) {
    const r = rows.get(berlinMonth(c.startedAt));
    if (!r) continue;
    r.calls++;
    if (c.outcome === "booked" || c.outcome === "rescheduled") r.booked++;
    if (c.outcome === "callback") r.callbacks++;
    if (c.durationSec !== null && c.durationSec >= 0) {
      r.totalSec += c.durationSec;
      r.timed++;
    }
  }
  return months.map((m) => {
    const r = rows.get(m)!;
    return { month: r.month, calls: r.calls, booked: r.booked, callbacks: r.callbacks, totalSec: r.totalSec, avgSec: r.timed ? Math.round(r.totalSec / r.timed) : null };
  });
}
