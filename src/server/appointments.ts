import "server-only";
import { and, asc, eq, gte, isNull, lt, ne, or } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { appointmentServices, appointments, calendarFeedEvents, calendarFeeds, memberships, patients, users } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
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

export async function therapists(auth: AuthContext) {
  const org = auth.organization.id;
  const { db } = await import("@/db");
  return db
    .select({ id: users.id, name: users.name, role: memberships.role, color: memberships.color })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, org), eq(memberships.active, true), ne(memberships.role, "accountant")));
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
export async function createInternalAppointments(org: string, input: InternalAppointmentInput): Promise<{ ok: true; ids: string[] } | { ok: false; conflict: true }> {
  return withOrg(org, async (tx) => {
    await lockBooking(tx, org);
    if (!input.allowConflict) {
      for (const s of input.occurrences) {
        if ((await conflictsInTx(tx, org, input.therapistId, s, new Date(s.getTime() + input.durationMin * 60_000))).length) return { ok: false as const, conflict: true as const };
      }
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
