import "server-only";
import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { withOrg } from "@/db";
import { appointments, memberships, patients, users } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { berlinToUtc } from "@/lib/format";

export async function listAppointments(auth: AuthContext, fromIso: string, days: number) {
  const org = auth.organization.id;
  const from = berlinToUtc(fromIso, "00:00");
  const to = new Date(from.getTime() + days * 86400_000 + 2 * 3600_000);
  return withOrg(org, (tx) =>
    tx
      .select({
        a: appointments,
        patient: { id: patients.id, firstName: patients.firstName, lastName: patients.lastName, riskFlags: patients.riskFlags, homeVisit: patients.homeVisit, city: patients.city },
        therapist: users.name,
      })
      .from(appointments)
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .leftJoin(users, eq(users.id, appointments.therapistId))
      .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, from), lt(appointments.startsAt, to)))
      .orderBy(asc(appointments.startsAt)),
  );
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
