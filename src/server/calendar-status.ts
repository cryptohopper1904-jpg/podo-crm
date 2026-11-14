import "server-only";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointments, auditLog, calendarFeedEvents, organizations, patientLinks, reminderLog } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { OFFER_KIND, OFFER_PURPOSE } from "@/lib/waitlist";
import { billedIdsInTx } from "./appointments";
import { lockBooking } from "./portal-booking";
import { offerFreedSlot, type OfferDeps } from "./waitlist";

/**
 * Statuswechsel aus der Terminzeile/Terminseite („Nicht da“, „Absagen“) und deren „Rückgängig“.
 *
 * Erlaubt sind nur diese Übergänge (alles andere – z. B. „erledigt“ – über Doku/Formulare):
 *   geplant/bestätigt → abgesagt | nicht erschienen
 *   abgesagt/nicht erschienen → geplant/bestätigt   (nur als Rückgängig: `expected` = aktueller Status)
 * Abgerechnete Termine und Termine aus Doctolib/Kalender-Abo/extern werden nicht abgesagt bzw. wiederhergestellt.
 * Wiederherstellen prüft unter der Buchungssperre (wie /buchen, Portal, Warteliste), ob die Zeit inzwischen vergeben
 * ist, und widerruft offene Wartelisten-Angebote für den Termin.
 */

export const STATUSES = ["planned", "confirmed", "done", "cancelled", "no_show"] as const;
export type AppointmentStatus = (typeof STATUSES)[number];
export type StatusResult = { ok: true; prev: AppointmentStatus } | { ok: false; error: string };

const ACTIVE = new Set<string>(["planned", "confirmed"]);
const INACTIVE = new Set<string>(["cancelled", "no_show"]);

export const SLOT_TAKEN_MSG = "Zeit inzwischen vergeben – Termin bleibt abgesagt.";
export const STALE_STATUS_MSG = "Termin wurde zwischenzeitlich geändert – bitte neu laden.";
export const NOT_ALLOWED_MSG = "Dieser Statuswechsel ist hier nicht möglich.";
export const BILLED_MSG = "Der Termin ist bereits abgerechnet – Status bitte nicht mehr ändern.";
export const EXTERNAL_MSG = "Termine aus Doctolib bzw. dem Kalender-Abo bitte in der Quelle (z. B. Doctolib) absagen.";

const input = z.object({
  id: z.uuid("Termin nicht gefunden."),
  status: z.enum(STATUSES, { error: "Unbekannter Status." }),
  expected: z.enum(STATUSES, { error: "Unbekannter Status." }).optional(),
});

/** Ist der Wechsel `from → to` erlaubt? (reine Regel, ohne DB) */
export function statusChangeAllowed(from: string, to: string, expected?: string): boolean {
  if (expected !== undefined && expected !== from) return false;
  if (ACTIVE.has(from) && INACTIVE.has(to)) return true;
  // Rückgängig: nur mit ausdrücklicher Erwartung des aktuellen Status
  return expected !== undefined && INACTIVE.has(from) && ACTIVE.has(to);
}

export async function changeAppointmentStatus(auth: AuthContext, raw: { id: string; status: string; expected?: string }): Promise<StatusResult> {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const { id, status, expected } = parsed.data;
  const res = await withOrg(org, async (tx): Promise<StatusResult> => {
    const restoring = expected !== undefined && INACTIVE.has(expected) && ACTIVE.has(status);
    // Wiederherstellen konkurriert mit Online-Buchung/Wartelisten-Annahme um die Zeit → dieselbe Sperre zuerst
    if (restoring) await lockBooking(tx, org);
    const [a] = await tx
      .select({ status: appointments.status, source: appointments.source, startsAt: appointments.startsAt, endsAt: appointments.endsAt, therapistId: appointments.therapistId })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, id)))
      .for("update");
    if (!a) return { ok: false, error: "Termin nicht gefunden." };
    if (expected !== undefined && a.status !== expected) return { ok: false, error: STALE_STATUS_MSG };
    if (!statusChangeAllowed(a.status, status, expected)) return { ok: false, error: NOT_ALLOWED_MSG };
    if ((await billedIdsInTx(tx, org, [id])).size) return { ok: false, error: BILLED_MSG };
    const touchesCancel = status === "cancelled" || a.status === "cancelled";
    if (touchesCancel) {
      const [feed] = await tx.select({ id: calendarFeedEvents.id }).from(calendarFeedEvents).where(and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, id))).limit(1);
      if (feed || a.source === "doctolib" || a.source === "extern") return { ok: false, error: EXTERNAL_MSG };
    }
    if (restoring) {
      // gleiche Behandler:in bzw. ohne Zuordnung (z. B. von der Warteliste nachgerückt); ohne Behandler:in: jede
      const others = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.organizationId, org),
            lt(appointments.startsAt, a.endsAt),
            gt(appointments.endsAt, a.startsAt),
            sql`${appointments.id} <> ${id}`,
            inArray(appointments.status, ["planned", "confirmed", "done"]),
            a.therapistId ? or(eq(appointments.therapistId, a.therapistId), isNull(appointments.therapistId)) : undefined,
          ),
        )
        .limit(1);
      if (others.length) return { ok: false, error: a.status === "cancelled" ? SLOT_TAKEN_MSG : "Zeit inzwischen vergeben – Termin bleibt „nicht erschienen“." };
      // offene Wartelisten-Angebote für diesen Termin gelten nicht mehr
      await tx
        .update(patientLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(patientLinks.organizationId, org), eq(patientLinks.purpose, OFFER_PURPOSE), eq(patientLinks.appointmentId, id), isNull(patientLinks.usedAt), isNull(patientLinks.revokedAt)));
    }
    await tx.update(appointments).set({ status, updatedAt: new Date() }).where(and(eq(appointments.organizationId, org), eq(appointments.id, id)));
    return { ok: true, prev: a.status as AppointmentStatus };
  });
  if (!res.ok) return res;
  const offerPending = status === "cancelled" && res.prev !== "cancelled";
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "appointment.status",
    entity: "appointment",
    entityId: id,
    // waitlist: „pending“ = Angebot an die Warteliste steht noch aus (after() bzw. Cron-Nachlauf runPendingWaitlistOffers)
    meta: { status, from: res.prev, ...(expected ? { undo: true } : {}), ...(offerPending ? { waitlist: "pending" } : {}) },
  });
  return res;
}

