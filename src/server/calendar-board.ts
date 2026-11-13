import "server-only";
import { and, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { absences, appointments, organizations, users, workingHours, type UserPrefs } from "@/db/schema";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { computeAvailability, type TimeRange } from "@/lib/availability";
import { addDaysIso, berlinParts, findClashes, toHhmm, toMin, type CalendarMode } from "@/lib/calendar-grid";
import { resolveCalendarOptions, sanitizeStoredOptions, type CalendarOptions, type StoredCalendarOptions, type UrlOverrides } from "@/lib/calendar-options";
import { findFreeSlots, type DayWindow, type FreeSlot } from "@/lib/free-slots";
import { berlinToUtc } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { practiceHours } from "@/lib/opening-hours";
import { therapists } from "./appointments";

async function orgCalendarInfo(org: string) {
  const [o] = await db.select({ state: organizations.state, settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  return { state: (o?.state ?? "BB") as StateCode, opening: practiceHours(o?.settings) };
}

/**
 * Team, Arbeitszeiten und Abwesenheiten für die vollständige Kalenderansicht. Die Art der Abwesenheit
 * (z. B. Krankheit) wird bewusst NICHT geliefert – im Kalender steht nur „abwesend – nicht verfügbar“.
 */
export async function calendarBoard(auth: AuthContext, fromIso: string, toIso: string) {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const [team, info] = await Promise.all([therapists(auth), orgCalendarInfo(org)]);
  team.sort((a, b) => a.name.localeCompare(b.name, "de"));
  const ids = team.map((t) => t.id);
  const { hours, abs } = await withOrg(org, async (tx) => ({
    hours: ids.length
      ? await tx
          .select({ userId: workingHours.userId, weekday: workingHours.weekday, startTime: workingHours.startTime, endTime: workingHours.endTime })
          .from(workingHours)
          .where(and(eq(workingHours.organizationId, org), inArray(workingHours.userId, ids)))
      : [],
    abs: await tx
      .select({ userId: absences.userId, startsOn: absences.startsOn, endsOn: absences.endsOn })
      .from(absences)
      .where(and(eq(absences.organizationId, org), gte(absences.endsOn, fromIso), lte(absences.startsOn, toIso))),
  }));
  /** Verfügbarkeit einer Person an einem Tag (Arbeitszeiten, Abwesenheit, Feiertag) */
  const availabilityOf = (userId: string, dateIso: string) =>
    computeAvailability({
      dateIso,
      hours: hours.filter((h) => h.userId === userId),
      absences: abs.filter((a) => a.userId === userId).map((a) => ({ ...a, kind: "other" })),
      holiday: holidayOn(dateIso, info.state),
      opening: info.opening,
    });
  return { team: team.map((t) => ({ id: t.id, name: t.name, color: t.color })), absences: abs, availabilityOf, state: info.state };
}

export type SlotStatus = {
  /** belegte Zeiten derselben Behandler:in bzw. ohne Zuordnung (HH:MM) */
  clashes: { start: string; end: string; unassigned: boolean }[];
  absent: boolean;
  /** Termin liegt (teilweise) außerhalb der Arbeitszeit/Öffnungszeit – nur Hinweis */
  outsideHours: boolean;
  hours: TimeRange[];
  holiday: string | null;
};

/**
 * Belegung für das Terminformular: Überschneidungen (gleiche Regel wie beim Speichern), Abwesenheit
 * und Arbeitszeiten. Liefert nur Uhrzeiten – keine Namen oder Titel anderer Termine.
 */
export async function slotStatus(
  auth: AuthContext,
  input: { therapistId: string; dateIso: string; time: string; durationMin: number; excludeId?: string },
): Promise<SlotStatus | null> {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const board = await calendarBoard(auth, input.dateIso, input.dateIso);
  if (!board.team.some((t) => t.id === input.therapistId)) return null;
  const start = berlinToUtc(input.dateIso, input.time);
  const end = new Date(start.getTime() + input.durationMin * 60_000);
  const rows = await withOrg(org, (tx) =>
    tx
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status, therapistId: appointments.therapistId })
      .from(appointments)
      .where(
        and(
          eq(appointments.organizationId, org),
          or(eq(appointments.therapistId, input.therapistId), isNull(appointments.therapistId)),
          lt(appointments.startsAt, end),
          gte(appointments.endsAt, start),
        ),
      ),
  );
  const clashes = findClashes(rows, input.therapistId, start, end, input.excludeId).sort((a, b) => +a.startsAt - +b.startsAt);
  const av = board.availabilityOf(input.therapistId, input.dateIso);
  const s = berlinParts(start).min;
  const e = s + input.durationMin;
  const inside = av.ranges.some((r) => toMin(r.start) <= s && e <= toMin(r.end));
  return {
    clashes: clashes.map((c) => ({ start: toHhmm(berlinParts(c.startsAt).min), end: toHhmm(berlinParts(c.endsAt).min), unassigned: c.therapistId === null })),
    absent: av.reason === "absence",
    outsideHours: !inside,
    hours: av.ranges,
    holiday: av.holiday ?? null,
  };
}

/** Gewählte Kalenderansicht der Person (Standard: einfach). */
export function calendarModeOf(prefs: UserPrefs | null | undefined): CalendarMode {
  return prefs?.calendar?.mode === "full" ? "full" : "simple";
}

/** Kalenderansicht merken (users.prefs.calendar.mode) – eigene Einstellung der angemeldeten Person. */
export async function saveCalendarMode(userId: string, mode: CalendarMode): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!u) return;
    const prefs: UserPrefs = { ...(u.prefs ?? {}), calendar: { ...(u.prefs?.calendar ?? {}), mode } };
    await tx.update(users).set({ prefs }).where(eq(users.id, userId));
  });
}

