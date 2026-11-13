import "server-only";
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { absences, appointmentServices, appointments, calendarFeedEvents, calendarFeeds, invoiceLines, invoices, memberships, patients, services, users } from "@/db/schema";
import { appointmentEditLock } from "@/lib/appointment-edit";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import { CALENDAR_ROLES } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { berlinParts, describeClashes } from "@/lib/calendar-grid";
import { berlinToUtc } from "@/lib/format";
import { lockBooking } from "./portal-booking";

export async function listAppointments(auth: AuthContext, fromIso: string, days: number) {
  const org = auth.organization.id;
  const from = berlinToUtc(fromIso, "00:00");
  const to = new Date(from.getTime() + days * 86400_000 + 2 * 3600_000);
  const rows = await withOrg(org, (tx) =>
    tx
      .select({
        a: appointments,
        patient: { id: patients.id, firstName: patients.firstName, lastName: patients.lastName, riskFlags: patients.riskFlags, homeVisit: patients.homeVisit, city: patients.city },
        therapist: users.name,
        feedLabel: calendarFeeds.label,
        feedConflict: calendarFeedEvents.conflict,
      })
      .from(appointments)
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .leftJoin(users, eq(users.id, appointments.therapistId))
      // Kalender-Abo: Herkunft und Konfliktkennzeichen (importierte Termine sind nur lesend)
      .leftJoin(calendarFeedEvents, and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointments.id)))
      .leftJoin(calendarFeeds, eq(calendarFeeds.id, calendarFeedEvents.feedId))
      .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, from), lt(appointments.startsAt, to)))
      .orderBy(asc(appointments.startsAt)),
  );
  return rows.map(({ feedLabel, feedConflict, ...r }) => ({ ...r, feed: feedLabel !== null ? { label: feedLabel, conflict: feedConflict } : null }));
}

/**
 * Wählbare Behandler:innen (eigene Kalenderspalte): nur Inhaber:in und Podolog:in (CALENDAR_ROLES).
 * Empfang und Azubis haben keinen eigenen Kalender und belegen dafür keinen bezahlten Platz.
 */
export async function therapists(auth: AuthContext) {
  const org = auth.organization.id;
  const { db } = await import("@/db");
  return db
    .select({ id: users.id, name: users.name, role: memberships.role, color: memberships.color })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, org), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])));
}

/** Ist `userId` aktive Behandler:in der Praxis (Rolle mit eigenem Kalender)? */
export async function isCalendarMember(tx: Tx, org: string, userId: string): Promise<boolean> {
  const [m] = await tx
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, org), eq(memberships.userId, userId), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])));
  return !!m;
}

/** Überschneidungen beim selben Behandler (ohne abgesagte Termine). */
export async function findConflicts(org: string, therapistId: string | null, start: Date, end: Date, excludeId?: string) {
  if (!therapistId) return [];
  return withOrg(org, async (tx) => {
    const rows = await tx
      .select({ id: appointments.id, startsAt: appointments.startsAt, endsAt: appointments.endsAt, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.therapistId, therapistId), lt(appointments.startsAt, end), gte(appointments.endsAt, start)));
    return rows.filter((r) => r.id !== excludeId && r.status !== "cancelled" && r.startsAt < end && r.endsAt > start);
  });
}

/** Freie Slots für einen Tag (z. B. für KI-Antworten „Dienstag 14:30 oder 16:00“). */
export function freeSlots(
  busy: { startsAt: Date; endsAt: Date }[],
  dayIso: string,
  durationMin: number,
  opening: { from: string; to: string } = { from: "08:00", to: "18:00" },
  stepMin = 15,
) {
  const start = berlinToUtc(dayIso, opening.from).getTime();
  const end = berlinToUtc(dayIso, opening.to).getTime();
  const slots: Date[] = [];
  for (let t = start; t + durationMin * 60_000 <= end; t += stepMin * 60_000) {
    const s = t, e = t + durationMin * 60_000;
    if (!busy.some((b) => b.startsAt.getTime() < e && b.endsAt.getTime() > s)) slots.push(new Date(s));
  }
  return slots;
}

/**
 * Überschneidung im laufenden Buchungs-Lock: Termine derselben Behandler:in UND Termine ohne Zuordnung
 * (Online-, Portal-, Telefon- und Wartelisten-Buchungen haben keine Behandler:in) – ohne abgesagte.
 */