/** Frist für „Rückgängig“, bevor ein frei gewordener Termin der Warteliste angeboten wird */
export const UNDO_GRACE_MS = 20_000;
/** Cron-Nachlauf: nur Absagen der letzten 24 h */
const PENDING_WINDOW_MS = 24 * 3600_000;
const CHECKED = "waitlist.offer_checked";

/** Angebot an die Warteliste für einen abgesagten Termin (einmal; Fehler werden protokolliert, nicht geworfen). */
export async function offerAfterCancel(org: string, appointmentId: string, deps: OfferDeps = {}) {
  let summary: Awaited<ReturnType<typeof offerFreedSlot>> | null = null;
  try {
    summary = await offerFreedSlot(org, appointmentId, deps);
  } catch (e) {
    await audit({ organizationId: org, action: "waitlist.offer_failed", entity: "appointment", entityId: appointmentId, meta: { error: String(e).slice(0, 200) } }).catch(() => undefined);
  }
  await audit({ organizationId: org, action: CHECKED, entity: "appointment", entityId: appointmentId, meta: { offered: summary?.offered ?? 0, skipped: summary?.skipped ?? null } }).catch(() => undefined);
  return summary;
}

/**
 * Cron-Nachlauf (/api/cron/reminders): Absagen aus Terminzeile/Terminseite, deren verzögertes Angebot (after() mit
 * UNDO_GRACE_MS) nicht gelaufen ist – z. B. Neustart des Servers in der Frist. Erfasst nur Absagen mit
 * `waitlist: "pending"` (erst ab dieser Version gesetzt – ältere Absagen lösen nichts aus) aus den letzten 24 h,
 * älter als die Frist, ohne bisherige Prüfung bzw. bisheriges Angebot, Termin weiterhin abgesagt und in der Zukunft.
 */
export async function runPendingWaitlistOffers(opts: { now?: Date; organizationId?: string; deps?: OfferDeps } = {}) {
  const now = opts.now ?? new Date();
  const orgs = await db.select({ id: organizations.id }).from(organizations).where(opts.organizationId ? eq(organizations.id, opts.organizationId) : undefined);
  let checked = 0;
  let offered = 0;
  for (const o of orgs) {
    const ids = await withOrg(o.id, async (tx) => {
      const rows = await tx
        .selectDistinct({ id: appointments.id })
        .from(auditLog)
        .innerJoin(appointments, and(eq(appointments.organizationId, o.id), sql`${appointments.id}::text = ${auditLog.entityId}`))
        .where(
          and(
            eq(auditLog.organizationId, o.id),
            eq(auditLog.action, "appointment.status"),
            sql`${auditLog.meta} ->> 'waitlist' = 'pending'`,
            gt(auditLog.at, new Date(now.getTime() - PENDING_WINDOW_MS)),
            lt(auditLog.at, new Date(now.getTime() - UNDO_GRACE_MS)),
            eq(appointments.status, "cancelled"),
            gt(appointments.startsAt, now),
            sql`not exists (select 1 from ${auditLog} c where c.organization_id = ${o.id} and c.action = ${CHECKED} and c.entity_id = ${appointments.id}::text and c.at > ${auditLog.at})`,
            sql`not exists (select 1 from ${reminderLog} r where r.organization_id = ${o.id} and r.kind = ${OFFER_KIND} and r.appointment_id = ${appointments.id})`,
          ),
        );
      return rows.map((r) => r.id);
    });
    for (const id of ids) {
      checked++;
      offered += (await offerAfterCancel(o.id, id, { ...opts.deps, now }))?.offered ?? 0;
    }
  }
  return { checked, offered };
}
