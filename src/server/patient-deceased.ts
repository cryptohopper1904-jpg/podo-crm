import "server-only";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointments, calendarFeedEvents, patientLinks, patients, waitlist } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { lockBooking } from "./portal-booking";
import { DECEASED_KEY, deceasedInfo, isDeceased, parseDeathDate, type DeceasedInfo } from "@/lib/patient-deceased";

export * from "@/lib/patient-deceased";

/** SQL-Bedingung „nicht als verstorben markiert“ (patients.extra.deceased fehlt). */
export const notDeceased = () => sql`(${patients.extra} -> ${DECEASED_KEY}) is null`;

/** Ist die Person (in dieser Transaktion) als verstorben markiert? Unbekannte Person → false. */
export async function patientIsDeceased(tx: Tx, org: string, patientId: string, opts: { lock?: boolean } = {}): Promise<boolean> {
  const q = tx.select({ extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
  // lock: Zeile bis zum Ende der Transaktion sperren → ein paralleles „verstorben markieren“ wartet bzw. wird gesehen
  const [p] = opts.lock ? await q.for("update") : await q;
  return !!p && isDeceased(p.extra);
}

const OPEN_STATUSES = ["planned", "confirmed"] as const;

/** Künftige geplante/bestätigte Termine – getrennt nach „in PodoHero absagbar“ und „aus Kalender-Abo“ (Absage nur in der Quelle). */
async function futureAppointments(tx: Tx, org: string, patientId: string, now: Date) {
  const rows = await tx
    .select({ id: appointments.id, startsAt: appointments.startsAt, feedId: calendarFeedEvents.id })
    .from(appointments)
    .leftJoin(calendarFeedEvents, and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointments.id)))
    .where(and(eq(appointments.organizationId, org), eq(appointments.patientId, patientId), gt(appointments.startsAt, now), inArray(appointments.status, [...OPEN_STATUSES])));
  return { own: rows.filter((r) => !r.feedId), feed: rows.filter((r) => !!r.feedId) };
}

