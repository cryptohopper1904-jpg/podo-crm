import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, like, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg, type Tx } from "@/db";
import { absences, appointmentServices, appointments, messages, organizations, patients, services, workingHours } from "@/db/schema";
import { audit } from "@/lib/audit";
import { computeAvailability, mergeRanges, type TimeRange } from "@/lib/availability";
import { berlinDateIso, berlinToUtc, dateDe, timeDe } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { assertEntitled, EntitlementError } from "@/lib/plans";
import { canCancelOnline, type PortalLink } from "@/lib/portal";
import {
  dayRange,
  earliestStart,
  isBookableOnline,
  parseOnlineBookingSettings,
  PORTAL_BOOKING_WEEKS,
  PORTAL_EXTERNAL_PREFIX,
  portalSlots,
  rescheduleCheck,
  type OnlineBookingSettings,
} from "@/lib/portal-booking";
import { createRateLimiter } from "@/lib/rate-limit";
import { bookableStaff } from "./staff";
import { isDeceased } from "@/lib/patient-deceased";

/** Drosselung je Person (zusätzlich zur IP-Drosselung des Portals): Buchen/Verschieben. */
export const portalBookingLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 6 });
/** Höchstens so viele künftige, selbst gebuchte Portal-Termine je Person (gegen „Blocken“ von Zeiten). */
export const MAX_OPEN_PORTAL_BOOKINGS = 3;

type OrgRow = {
  id: string;
  name: string;
  phone: string | null;
  state: string;
  settings: Record<string, unknown>;
  billing: { plan: string; subscriptionStatus: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null; seats: number };
};

async function loadOrg(org: string): Promise<OrgRow | null> {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, org));
  if (!o) return null;
  return {
    id: o.id,
    name: o.name,
    phone: o.phone,
    state: o.state,
    settings: (o.settings ?? {}) as Record<string, unknown>,
    billing: { plan: o.plan, subscriptionStatus: o.subscriptionStatus, trialEndsAt: o.trialEndsAt, currentPeriodEnd: o.currentPeriodEnd, seats: o.seats },
  };
}

const openingOf = (settings: Record<string, unknown>): TimeRange => {
  const o = (settings.opening ?? {}) as { from?: string; to?: string };
  return { start: o.from ?? "08:00", end: o.to ?? "18:00" };
};

/**
 * Verfügbare Zeitfenster des Teams je Tag (Arbeitszeiten, Abwesenheiten, Feiertage; ohne gepflegte
 * Arbeitszeiten Mo–Fr Öffnungszeiten). Lädt alles in zwei Abfragen statt je Tag und Person.
 */
export async function teamDayRanges(o: Pick<OrgRow, "id" | "state" | "settings">, days: string[]): Promise<{ dateIso: string; ranges: TimeRange[] }[]> {
  if (!days.length) return [];
  const org = o.id;
  const staff = await bookableStaff(org);
  const ids = staff.map((s) => s.id);
  const opening = openingOf(o.settings);
  const { hours, abs } = await withOrg(org, async (tx) => ({
    hours: ids.length
      ? await tx
          .select({ userId: workingHours.userId, weekday: workingHours.weekday, startTime: workingHours.startTime, endTime: workingHours.endTime })
          .from(workingHours)
          .where(and(eq(workingHours.organizationId, org), inArray(workingHours.userId, ids)))
      : [],
    abs: ids.length
      ? await tx
          .select({ userId: absences.userId, startsOn: absences.startsOn, endsOn: absences.endsOn, kind: absences.kind })
          .from(absences)
          .where(and(eq(absences.organizationId, org), inArray(absences.userId, ids), lte(absences.startsOn, days[days.length - 1]), gte(absences.endsOn, days[0])))
      : [],
  }));
  return days
    .map((d) => {
      const holiday = holidayOn(d, o.state as StateCode);
      const ranges = staff.length
        ? mergeRanges(
            staff.flatMap(
              (s) =>
                computeAvailability({ dateIso: d, hours: hours.filter((h) => h.userId === s.id), absences: abs.filter((a) => a.userId === s.id), holiday, opening }).ranges,
            ),
          )
        : computeAvailability({ dateIso: d, hours: [], absences: [], holiday, opening }).ranges;
      return { dateIso: d, ranges };
    })
    .filter((d) => d.ranges.length > 0);
}

