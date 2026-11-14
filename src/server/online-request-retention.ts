import "server-only";
import { and, eq, inArray, isNull, like, lt, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, messages, organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";

/**
 * Speicherdauer unbestätigter Online-Terminanfragen (/buchen): Wird eine Anfrage nicht in eine Patientenakte übernommen,
 * werden die Termin-Vormerkung und ihre Posteingangs-Nachricht 6 Monate nach Eingang gelöscht – so steht es in den
 * Datenschutzhinweisen der Praxis (src/app/p/[slug]/_site/legal-content.tsx) und in der AVV (§ 3 Nr. 4).
 *
 * Gelöscht wird bewusst eng (Code-Review/AppSec/Recht):
 * - nur echte /buchen-Anfragen: Quelle „online“ UND external_id „online-request:<id>“ (gesetzt beim Eingang,
 *   src/app/buchen/[slug]/actions.ts). Von der Praxis manuell mit Quelle „online“ angelegte Termine und ältere
 *   Anfragen aus der Zeit vor diesem Kennzeichen (vor der Ankündigung) haben es nicht und bleiben unberührt.
 * - nur Status „geplant“ oder „abgesagt“ – bestätigte, erledigte und „nicht erschienen“-Termine bleiben
 * - nur ohne zugeordnete Person und ohne Behandlungsdokumentation oder Rechnungsposition
 * - Nachricht nur zusammen mit ihrem Termin (thread_key „online-request:<id>“), nur eingehend, ohne external_id
 *   und ohne zugeordnete Person
 * Je Praxis eine Transaktion mit Audit-Eintrag (nur Zähler + Stichtag). Aufruf täglich über POST /api/cron/aufbewahrung.
 */
export const ONLINE_REQUEST_RETENTION_MONTHS = 6;
/** Betreff der Posteingangs-Nachricht einer Online-Anfrage (src/app/buchen/[slug]/actions.ts) */
export const ONLINE_REQUEST_SUBJECT = "Neue Online-Buchung (unbestätigt)";
/** Kennzeichen echter /buchen-Anfragen: appointments.external_id und messages.thread_key = „online-request:<Termin-ID>“ */
export const ONLINE_REQUEST_PREFIX = "online-request:";

export const onlineRequestKey = (appointmentId: string) => `${ONLINE_REQUEST_PREFIX}${appointmentId}`;

export function onlineRequestCutoff(now: Date): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - ONLINE_REQUEST_RETENTION_MONTHS);
  return d;
}

export type RetentionResult = { appointments: number; messages: number };

/** Löscht abgelaufene unbestätigte Online-Anfragen einer Praxis; liefert die Anzahl gelöschter Einträge. */
export async function purgeStaleOnlineRequests(organizationId: string, now = new Date()): Promise<RetentionResult> {
  const cutoff = onlineRequestCutoff(now);
  return withOrg(organizationId, async (tx) => {
    const appts = await tx
      .delete(appointments)
      .where(
        and(
          eq(appointments.organizationId, organizationId),
          eq(appointments.source, "online"),
          like(appointments.externalId, `${ONLINE_REQUEST_PREFIX}%`),
          inArray(appointments.status, ["planned", "cancelled"]),
          isNull(appointments.patientId),
          lt(appointments.createdAt, cutoff),
          // nichts löschen, worauf Doku oder Rechnungen verweisen
          sql`not exists (select 1 from treatment_records t where t.appointment_id = ${appointments.id})`,
          sql`not exists (select 1 from invoice_lines l where l.appointment_id = ${appointments.id})`,
        ),
      )
      .returning({ id: appointments.id });
    let msgCount = 0;
    if (appts.length) {
      const msgs = await tx
        .delete(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            inArray(messages.threadKey, appts.map((a) => onlineRequestKey(a.id))),
            eq(messages.direction, "inbound"),
            isNull(messages.externalId),
            isNull(messages.patientId),
          ),
        )
        .returning({ id: messages.id });
      msgCount = msgs.length;
      await audit(
        { organizationId, action: "retention.online_requests", meta: { appointments: appts.length, messages: msgCount, cutoff: cutoff.toISOString() } },
        tx,
      );
    }
    return { appointments: appts.length, messages: msgCount };
  });
}

/** Alle Praxen, je Praxis einzeln abgesichert; Antwort nur mit Zählern. */
export async function purgeStaleOnlineRequestsAll(now = new Date()): Promise<{ organizations: number; appointments: number; messages: number; errors: number }> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  let a = 0;
  let m = 0;
  let errors = 0;
  for (const o of orgs) {
    try {
      const r = await purgeStaleOnlineRequests(o.id, now);
      a += r.appointments;
      m += r.messages;
    } catch (e) {
      errors++;
      // Praxis-ID ist kein Personenbezug; Fehler ohne DB-Details (src/lib/log.ts)
      log.error("retention.online_requests.failed", { org: o.id, error: e });
    }
  }
  return { organizations: orgs.length, appointments: a, messages: m, errors };
}