/** Für die Akte: Status der Markierung und Zahl der künftigen Termine (für die Bestätigung). */
export async function deceasedStatus(auth: AuthContext, patientId: string, now = new Date()): Promise<{ info: DeceasedInfo | null; futureOwn: number; futureFeed: number } | null> {
  assertCan(auth, "patients.read");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) return null;
  return withOrg(org, async (tx) => {
    const [p] = await tx.select({ extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const f = await futureAppointments(tx, org, patientId, now);
    return { info: deceasedInfo(p.extra), futureOwn: f.own.length, futureFeed: f.feed.length };
  });
}

export type MarkDeceasedResult =
  | { ok: true; cancelled: string[]; feedRemaining: number; waitlistResolved: number; linksRevoked: number }
  | { ok: false; error: string; futureAppointments?: number };

/**
 * Patient:in als verstorben markieren (Recht patients.write, protokolliert).
 * In EINER Transaktion: Markierung in patients.extra, offene Wartelisten-Einträge erledigen, alle aktiven Links
 * (Portal, Anamnese, Wartelisten-Angebote) widerrufen und – nur nach Bestätigung (`cancelFuture`) – künftige
 * PodoHero-Termine absagen. Gibt es künftige Termine und fehlt die Bestätigung, wird nichts geändert.
 * Termine aus einem Kalender-Abo (z. B. Doctolib) werden in der Quelle abgesagt und hier nur gezählt.
 */
export async function markPatientDeceased(
  auth: AuthContext,
  patientId: string,
  input: { date?: string | null; cancelFuture: boolean },
  now = new Date(),
): Promise<MarkDeceasedResult> {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) return { ok: false, error: "Patient:in nicht gefunden." };
  const res = await withOrg(org, async (tx): Promise<MarkDeceasedResult> => {
    // dieselbe Buchungssperre wie Terminanlage/Portal/Warteliste → parallel angelegte künftige Termine werden gesehen und abgesagt
    await lockBooking(tx, org);
    const [p] = await tx
      .select({ extra: patients.extra, birthDate: patients.birthDate })
      .from(patients)
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)))
      .for("update");
    if (!p) return { ok: false, error: "Patient:in nicht gefunden." };
    if (isDeceased(p.extra)) return { ok: false, error: "Die Patient:in ist bereits als verstorben markiert." };
    const parsed = parseDeathDate(input.date, { today: berlinDateIso(now), birthDate: p.birthDate });
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const future = await futureAppointments(tx, org, patientId, now);
    if (future.own.length && !input.cancelFuture) {
      return { ok: false, error: `Es gibt noch ${future.own.length} geplante Termin(e). Bitte das Absagen bestätigen.`, futureAppointments: future.own.length };
    }
    const info: DeceasedInfo = { date: parsed.date, markedAt: now.toISOString(), markedBy: auth.user.id };
    await tx
      .update(patients)
      .set({ extra: sql`coalesce(${patients.extra}, '{}'::jsonb) || jsonb_build_object(${DECEASED_KEY}::text, ${JSON.stringify(info)}::jsonb)`, updatedAt: now })
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    const cancelled = future.own.map((a) => a.id);
    if (cancelled.length) {
      await tx
        .update(appointments)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(appointments.organizationId, org), inArray(appointments.id, cancelled), inArray(appointments.status, [...OPEN_STATUSES])));
    }
    const wl = await tx
      .update(waitlist)
      .set({ resolvedAt: now })
      .where(and(eq(waitlist.organizationId, org), eq(waitlist.patientId, patientId), isNull(waitlist.resolvedAt)))
      .returning({ id: waitlist.id });
    // patient_links hat keine RLS → Mandant explizit filtern
    const links = await tx
      .update(patientLinks)
      .set({ revokedAt: now })
      .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.patientId, patientId), isNull(patientLinks.revokedAt), isNull(patientLinks.usedAt)))
      .returning({ id: patientLinks.id });
    await audit(
      {
        organizationId: org,
        userId: auth.user.id,
        action: "patient.deceased_mark",
        entity: "patient",
        entityId: patientId,
        meta: { date: parsed.date, cancelledAppointments: cancelled.length, feedAppointmentsRemaining: future.feed.length, waitlistResolved: wl.length, linksRevoked: links.length },
      },
      tx,
    );
    return { ok: true, cancelled, feedRemaining: future.feed.length, waitlistResolved: wl.length, linksRevoked: links.length };
  });
  return res;
}

/**
 * Markierung zurücknehmen (Fehleingabe; Recht patients.write, protokolliert mit den alten Werten).
 * Abgesagte Termine, erledigte Wartelisten-Einträge und widerrufene Links werden NICHT wiederhergestellt.
 */
export async function undoPatientDeceased(auth: AuthContext, patientId: string, reason?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  assertCan(auth, "patients.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(patientId).success) return { ok: false, error: "Patient:in nicht gefunden." };
  return withOrg(org, async (tx) => {
    const [p] = await tx.select({ extra: patients.extra }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId))).for("update");
    if (!p) return { ok: false as const, error: "Patient:in nicht gefunden." };
    const prev = deceasedInfo(p.extra);
    if (!prev) return { ok: false as const, error: "Die Patient:in ist nicht als verstorben markiert." };
    await tx
      .update(patients)
      .set({ extra: sql`coalesce(${patients.extra}, '{}'::jsonb) - ${DECEASED_KEY}::text`, updatedAt: new Date() })
      .where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    await audit(
      {
        organizationId: org,
        userId: auth.user.id,
        action: "patient.deceased_undo",
        entity: "patient",
        entityId: patientId,
        meta: { previousDate: prev.date, previousMarkedAt: prev.markedAt || null, previousMarkedBy: prev.markedBy, reason: reason?.trim().slice(0, 200) || null },
      },
      tx,
    );
    return { ok: true as const };
  });
}