/** Gespeicherte Anzeige-Optionen der Person (ungültige Werte fallen weg). */
export function storedCalendarOptionsOf(prefs: UserPrefs | null | undefined): StoredCalendarOptions {
  return sanitizeStoredOptions(prefs?.calendar?.options);
}

/** Wirksame Anzeige-Optionen: Standard je Ansicht ← gespeichert ← URL. */
export function calendarOptionsOf(prefs: UserPrefs | null | undefined, mode: CalendarMode, url: UrlOverrides = {}): CalendarOptions {
  return resolveCalendarOptions(mode, storedCalendarOptionsOf(prefs), url);
}

/** Anzeige-Optionen merken (users.prefs.calendar.options; null = Standard) – eigene Einstellung der angemeldeten Person. */
export async function saveCalendarOptions(userId: string, update: (prev: StoredCalendarOptions) => StoredCalendarOptions | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!u) return;
    const next = update(sanitizeStoredOptions(u.prefs?.calendar?.options));
    const calendar: NonNullable<UserPrefs["calendar"]> = { ...(u.prefs?.calendar ?? {}) };
    if (next && Object.keys(next).length) calendar.options = next;
    else delete calendar.options;
    const prefs: UserPrefs = { ...(u.prefs ?? {}), calendar };
    await tx.update(users).set({ prefs }).where(eq(users.id, userId));
  });
}

/** Suchzeitraum für „Freien Termin finden“ (Tage ab Startdatum) */
export const FREE_SLOT_HORIZON_DAYS = 42;

/**
 * „Freien Termin finden“: lädt Team-Verfügbarkeit (Arbeitszeiten bzw. Öffnungszeiten, Abwesenheiten, Feiertage)
 * und belegte Zeiten im Suchzeitraum und liefert die nächsten freien Zeiten. `therapistId` null = „egal“ (alle).
 * null = Behandler:in nicht gefunden.
 */
export async function searchFreeSlots(
  auth: AuthContext,
  input: { fromIso: string; durationMin: number; therapistId: string | null; limit?: number; now?: Date },
): Promise<FreeSlot[] | null> {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const now = input.now ?? new Date();
  const todayIso = berlinParts(now).dateIso;
  const fromIso = input.fromIso < todayIso ? todayIso : input.fromIso;
  const toIso = addDaysIso(fromIso, FREE_SLOT_HORIZON_DAYS - 1);
  const board = await calendarBoard(auth, fromIso, toIso);
  const ids = board.team.filter((t) => !input.therapistId || t.id === input.therapistId).map((t) => t.id);
  if (!ids.length) return input.therapistId ? null : [];
  // Vorrang bei „egal“: angemeldete Person zuerst, dann alphabetisch (Reihenfolge aus calendarBoard)
  ids.sort((a, b) => Number(b === auth.user.id) - Number(a === auth.user.id));
  const from = berlinToUtc(fromIso, "00:00");
  const to = berlinToUtc(addDaysIso(toIso, 1), "00:00");
  const busy = await withOrg(org, (tx) =>
    tx
      .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status, therapistId: appointments.therapistId })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), or(inArray(appointments.therapistId, ids), isNull(appointments.therapistId)), lt(appointments.startsAt, to), gte(appointments.endsAt, from))),
  );
  const windows: DayWindow[] = [];
  for (let i = 0; i < FREE_SLOT_HORIZON_DAYS; i++) {
    const dateIso = addDaysIso(fromIso, i);
    for (const id of ids) {
      const av = board.availabilityOf(id, dateIso);
      if (av.available) windows.push({ dateIso, therapistId: id, ranges: av.ranges });
    }
  }
  return findFreeSlots({ windows, busy, therapistIds: ids, durationMin: input.durationMin, now, limit: input.limit ?? 8 });
}
