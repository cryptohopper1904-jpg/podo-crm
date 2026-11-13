import "server-only";
import { and, asc, eq, gte, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { absences, appointments, memberships, organizations, patients, users, workingHours } from "@/db/schema";
import { CALENDAR_ROLES } from "@/lib/auth/permissions";
import type { AuthContext } from "@/lib/auth/session";
import { audit } from "@/lib/audit";
import { ABSENCE_KINDS, computeAvailability, type Availability, type TimeRange } from "@/lib/availability";
import { berlinDateIso } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { practiceHours } from "@/lib/opening-hours";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig");

/** Team-Planung sehen: alle Rollen außer Steuerberatung. */
export const canViewTeam = (auth: AuthContext) => auth.role !== "accountant";
export const canEditTeam = (auth: AuthContext) => auth.can("users.manage");

/** Fehlendes Recht in der Serverschicht (Defense in Depth – zusätzlich zu requireAuth in Seiten/Actions). */
export class StaffForbiddenError extends Error {
  constructor(what: string) {
    super(`Kein Zugriff: ${what}`);
    this.name = "ForbiddenError";
  }
}
const need = (ok: boolean, what: string) => {
  if (!ok) throw new StaffForbiddenError(what);
};

/**
 * Aktive Personen der Praxis, die arbeiten (ohne Steuerberatung) – für Team-Planung (Arbeitszeiten, Abwesenheiten).
 * Für buchbare Zeiten (Online-Buchung, KI-Telefon) bookableStaff verwenden.
 */
export async function staffMembers(org: string) {
  return db
    .select({ id: users.id, name: users.name, role: memberships.role, color: memberships.color })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, org), eq(memberships.active, true), ne(memberships.role, "accountant")))
    .orderBy(asc(users.name));
}

/**
 * Personen mit eigener Kalenderspalte (Inhaber:in, Podolog:in – CALENDAR_ROLES): nur ihre Arbeitszeiten ergeben
 * buchbare Zeiten. Arbeitszeiten von Empfang oder Azubis erzeugen keine Online-/Telefon-Slots.
 */
export async function bookableStaff(org: string) {
  return db
    .select({ id: users.id, name: users.name, role: memberships.role, color: memberships.color })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, org), eq(memberships.active, true), inArray(memberships.role, [...CALENDAR_ROLES])))
    .orderBy(asc(users.name));
}

async function isMember(org: string, userId: string) {
  const [m] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.organizationId, org), eq(memberships.userId, userId), ne(memberships.role, "accountant")));
  return !!m;
}