/** Belegte Zeiten (ohne Abgesagte) + Online-Buchungen je Tag im Zeitraum. */
async function busyBetween(tx: Tx, org: string, from: Date, to: Date) {
  const rows = await tx
    .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status, source: appointments.source })
    .from(appointments)
    .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, to), gte(appointments.endsAt, from)));
  const busy = rows.filter((r) => r.status !== "cancelled");
  const onlinePerDay = new Map<string, number>();
  for (const r of busy) if (r.source === "online" || r.source === "portal") onlinePerDay.set(berlinDateIso(r.startsAt), (onlinePerDay.get(berlinDateIso(r.startsAt)) ?? 0) + 1);
  return { busy, onlinePerDay };
}

const windowDays = (now: Date) => dayRange(berlinDateIso(now), PORTAL_BOOKING_WEEKS * 7 + 1);

/** Freie Startzeiten für eine Dauer (alle Tage des Buchungsfensters oder nur `onlyDay`). */
export async function portalFreeSlots(
  o: Pick<OrgRow, "id" | "state" | "settings">,
  input: { durationMin: number; now?: Date; onlyDay?: string; excludeId?: string; cfg?: OnlineBookingSettings },
) {
  const now = input.now ?? new Date();
  const cfg = input.cfg ?? parseOnlineBookingSettings(o.settings);
  const all = windowDays(now);
  const days = await teamDayRanges(o, input.onlyDay ? all.filter((d) => d === input.onlyDay) : all);
  if (!days.length) return [];
  const from = berlinToUtc(days[0].dateIso, "00:00");
  const to = new Date(berlinToUtc(days[days.length - 1].dateIso, "00:00").getTime() + 26 * 3600_000);
  const { busy, onlinePerDay } = await withOrg(o.id, (tx) => busyBetween(tx, o.id, from, to));
  return portalSlots({ days, busy, durationMin: input.durationMin, earliest: earliestStart(now, cfg.leadHours), maxPerDay: cfg.maxPerDay, onlinePerDay, excludeId: input.excludeId });
}

async function bookableServicesFor(o: OrgRow, cfg: OnlineBookingSettings) {
  const rows = await withOrg(o.id, (tx) =>
    tx
      .select({ id: services.id, code: services.code, name: services.name, priceCents: services.priceCents, durationMin: services.durationMin, category: services.category, active: services.active })
      .from(services)
      .where(eq(services.organizationId, o.id))
      .orderBy(asc(services.name)),
  );
  return rows.filter((s) => isBookableOnline(s, cfg));
}

function bookingBlocked(o: OrgRow): string | null {
  const cfg = parseOnlineBookingSettings(o.settings);
  if (!cfg.enabled) return "Die Online-Buchung ist in dieser Praxis derzeit ausgeschaltet.";
  try {
    assertEntitled(o.billing, "portal");
  } catch (e) {
    if (e instanceof EntitlementError) return "Die Online-Buchung ist derzeit nicht verfügbar.";
    throw e;
  }
  return null;
}

export type PortalBookingOptions = {
  practice: { name: string; phone: string | null };
  blocked: string | null;
  services: { id: string; name: string; durationMin: number; priceCents: number }[];
  /** je Dauer: Tage mit freien Startzeiten (ISO) */
  days: { date: string; slots: Record<number, string[]> }[];
  reschedule: { id: string; startsAt: Date; durationMin: number; services: string[] } | null;
};

