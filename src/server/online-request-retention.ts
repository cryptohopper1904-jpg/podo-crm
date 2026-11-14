import "server-only";
import { and, eq, isNull, lt, ne, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, messages, organizations } from "@/db/schema";

/**
 * Speicherdauer unbestätigter Online-Terminanfragen (/buchen): Kommt kein Termin zustande, werden die Anfrage
 * (Termin-Vormerkung ohne zugeordnete Person) und ihre Posteingangs-Nachricht spätestens nach 6 Monaten gelöscht –
 * so steht es in den Datenschutzhinweisen der Praxis (src/app/p/[slug]/_site/legal-content.tsx).
 * Ist die Anfrage einer Akte zugeordnet, gilt der Termin als zustande gekommen (Aufbewahrung über die Akte).
 * Aufruf täglich über POST /api/cron/aufbewahrung.
 */
export const ONLINE_REQUEST_RETENTION_MONTHS = 6;
/** Betreff der Posteingangs-Nachricht einer Online-Anfrage (src/app/buchen/[slug]/actions.ts) */
export const ONLINE_REQUEST_SUBJECT = "Neue Online-Buchung (unbestätigt)";

export function onlineRequestCutoff(now: Date): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - ONLINE_REQUEST_RETENTION_MONTHS);
  return d;
}

/** Löscht abgelaufene unbestätigte Online-Anfragen einer Praxis; liefert die Anzahl gelöschter Einträge. */
export async function purgeStaleOnlineRequests(organizationId: string, now = new Date()): Promise<{ appointments: number; messages: number }> {
  const cutoff = onlineRequestCutoff(now);
  return withOrg(organizationId, async (tx) => {
    const appts = await tx
      .delete(appointments)
      .where(
        and(
          eq(appointments.organizationId, organizationId),
          eq(appointments.source, "online"),
          isNull(appointments.patientId),
          ne(appointments.status, "done"),
          lt(appointments.createdAt, cutoff),
          // nichts löschen, worauf Doku oder Rechnungen verweisen
          sql`not exists (select 1 from treatment_records t where t.appointment_id = ${appointments.id})`,
          sql`not exists (select 1 from invoice_lines l where l.appointment_id = ${appointments.id})`,
        ),
      )
      .returning({ id: appointments.id });
    const msgs = await tx
      .delete(messages)
      .where(and(eq(messages.organizationId, organizationId), isNull(messages.patientId), eq(messages.subject, ONLINE_REQUEST_SUBJECT), lt(messages.receivedAt, cutoff)))
      .returning({ id: messages.id });
    return { appointments: appts.length, messages: msgs.length };
  });
}

/** Alle Praxen; Antwort nur mit Zählern. */
export async function purgeStaleOnlineRequestsAll(now = new Date()): Promise<{ organizations: number; appointments: number; messages: number }> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  let a = 0;
  let m = 0;
  for (const o of orgs) {
    const r = await purgeStaleOnlineRequests(o.id, now);
    a += r.appointments;
    m += r.messages;
  }
  return { organizations: orgs.length, appointments: a, messages: m };
}
