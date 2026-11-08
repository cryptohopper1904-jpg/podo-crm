/**
 * Terminbuchung im Kundenportal – reine Regeln (ohne DB, testbar).
 *
 * Unterschied zur anonymen Online-Buchung (/buchen): Die Identität ist über den persönlichen Portal-Link
 * nachgewiesen, deshalb wird der Termin direkt an die Akte DIESER Person gehängt (Status „geplant“).
 *
 * Regeln:
 *  - nur online buchbare Leistungen (settings.onlineBooking.serviceCodes; leer = alle aktiven Behandlungs-/
 *    Kosmetik-/Spangenleistungen, wie /buchen)
 *  - freie Zeiten der nächsten 6 Wochen: Arbeitszeiten (bzw. Öffnungszeiten), Abwesenheiten, Feiertage,
 *    belegte Termine der Praxis
 *  - Vorlaufzeit settings.onlineBooking.leadHours (Standard 2 h, wie /buchen)
 *  - optional settings.onlineBooking.maxPerDay: höchstens so viele Online-Buchungen (Portal + /buchen) je Tag
 *  - Absage/Verschieben nur bis 24 h vor dem (alten) Termin
 */
import { berlinToUtc, timeDe } from "./format";
import type { TimeRange } from "./availability";
import { PORTAL_CANCEL_HOURS } from "./portal";

export const PORTAL_BOOKING_WEEKS = 6;
export const PORTAL_BOOKING_STEP_MIN = 30;
export const DEFAULT_LEAD_HOURS = 2;
export const BOOKABLE_CATEGORIES = ["treatment", "cosmetic", "brace"] as const;
/**
 * Portal-Buchungen: Quelle „portal“ (Migration 0016/0017). external_id „portal:<uuid>“ bleibt als Kennzeichen eigener
 * Buchungen (Abgrenzung zu Nachrückern „waitlist:<link-id>“, die ebenfalls Quelle „portal“ haben) – für das Limit offener
 * Portal-Buchungen je Person.
 */
export const PORTAL_EXTERNAL_PREFIX = "portal:";

export type OnlineBookingSettings = { enabled: boolean; serviceCodes: string[]; leadHours: number; maxPerDay: number | null };

export function parseOnlineBookingSettings(settings: Record<string, unknown> | null | undefined): OnlineBookingSettings {
  const raw = ((settings ?? {}).onlineBooking ?? {}) as Record<string, unknown>;
  const lead = Number(raw.leadHours);
  const max = Number(raw.maxPerDay);
  return {
    enabled: raw.enabled !== false,
    serviceCodes: Array.isArray(raw.serviceCodes) ? raw.serviceCodes.filter((c): c is string => typeof c === "string") : [],
    leadHours: Number.isFinite(lead) && lead >= 0 && lead <= 24 * 14 ? lead : DEFAULT_LEAD_HOURS,
    maxPerDay: Number.isInteger(max) && max > 0 ? max : null,
  };
}

/** Leistung online buchbar? (aktiv, passende Kategorie, Dauer > 0, ggf. in der Freigabeliste) */
export function isBookableOnline(s: { code: string; category: string; active: boolean; durationMin: number }, cfg: Pick<OnlineBookingSettings, "serviceCodes">) {
  return (
    s.active &&
    s.durationMin > 0 &&
    (BOOKABLE_CATEGORIES as readonly string[]).includes(s.category) &&
    (!cfg.serviceCodes.length || cfg.serviceCodes.includes(s.code))
  );
}

/** Berliner Kalendertage ab `fromIso` (inklusive), `count` Stück. */
export function dayRange(fromIso: string, count: number): string[] {
  const out: string[] = [];
  const t0 = Date.parse(`${fromIso}T12:00:00Z`);
  for (let i = 0; i < count; i++) out.push(new Date(t0 + i * 86400_000).toISOString().slice(0, 10));
  return out;
}

export type Busy = { startsAt: Date; endsAt: Date; id?: string };

/**
 * Freie Startzeiten je Tag.
 * - `days`: Tage mit verfügbaren Zeitfenstern (bereits um Abwesenheiten/Feiertage bereinigt)
 * - `busy`: belegte Termine (ohne abgesagte); `excludeId` wird ignoriert (Verschieben des eigenen Termins)
 * - `onlinePerDay`: Anzahl bestehender Online-Buchungen je Tag (für maxPerDay)
 */
export function portalSlots(input: {
  days: { dateIso: string; ranges: TimeRange[] }[];
  busy: Busy[];
  durationMin: number;
  earliest: Date;
  stepMin?: number;
  maxPerDay?: number | null;
  onlinePerDay?: Map<string, number>;
  excludeId?: string;
}): { dateIso: string; slots: Date[] }[] {
  const step = (input.stepMin ?? PORTAL_BOOKING_STEP_MIN) * 60_000;
  const dur = input.durationMin * 60_000;
  const busy = input.busy.filter((b) => !input.excludeId || b.id !== input.excludeId);
  const out: { dateIso: string; slots: Date[] }[] = [];
  for (const d of input.days) {
    if (input.maxPerDay && (input.onlinePerDay?.get(d.dateIso) ?? 0) >= input.maxPerDay) {
      out.push({ dateIso: d.dateIso, slots: [] });
      continue;
    }
    const slots: Date[] = [];
    for (const r of d.ranges) {
      const start = berlinToUtc(d.dateIso, r.start).getTime();
      const end = berlinToUtc(d.dateIso, r.end).getTime();
      for (let t = start; t + dur <= end; t += step) {
        if (t < input.earliest.getTime()) continue;
        if (busy.some((b) => b.startsAt.getTime() < t + dur && b.endsAt.getTime() > t)) continue;
        slots.push(new Date(t));
      }
    }
    slots.sort((a, b) => a.getTime() - b.getTime());
    out.push({ dateIso: d.dateIso, slots: slots.filter((s, i) => i === 0 || s.getTime() !== slots[i - 1].getTime()) });
  }
  return out;
}

export const slotLabel = (d: Date) => timeDe(d);

/** Verschieben (wie Absage) nur bis 24 h vor dem bisherigen Termin; der neue Termin muss die Vorlaufzeit einhalten. */
export function rescheduleCheck(oldStart: Date, newStart: Date, opts: { now?: Date; leadHours?: number } = {}): { ok: true } | { ok: false; reason: "too_late" | "lead_time" | "same" } {
  const now = (opts.now ?? new Date()).getTime();
  if (oldStart.getTime() - now < PORTAL_CANCEL_HOURS * 3600_000) return { ok: false, reason: "too_late" };
  if (newStart.getTime() < now + (opts.leadHours ?? DEFAULT_LEAD_HOURS) * 3600_000) return { ok: false, reason: "lead_time" };
  if (newStart.getTime() === oldStart.getTime()) return { ok: false, reason: "same" };
  return { ok: true };
}

/** Frühester buchbarer Beginn. */
export const earliestStart = (now: Date, leadHours: number) => new Date(now.getTime() + leadHours * 3600_000);