/** Daten für /portal/buchen (optional: eigenen Termin verschieben). */
export async function portalBookingOptions(link: PortalLink, opts: { rescheduleId?: string | null; now?: Date } = {}): Promise<PortalBookingOptions | null> {
  const o = await loadOrg(link.organizationId);
  if (!o) return null;
  const now = opts.now ?? new Date();
  const cfg = parseOnlineBookingSettings(o.settings);
  const practice = { name: o.name, phone: o.phone };
  const blocked = bookingBlocked(o);
  if (blocked) return { practice, blocked, services: [], days: [], reschedule: null };
  let reschedule: PortalBookingOptions["reschedule"] = null;
  if (opts.rescheduleId) {
    if (!z.uuid().safeParse(opts.rescheduleId).success) return { practice, blocked: "Termin nicht gefunden.", services: [], days: [], reschedule: null };
    const r = await withOrg(o.id, async (tx) => {
      const [a] = await tx
        .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
        .from(appointments)
        .where(and(eq(appointments.organizationId, o.id), eq(appointments.id, opts.rescheduleId!), eq(appointments.patientId, link.patientId)));
      if (!a || (a.status !== "planned" && a.status !== "confirmed")) return null;
      const svc = await tx
        .select({ name: services.name })
        .from(appointmentServices)
        .innerJoin(services, eq(services.id, appointmentServices.serviceId))
        .where(and(eq(appointmentServices.organizationId, o.id), eq(appointmentServices.appointmentId, a.id)));
      return { id: a.id, startsAt: a.startsAt, durationMin: Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000), services: svc.map((s) => s.name) };
    });
    if (!r) return { practice, blocked: "Termin nicht gefunden oder bereits abgesagt.", services: [], days: [], reschedule: null };
    if (!canCancelOnline(r.startsAt, now))
      return { practice, blocked: `Verschieben ist nur bis 24 Stunden vor dem Termin möglich. Bitte rufen Sie uns an${o.phone ? `: ${o.phone}` : ""}.`, services: [], days: [], reschedule: null };
    reschedule = r;
  }
  const svc = reschedule ? [] : await bookableServicesFor(o, cfg);
  const durations = reschedule ? [reschedule.durationMin] : [...new Set(svc.map((s) => s.durationMin))];
  const byDay = new Map<string, Record<number, string[]>>();
  for (const dur of durations) {
    // nacheinander (keine parallelen Transaktionen)
    const days = await portalFreeSlots(o, { durationMin: dur, now, cfg, excludeId: reschedule?.id });
    for (const d of days) {
      const rec = byDay.get(d.dateIso) ?? {};
      rec[dur] = d.slots.map((s) => s.toISOString());
      byDay.set(d.dateIso, rec);
    }
  }
  return {
    practice,
    blocked: null,
    services: svc.map(({ id, name, durationMin, priceCents }) => ({ id, name, durationMin, priceCents })),
    days: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, slots]) => ({ date, slots })),
    reschedule,
  };
}

export type PortalBookResult = { ok: true; message: string; appointmentId: string } | { ok: false; error: string };

const TAKEN = "Dieser Termin wurde gerade vergeben. Bitte wählen Sie eine andere Zeit.";

const parseStart = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? null : d;
};

/** Ist `start` (exakt) ein freier Startzeitpunkt des Buchungsfensters? */
async function isFreeSlot(o: OrgRow, start: Date, durationMin: number, now: Date, excludeId?: string) {
  const day = berlinDateIso(start);
  const days = await portalFreeSlots(o, { durationMin, now, onlyDay: day, excludeId });
  return days.some((d) => d.slots.some((s) => s.getTime() === start.getTime()));
}