async function orgInfo(org: string) {
  const [o] = await db.select({ state: organizations.state, settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  return { state: (o?.state ?? "BB") as StateCode, opening: practiceHours(o?.settings) };
}

/**
 * Verfügbarkeit einer Person an einem Tag (Berliner Datum) – für Kalender und Online-Buchung.
 * Berücksichtigt Arbeitszeiten je Wochentag, Abwesenheiten und gesetzliche Feiertage des Bundeslands.
 * Sind für die Person gar keine Arbeitszeiten gepflegt, gelten die Öffnungszeiten der Praxis je Wochentag
 * (`source: "opening_hours"`).
 */
export async function availability(org: string, userId: string, dateIso: string): Promise<Availability> {
  const info = await orgInfo(org);
  const { hours, abs } = await withOrg(org, async (tx) => ({
    hours: await tx
      .select({ weekday: workingHours.weekday, startTime: workingHours.startTime, endTime: workingHours.endTime })
      .from(workingHours)
      .where(and(eq(workingHours.organizationId, org), eq(workingHours.userId, userId))),
    abs: await tx
      .select({ startsOn: absences.startsOn, endsOn: absences.endsOn, kind: absences.kind })
      .from(absences)
      .where(and(eq(absences.organizationId, org), eq(absences.userId, userId), lte(absences.startsOn, dateIso), gte(absences.endsOn, dateIso))),
  }));
  return computeAvailability({ dateIso, hours, absences: abs, holiday: holidayOn(dateIso, info.state), opening: info.opening });
}

export async function teamOverview(auth: AuthContext, fromIso: string, toIso: string) {
  need(canViewTeam(auth), "Team-Planung ansehen");
  const org = auth.organization.id;
  const staff = await staffMembers(org);
  const ids = staff.map((s) => s.id);
  return withOrg(org, async (tx) => {
    const hours = ids.length
      ? await tx
          .select()
          .from(workingHours)
          .where(and(eq(workingHours.organizationId, org), inArray(workingHours.userId, ids)))
          .orderBy(asc(workingHours.weekday), asc(workingHours.startTime))
      : [];
    const abs = await tx
      .select({ a: absences, name: users.name })
      .from(absences)
      .innerJoin(users, eq(users.id, absences.userId))
      .where(and(eq(absences.organizationId, org), gte(absences.endsOn, fromIso), lte(absences.startsOn, toIso)))
      .orderBy(asc(absences.startsOn));
    return { staff, hours, absences: abs };
  });
}

/** Ersetzt die Arbeitszeiten einer Person komplett (je Wochentag beliebig viele Zeitfenster). */
export async function saveWorkingHours(auth: AuthContext, userId: string, byWeekday: Record<number, TimeRange[]>): Promise<{ error?: string }> {
  need(canEditTeam(auth), "Arbeitszeiten bearbeiten");
  const org = auth.organization.id;
  if (!(await isMember(org, userId))) return { error: "Person nicht gefunden." };
  const rows = Object.entries(byWeekday).flatMap(([wd, ranges]) =>
    ranges.map((r) => ({ organizationId: org, userId, weekday: Number(wd), startTime: r.start, endTime: r.end })),
  );
  if (rows.some((r) => !(r.weekday >= 1 && r.weekday <= 7))) return { error: "Wochentag ungültig." };
  await withOrg(org, async (tx) => {
    await tx.delete(workingHours).where(and(eq(workingHours.organizationId, org), eq(workingHours.userId, userId)));
    if (rows.length) await tx.insert(workingHours).values(rows);
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "staff.working_hours", entity: "user", entityId: userId });
  return {};
}

export const absenceInput = z
  .object({
    userId: z.string().uuid("Person wählen"),
    kind: z.enum(ABSENCE_KINDS),
    startsOn: isoDate,
    endsOn: isoDate,
    note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(300).nullable().optional()),
  })
  .refine((d) => d.endsOn >= d.startsOn, { message: "Ende liegt vor dem Beginn.", path: ["endsOn"] })
  .refine((d) => d.startsOn >= "2000-01-01" && d.endsOn <= "2100-12-31", { message: "Datum ungültig." });
export type AbsenceInput = z.infer<typeof absenceInput>;

export async function addAbsence(auth: AuthContext, input: AbsenceInput): Promise<{ error?: string }> {
  need(canEditTeam(auth), "Abwesenheiten bearbeiten");
  const org = auth.organization.id;
  if (!(await isMember(org, input.userId))) return { error: "Person nicht gefunden." };
  await withOrg(org, (tx) => tx.insert(absences).values({ ...input, note: input.note ?? null, organizationId: org }));
  // Art (z. B. Krankheit) bewusst nicht ins Protokoll-Meta: Beschäftigtendaten sparsam halten
  await audit({ organizationId: org, userId: auth.user.id, action: "staff.absence.create", entity: "user", entityId: input.userId });
  return {};
}

export async function deleteAbsence(auth: AuthContext, id: string) {
  need(canEditTeam(auth), "Abwesenheiten bearbeiten");
  const org = auth.organization.id;
  const [row] = await withOrg(org, (tx) =>
    tx.delete(absences).where(and(eq(absences.organizationId, org), eq(absences.id, id))).returning({ userId: absences.userId }),
  );
  if (row) await audit({ organizationId: org, userId: auth.user.id, action: "staff.absence.delete", entity: "user", entityId: row.userId });
}

/** Künftige Termine, die in eine Abwesenheit der zugeordneten Person fallen (Konfliktliste). */
export async function appointmentsInAbsences(auth: AuthContext, fromIso = berlinDateIso()) {
  need(canViewTeam(auth), "Team-Planung ansehen");
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({
        id: appointments.id,
        startsAt: appointments.startsAt,
        title: appointments.title,
        therapist: users.name,
        absenceKind: absences.kind,
        patientId: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
      })
      .from(appointments)
      .innerJoin(
        absences,
        and(
          eq(absences.organizationId, appointments.organizationId),
          eq(absences.userId, appointments.therapistId),
          sql`(${appointments.startsAt} at time zone 'Europe/Berlin')::date between ${absences.startsOn} and ${absences.endsOn}`,
        ),
      )
      .leftJoin(users, eq(users.id, appointments.therapistId))
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .where(
        and(
          eq(appointments.organizationId, org),
          sql`(${appointments.startsAt} at time zone 'Europe/Berlin')::date >= ${fromIso}::date`,
          notInArray(appointments.status, ["cancelled", "no_show", "done"]),
        ),
      )
      .orderBy(asc(appointments.startsAt))
      .limit(200),
  );
}