async function conflictsInTx(tx: Tx, org: string, therapistId: string, start: Date, end: Date) {
  const rows = await tx
    .select({ id: appointments.id, status: appointments.status, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(and(eq(appointments.organizationId, org), or(eq(appointments.therapistId, therapistId), isNull(appointments.therapistId)), lt(appointments.startsAt, end), gte(appointments.endsAt, start)));
  return rows.filter((r) => r.status !== "cancelled" && r.startsAt < end && r.endsAt > start);
}

/** Berliner Tage (JJJJ-MM-TT), an denen die Behandler:in laut Team-Planung abwesend ist (Urlaub, Krankheit …). */
async function absentDaysInTx(tx: Tx, org: string, therapistId: string, days: string[]): Promise<string[]> {
  if (!days.length) return [];
  const sorted = [...days].sort();
  const rows = await tx
    .select({ startsOn: absences.startsOn, endsOn: absences.endsOn })
    .from(absences)
    .where(and(eq(absences.organizationId, org), eq(absences.userId, therapistId), lte(absences.startsOn, sorted[sorted.length - 1]), gte(absences.endsOn, sorted[0])));
  return [...new Set(days.filter((d) => rows.some((r) => r.startsOn <= d && d <= r.endsOn)))];
}

export type SlotClash = { startsAt: Date; endsAt: Date };
export type SlotConflict = { ok: false; conflict: true; clashes: SlotClash[]; absentDays: string[] };

/** Fehlertext für belegte Zeiten / Abwesenheit (Terminanlage und Verschieben). */
export function conflictMessage(c: Pick<SlotConflict, "clashes" | "absentDays">): string {
  const parts: string[] = [];
  if (c.clashes.length) parts.push(`Zu dieser Zeit ist bereits ein Termin eingetragen – belegt, nicht verfügbar (${describeClashes(c.clashes.slice(0, 5))}${c.clashes.length > 5 ? " …" : ""}).`);
  if (c.absentDays.length) {
    const days = c.absentDays.map((d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`).join(", ");
    parts.push(`Die Behandler:in ist laut Team-Planung abwesend – nicht verfügbar (${days}).`);
  }
  return parts.join(" ") || "Zu dieser Zeit ist bereits ein Termin eingetragen.";
}

export type InternalAppointmentInput = {
  patientId: string | null;
  therapistId: string;
  occurrences: Date[];
  durationMin: number;
  source: (typeof appointments.$inferInsert)["source"];
  title: string;
  notes: string | null;
  homeVisit: boolean;
  serviceIds: string[];
  allowConflict: boolean;
};

/**
 * Interne Terminanlage (Kalender) – Gesamt-Review M2: Konfliktprüfung und Anlage in EINER Transaktion unter
 * derselben Buchungssperre wie /buchen, Portal, Telefon und Warteliste (pg_advisory_xact_lock „book:<org>“).
 * `allowConflict` (bewusste Doppelbuchung nach Rückfrage) überspringt nur die Prüfung, nicht die Sperre.
 */
export async function createInternalAppointments(
  org: string,
  input: InternalAppointmentInput,
): Promise<{ ok: true; ids: string[] } | SlotConflict | { ok: false; conflict?: undefined; error: string }> {
  return withOrg(org, async (tx) => {
    await lockBooking(tx, org);
    if (!(await isCalendarMember(tx, org, input.therapistId))) return { ok: false as const, error: "Bitte eine Behandler:in (Inhaber:in oder Podolog:in) wählen." };
    if (!input.allowConflict) {
      const clashes: SlotClash[] = [];
      for (const s of input.occurrences) {
        const found = await conflictsInTx(tx, org, input.therapistId, s, new Date(s.getTime() + input.durationMin * 60_000));
        clashes.push(...found.map((c) => ({ startsAt: c.startsAt, endsAt: c.endsAt })));
      }
      const absentDays = await absentDaysInTx(tx, org, input.therapistId, input.occurrences.map((s) => berlinParts(s).dateIso));
      if (clashes.length || absentDays.length) return { ok: false as const, conflict: true as const, clashes, absentDays };
    }
    const ids: string[] = [];
    for (const s of input.occurrences) {
      const [a] = await tx
        .insert(appointments)
        .values({
          organizationId: org,
          patientId: input.patientId,
          therapistId: input.therapistId,
          startsAt: s,
          endsAt: new Date(s.getTime() + input.durationMin * 60_000),
          source: input.source,
          title: input.title,
          notes: input.notes,
          homeVisit: input.homeVisit,
        })
        .returning({ id: appointments.id });
      if (input.serviceIds.length) await tx.insert(appointmentServices).values(input.serviceIds.map((serviceId) => ({ organizationId: org, appointmentId: a.id, serviceId })));
      ids.push(a.id);
    }
    return { ok: true as const, ids };
  });
}

// ───────────── Termin ansehen und verschieben (Kalender → Termin) ─────────────

/** Termin mit Person, Behandler:in, Leistungen und Herkunft (Kalender-Abo). null = nicht gefunden. */
export async function getAppointment(auth: AuthContext, id: string) {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(id).success) return null;
  return withOrg(org, async (tx) => {
    const [row] = await tx
      .select({
        a: appointments,
        patient: { id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName, insuranceType: patients.insuranceType },
        therapist: users.name,
        feedLabel: calendarFeeds.label,
        feedEventId: calendarFeedEvents.id,
      })
      .from(appointments)
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .leftJoin(users, eq(users.id, appointments.therapistId))
      .leftJoin(calendarFeedEvents, and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointments.id)))
      .leftJoin(calendarFeeds, eq(calendarFeeds.id, calendarFeedEvents.feedId))
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, id)))
      .limit(1);
    if (!row) return null;
    const svc = await tx
      .select({ id: services.id, code: services.code, name: services.name, priceCents: services.priceCents, vatRate: services.vatRate, quantity: appointmentServices.quantity })
      .from(appointmentServices)
      .innerJoin(services, eq(services.id, appointmentServices.serviceId))
      .where(and(eq(appointmentServices.organizationId, org), eq(appointmentServices.appointmentId, id)));
    const fromFeed = row.feedEventId !== null;
    const billed = await isAppointmentBilled(tx, org, id);
    return {
      appointment: row.a,
      patient: row.patient?.id ? row.patient : null,
      therapist: row.therapist,
      services: svc.map((s) => ({ ...s, quantity: Number(s.quantity) || 1 })),
      feed: fromFeed ? { label: row.feedLabel ?? "Kalender-Abo" } : null,
      lock: appointmentEditLock(row.a, fromFeed, billed),
    };
  });
}

/** Steht der Termin auf einer ausgestellten (nicht stornierten, nicht Entwurf) Rechnung, Quittung o. Ä.? */
async function isAppointmentBilled(tx: Tx, org: string, appointmentId: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: invoiceLines.id })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.organizationId, org),
        eq(invoiceLines.appointmentId, appointmentId),
        ne(invoices.status, "cancelled"),
        ne(invoices.status, "draft"),
        ne(invoices.kind, "credit_note"),
      ),
    )
    .limit(1);
  return !!hit;
}

export type RescheduleInput = { startsAt: Date; durationMin: number; therapistId: string; allowConflict: boolean };
export type RescheduleResult = { ok: true } | { ok: false; conflict?: true; error: string };

/**
 * Termin verschieben (Datum, Uhrzeit, Dauer, Behandler:in) – nur für Termine, die in PodoHero geführt werden
 * (nicht Doctolib/Kalender-Abo, siehe appointmentEditLock). Unter derselben Buchungssperre wie die Terminanlage;
 * Überschneidungen nur nach ausdrücklicher Bestätigung (allowConflict).
 */
export async function rescheduleAppointment(auth: AuthContext, id: string, input: RescheduleInput): Promise<RescheduleResult> {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Termin nicht gefunden." };
  if (Number.isNaN(input.startsAt.getTime())) return { ok: false, error: "Datum/Uhrzeit ungültig." };
  if (!Number.isInteger(input.durationMin) || input.durationMin < 5 || input.durationMin > 480) return { ok: false, error: "Dauer muss zwischen 5 und 480 Minuten liegen." };
  const end = new Date(input.startsAt.getTime() + input.durationMin * 60_000);
  const result = await withOrg(org, async (tx): Promise<RescheduleResult & { before?: { startsAt: Date; endsAt: Date; therapistId: string | null } }> => {
    await lockBooking(tx, org);
    const [a] = await tx.select().from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, id))).for("update");
    if (!a) return { ok: false, error: "Termin nicht gefunden." };
    const [feed] = await tx
      .select({ id: calendarFeedEvents.id })
      .from(calendarFeedEvents)
      .where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, id)))
      .limit(1);
    const lock = appointmentEditLock(a, !!feed, await isAppointmentBilled(tx, org, id));
    if (lock) return { ok: false, error: lock.message };
    // Nur Rollen mit eigenem Kalender (Empfang/Azubis belegen keinen Platz und bekommen keine Termine)
    if (!(await isCalendarMember(tx, org, input.therapistId))) return { ok: false, error: "Behandler:in nicht gefunden." };
    if (!input.allowConflict) {
      const clash = (await conflictsInTx(tx, org, input.therapistId, input.startsAt, end)).filter((c) => c.id !== id);
      const absentDays = await absentDaysInTx(tx, org, input.therapistId, [berlinParts(input.startsAt).dateIso]);
      if (clash.length || absentDays.length) return { ok: false, conflict: true, error: conflictMessage({ clashes: clash, absentDays }) };
    }
    await tx
      .update(appointments)
      .set({ startsAt: input.startsAt, endsAt: end, therapistId: input.therapistId, updatedAt: new Date() })
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, id)));
    return { ok: true, before: { startsAt: a.startsAt, endsAt: a.endsAt, therapistId: a.therapistId } };
  });
  if (!result.ok) return result;
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "appointment.reschedule",
    entity: "appointment",
    entityId: id,
    meta: {
      from: result.before?.startsAt.toISOString(),
      to: input.startsAt.toISOString(),
      durationMin: input.durationMin,
      therapistChanged: result.before?.therapistId !== input.therapistId,
      allowConflict: input.allowConflict,
    },
  });
  return { ok: true };
}