/** Überschneidung mit einem nicht abgesagten Termin (innerhalb der Buchungssperre prüfen). */
export async function clashes(tx: Tx, org: string, start: Date, end: Date, excludeId?: string) {
  const rows = await tx
    .select({ id: appointments.id, status: appointments.status, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(and(eq(appointments.organizationId, org), lt(appointments.startsAt, end), gte(appointments.endsAt, start)));
  return rows.some((r) => r.id !== excludeId && r.status !== "cancelled" && r.startsAt < end && r.endsAt > start);
}

export async function overDayLimit(tx: Tx, org: string, cfg: OnlineBookingSettings, start: Date) {
  if (!cfg.maxPerDay) return false;
  const day = berlinDateIso(start);
  const from = berlinToUtc(day, "00:00");
  const { onlinePerDay } = await busyBetween(tx, org, from, new Date(from.getTime() + 26 * 3600_000));
  return (onlinePerDay.get(day) ?? 0) >= cfg.maxPerDay;
}

/** Buchungssperre je Praxis – gemeinsam für /buchen, Portal, Telefon, Warteliste und interne Terminanlage. */
export const lockBooking = (tx: Tx, org: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"book:" + org}, 0))`);

/**
 * Buchung durch die (über den Portal-Link verifizierte) Person: Termin an IHRE Akte, Status „geplant“,
 * Nachricht in den Posteingang. Gleiche Sperre wie /buchen und der Telefonagent → keine Doppelbelegung.
 */
export async function bookPortalAppointment(link: PortalLink, input: { serviceId: string; startsAt: string }, now = new Date()): Promise<PortalBookResult> {
  const org = link.organizationId;
  if (!z.uuid().safeParse(input.serviceId).success) return { ok: false, error: "Bitte eine Leistung wählen." };
  const start = parseStart(input.startsAt);
  if (!start) return { ok: false, error: "Bitte eine Uhrzeit wählen." };
  const o = await loadOrg(org);
  if (!o) return { ok: false, error: "Praxis nicht gefunden." };
  const blocked = bookingBlocked(o);
  if (blocked) return { ok: false, error: blocked };
  const cfg = parseOnlineBookingSettings(o.settings);
  const svc = (await bookableServicesFor(o, cfg)).find((s) => s.id === input.serviceId);
  if (!svc) return { ok: false, error: "Diese Leistung ist online nicht buchbar." };
  if (!(await isFreeSlot(o, start, svc.durationMin, now))) return { ok: false, error: TAKEN };
  const end = new Date(start.getTime() + svc.durationMin * 60_000);

  const res = await withOrg(org, async (tx): Promise<PortalBookResult> => {
    await lockBooking(tx, org);
    const [p] = await tx.select({ archivedAt: patients.archivedAt, extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    if (!p || p.archivedAt || isDeceased(p.extra)) return { ok: false, error: "Buchung nicht möglich. Bitte wenden Sie sich an die Praxis." };
    const open = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.organizationId, org),
          eq(appointments.patientId, link.patientId),
          eq(appointments.source, "portal"),
          like(appointments.externalId, `${PORTAL_EXTERNAL_PREFIX}%`),
          gte(appointments.startsAt, now),
          inArray(appointments.status, ["planned", "confirmed"]),
        ),
      );
    if (open.length >= MAX_OPEN_PORTAL_BOOKINGS) return { ok: false, error: `Sie haben bereits ${open.length} online gebuchte Termine. Für weitere Termine rufen Sie uns bitte an.` };
    if (await clashes(tx, org, start, end)) return { ok: false, error: TAKEN };
    if (await overDayLimit(tx, org, cfg, start)) return { ok: false, error: "An diesem Tag sind keine Online-Termine mehr frei. Bitte wählen Sie einen anderen Tag." };
    const [a] = await tx
      .insert(appointments)
      .values({
        organizationId: org,
        patientId: link.patientId,
        startsAt: start,
        endsAt: end,
        status: "planned",
        source: "portal",
        externalId: `${PORTAL_EXTERNAL_PREFIX}${randomUUID()}`,
        title: svc.name,
        notes: "Gebucht über das Patientenportal (Identität über den persönlichen Portal-Link).",
      })
      .returning({ id: appointments.id });
    await tx.insert(appointmentServices).values({ organizationId: org, appointmentId: a.id, serviceId: svc.id });
    await tx.insert(messages).values({
      organizationId: org,
      patientId: link.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Neue Buchung über das Patientenportal",
      body: `Über das Patientenportal gebucht: ${svc.name} am ${dateDe(start)} um ${timeDe(start)} Uhr. Der Termin ist der Akte zugeordnet (Status „geplant“) – bitte bei Bedarf bestätigen.`,
      status: "new",
      threadKey: `portal:${link.patientId}`,
    });
    return { ok: true, appointmentId: a.id, message: `Ihr Termin am ${dateDe(start)} um ${timeDe(start)} Uhr ist gebucht. Sie finden ihn unter „Ihre nächsten Termine“.` };
  });
  if (res.ok) await audit({ organizationId: org, action: "portal.appointment_book", entity: "appointment", entityId: res.appointmentId, meta: { serviceId: svc.id } });
  return res;
}

export type PortalRescheduleResult = { ok: true; message: string; appointmentId: string; cancelledId: string } | { ok: false; error: string; phone?: string | null };

/**
 * Verschieben = alten Termin absagen + neuen Termin (gleiche Leistungen, gleiche Dauer) anlegen – atomar,
 * unter derselben Buchungssperre. Nur bis 24 h vor dem alten Termin. Der frei gewordene Termin geht danach
 * an die Warteliste (siehe ./waitlist).
 */
export async function reschedulePortalAppointment(link: PortalLink, input: { appointmentId: string; startsAt: string }, now = new Date()): Promise<PortalRescheduleResult> {
  const org = link.organizationId;
  if (!z.uuid().safeParse(input.appointmentId).success) return { ok: false, error: "Termin nicht gefunden." };
  const start = parseStart(input.startsAt);
  if (!start) return { ok: false, error: "Bitte eine neue Uhrzeit wählen." };
  const o = await loadOrg(org);
  if (!o) return { ok: false, error: "Praxis nicht gefunden." };
  const blocked = bookingBlocked(o);
  if (blocked) return { ok: false, error: blocked };
  const cfg = parseOnlineBookingSettings(o.settings);
  const [cur] = await withOrg(org, (tx) =>
    tx
      .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId), eq(appointments.patientId, link.patientId))),
  );
  if (!cur) return { ok: false, error: "Termin nicht gefunden." };
  const durationMin = Math.round((cur.endsAt.getTime() - cur.startsAt.getTime()) / 60_000);
  if (!(await isFreeSlot(o, start, durationMin, now, input.appointmentId))) return { ok: false, error: TAKEN };

  const res = await withOrg(org, async (tx): Promise<PortalRescheduleResult> => {
    await lockBooking(tx, org);
    const [p] = await tx.select({ archivedAt: patients.archivedAt, extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, link.patientId)));
    if (!p || p.archivedAt || isDeceased(p.extra)) return { ok: false, error: "Verschieben nicht möglich. Bitte wenden Sie sich an die Praxis." };
    const [a] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId), eq(appointments.patientId, link.patientId)))
      .for("update");
    if (!a || (a.status !== "planned" && a.status !== "confirmed")) return { ok: false, error: "Termin nicht gefunden oder bereits abgesagt." };
    const check = rescheduleCheck(a.startsAt, start, { now, leadHours: cfg.leadHours });
    if (!check.ok) {
      if (check.reason === "too_late") return { ok: false, error: "Verschieben ist nur bis 24 Stunden vor dem Termin möglich. Bitte rufen Sie uns an.", phone: o.phone };
      if (check.reason === "same") return { ok: false, error: "Bitte eine andere Uhrzeit wählen." };
      return { ok: false, error: "Bitte einen späteren Termin wählen." };
    }
    const end = new Date(start.getTime() + (a.endsAt.getTime() - a.startsAt.getTime()));
    if (await clashes(tx, org, start, end, a.id)) return { ok: false, error: TAKEN };
    if (berlinDateIso(start) !== berlinDateIso(a.startsAt) && (await overDayLimit(tx, org, cfg, start))) return { ok: false, error: "An diesem Tag sind keine Online-Termine mehr frei." };
    const svc = await tx
      .select({ serviceId: appointmentServices.serviceId, quantity: appointmentServices.quantity })
      .from(appointmentServices)
      .where(and(eq(appointmentServices.organizationId, org), eq(appointmentServices.appointmentId, a.id)));
    await tx.update(appointments).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, a.id)));
    const [n] = await tx
      .insert(appointments)
      .values({
        organizationId: org,
        locationId: a.locationId,
        patientId: link.patientId,
        therapistId: a.therapistId,
        startsAt: start,
        endsAt: end,
        status: "planned",
        source: "portal",
        externalId: `${PORTAL_EXTERNAL_PREFIX}${randomUUID()}`,
        title: a.title,
        notes: [`Über das Patientenportal verschoben (vorher ${dateDe(a.startsAt)}, ${timeDe(a.startsAt)} Uhr).`, a.notes].filter(Boolean).join("\n"),
        homeVisit: a.homeVisit,
        prescriptionId: a.prescriptionId,
      })
      .returning({ id: appointments.id });
    if (svc.length) await tx.insert(appointmentServices).values(svc.map((s) => ({ organizationId: org, appointmentId: n.id, serviceId: s.serviceId, quantity: s.quantity })));
    await tx.insert(messages).values({
      organizationId: org,
      patientId: link.patientId,
      channel: "none",
      direction: "inbound",
      subject: "Terminverschiebung über das Patientenportal",
      body: `Der Termin am ${dateDe(a.startsAt)} um ${timeDe(a.startsAt)} Uhr wurde über das Patientenportal auf ${dateDe(start)} um ${timeDe(start)} Uhr verschoben.`,
      status: "new",
      threadKey: `portal:${link.patientId}`,
    });
    return { ok: true, appointmentId: n.id, cancelledId: a.id, message: `Ihr Termin wurde auf ${dateDe(start)} um ${timeDe(start)} Uhr verschoben.` };
  });
  if (res.ok) await audit({ organizationId: org, action: "portal.appointment_reschedule", entity: "appointment", entityId: res.appointmentId, meta: { from: res.cancelledId } });
  return res;
}

// ───────────────────────── Öffentliche Buchung /buchen/[slug] (Gesamt-Review M1) ─────────────────────────

/** Die öffentliche Seite zeigt die nächsten 14 Tage. */
export const PUBLIC_BOOKING_DAYS = 14;

export type PublicBookingOptions = {
  services: { id: string; code: string; name: string; durationMin: number; priceCents: number }[];
  /** je Dauer: freie Startzeiten (HH:MM, Europe/Berlin) */
  days: { date: string; slots: Record<number, string[]> }[];
};

const inPublicWindow = (dateIso: string, now: Date) => {
  const days = dayRange(berlinDateIso(now), PUBLIC_BOOKING_DAYS + 1);
  return days.includes(dateIso);
};

/**
 * Leistungen und freie Zeiten für /buchen – dieselbe Verfügbarkeit wie Portal und Telefon (Arbeitszeiten,
 * Abwesenheiten, Feiertage, Vorlauf, Tageslimit). null = Online-Buchung ausgeschaltet bzw. Praxis unbekannt.
 */
export async function publicBookingOptions(organizationId: string, now = new Date()): Promise<PublicBookingOptions | null> {
  const o = await loadOrg(organizationId);
  if (!o) return null;
  const cfg = parseOnlineBookingSettings(o.settings);
  if (!cfg.enabled) return null;
  const svc = await bookableServicesFor(o, cfg);
  const byDay = new Map<string, Record<number, string[]>>();
  for (const dur of [...new Set(svc.map((s) => s.durationMin))]) {
    for (const d of await portalFreeSlots(o, { durationMin: dur, now, cfg })) {
      if (!inPublicWindow(d.dateIso, now) || !d.slots.length) continue;
      const rec = byDay.get(d.dateIso) ?? {};
      rec[dur] = d.slots.map((x) => timeDe(x));
      byDay.set(d.dateIso, rec);
    }
  }
  return {
    services: svc.map(({ id, code, name, durationMin, priceCents }) => ({ id, code, name, durationMin, priceCents })),
    days: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, slots]) => ({ date, slots })),
  };
}

export type PublicSlotCheck = { ok: true; service: { id: string; name: string; durationMin: number }; cfg: OnlineBookingSettings } | { ok: false; error: string };

/**
 * Serverseitige Prüfung einer öffentlichen Buchung VOR dem Speichern: Freigabe, Leistungsliste, Buchungsfenster und
 * dass `start` exakt einer der angebotenen freien Startzeiten entspricht. Die Überschneidung prüft der Aufrufer
 * danach noch einmal unter lockBooking().
 */
export async function checkPublicSlot(organizationId: string, serviceId: string, start: Date, now = new Date()): Promise<PublicSlotCheck> {
  const o = await loadOrg(organizationId);
  if (!o) return { ok: false, error: "Praxis nicht gefunden." };
  const cfg = parseOnlineBookingSettings(o.settings);
  if (!cfg.enabled) return { ok: false, error: "Die Online-Buchung ist in dieser Praxis derzeit ausgeschaltet." };
  const svc = (await bookableServicesFor(o, cfg)).find((x) => x.id === serviceId);
  if (!svc) return { ok: false, error: "Diese Leistung ist online nicht buchbar." };
  if (Number.isNaN(start.getTime()) || !inPublicWindow(berlinDateIso(start), now)) return { ok: false, error: "Bitte einen Termin in den nächsten zwei Wochen wählen." };
  if (!(await isFreeSlot(o, start, svc.durationMin, now))) return { ok: false, error: "Dieser Termin ist nicht (mehr) frei. Bitte einen anderen wählen." };
  return { ok: true, service: { id: svc.id, name: svc.name, durationMin: svc.durationMin }, cfg };
}
