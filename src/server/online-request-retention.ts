import "server-only";
import { and, eq, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, messages, organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { avvAcceptedAtLeast, RETENTION_MIN_AVV } from "@/lib/legal";
import { log } from "@/lib/log";
import { ONLINE_REQUEST_PREFIX, onlineRequestKey } from "@/lib/online-request";

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
 * - Nachrichten zum gelöschten Termin (thread_key „online-request:<id>“) ohne zugeordnete Person: eingehende nur ohne
 *   external_id, ausgehende Antworten der Praxis (tragen die Versand-ID als external_id) ebenso
 * - verwaiste Nachrichten (Kennzeichen, ohne Person, Termin existiert nicht mehr – z. B. von der Praxis gelöscht)
 *   nach demselben Stichtag, gemessen am Eingang (received_at); eingehende nur ohne external_id
 * - nur Praxen, die die AVV ab Version 0.3 akzeptiert haben (§ 3 Nr. 4 = Standardweisung zur Löschung)
 * Je Praxis eine Transaktion mit Audit-Eintrag (nur Zähler + Stichtag). Aufruf täglich über POST /api/cron/aufbewahrung.
 */
export const ONLINE_REQUEST_RETENTION_MONTHS = 6;
export { ONLINE_REQUEST_PREFIX, ONLINE_REQUEST_SUBJECT, onlineRequestKey } from "@/lib/online-request";

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
    // eingehend nur ohne external_id (sonst kein Formular-Eingang); ausgehende Antworten tragen die Versand-ID
    const deletable = or(eq(messages.direction, "outbound"), isNull(messages.externalId));
    const linked = appts.length
      ? await tx
          .delete(messages)
          .where(and(eq(messages.organizationId, organizationId), inArray(messages.threadKey, appts.map((a) => onlineRequestKey(a.id))), isNull(messages.patientId), deletable))
          .returning({ id: messages.id })
      : [];
    // verwaist: Termin existiert nicht mehr (z. B. von der Praxis gelöscht) – Stichtag am Eingang der Nachricht
    const orphans = await tx
      .delete(messages)
      .where(
        and(
          eq(messages.organizationId, organizationId),
          like(messages.threadKey, `${ONLINE_REQUEST_PREFIX}%`),
          isNull(messages.patientId),
          deletable,
          lt(messages.receivedAt, cutoff),
          sql`not exists (select 1 from appointments a where a.organization_id = ${messages.organizationId} and (a.external_id = ${messages.threadKey} or a.id::text = substr(${messages.threadKey}, ${ONLINE_REQUEST_PREFIX.length + 1})))`,
        ),
      )
      .returning({ id: messages.id });
    const msgCount = linked.length + orphans.length;
    if (appts.length || msgCount) {
      await audit(
        { organizationId, action: "retention.online_requests", meta: { appointments: appts.length, messages: msgCount, cutoff: cutoff.toISOString() } },
        tx,
      );
    }
    return { appointments: appts.length, messages: msgCount };
  });
}

/**
 * Alle Praxen, je Praxis einzeln abgesichert; Antwort nur mit Zählern. Nur Praxen mit akzeptierter AVV ab Version 0.3
 * (Standardweisung § 3 Nr. 4) – die übrigen werden übersprungen und gezählt, bis die Inhaber:in die AVV bestätigt
 * (Hinweis in den Einstellungen, src/app/(app)/einstellungen/avv-banner.tsx).
 */
export async function purgeStaleOnlineRequestsAll(
  now = new Date(),
): Promise<{ organizations: number; skipped: number; appointments: number; messages: number; errors: number }> {
  const orgs = await db.select({ id: organizations.id, settings: organizations.settings }).from(organizations);
  let a = 0;
  let m = 0;
  let errors = 0;
  let skipped = 0;
  for (const o of orgs) {
    if (!avvAcceptedAtLeast(o.settings, RETENTION_MIN_AVV)) {
      skipped++;
      continue;
    }
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
  return { organizations: orgs.length, skipped, appointments: a, messages: m, errors };
}
