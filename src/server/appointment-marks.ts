import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { withOrg } from "@/db";
import { appointments } from "@/db/schema";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { invoiceRelevant, markFor, type AppointmentMark } from "@/lib/appointment-marks";
import { billedIdsInTx } from "./appointments";

const a0 = alias(appointments, "a0");

/**
 * Symbole „N“ (Neupatient:in) und „R“ (Rechnung offen/geschrieben) für die Termine einer Kalenderansicht – zwei Abfragen
 * für alle Termine zusammen (keine N+1), in einer Transaktion mit Praxis-Kontext (RLS) und zusätzlich auf die Praxis
 * gefiltert. Status, Ende und Patient:in kommen aus der DB (nicht vom Aufrufer); fremde IDs liefern nichts. Regeln siehe src/lib/appointment-marks.ts. „R“ nur mit Recht auf Belege (invoices.read), sonst null.
 * Index: appointments_org_patient (organization_id, patient_id, starts_at), treatment_records_patient.
 */
export async function appointmentMarks(auth: AuthContext, appointmentIds: readonly string[], now = new Date()): Promise<Map<string, AppointmentMark>> {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const ids = [...new Set(appointmentIds.filter((id) => z.uuid().safeParse(id).success))];
  const out = new Map<string, AppointmentMark>();
  if (!ids.length) return out;
  const withInvoice = auth.can("invoices.read");
  return withOrg(org, async (tx) => {
    // Termine aus der DB (nur dieser Praxis) samt N-Regel in einer Abfrage
    const rows = await tx
      .select({
        id: a0.id,
        status: a0.status,
        endsAt: a0.endsAt,
        patientId: a0.patientId,
        // Spalten der äußeren Abfrage ausdrücklich über den Alias a0 (Drizzle schreibt sie in der Feldliste unqualifiziert,
        // in den Unterabfragen würden sie sonst auf die innere Tabelle zeigen)
        isNew: sql<boolean>`(
          a0.patient_id is not null
          -- aus der Vorgänger-Software übernommen → war schon Patient:in
          and not exists (select 1 from patients p where p.organization_id = ${org} and p.id = a0.patient_id and p.external_ids ? 'legacyExcel')
          -- früherer wahrgenommener bzw. geplanter Termin (nicht abgesagt, nicht „nicht erschienen“); bei gleicher
          -- Startzeit entscheidet die ID, damit genau einer der beiden das N trägt
          and not exists (select 1 from appointments b where b.organization_id = ${org} and b.patient_id = a0.patient_id
                and b.id <> a0.id and b.status not in ('cancelled', 'no_show')
                and (b.starts_at < a0.starts_at or (b.starts_at = a0.starts_at and b.id < a0.id)))
          -- frühere dokumentierte Behandlung
          and not exists (select 1 from treatment_records t where t.organization_id = ${org} and t.patient_id = a0.patient_id
                and t.treated_at < a0.starts_at)
        )`,
      })
      .from(a0)
      .where(and(eq(a0.organizationId, org), inArray(a0.id, ids), isNotNull(a0.patientId)));
    const billable: string[] = withInvoice ? rows.filter((r) => invoiceRelevant(r, now)).map((r) => r.id) : [];
    const billed = billable.length ? await billedIdsInTx(tx, org, billable) : new Set<string>();
    for (const r of rows) {
      const m = markFor(r, now, r.isNew === true, billed.has(r.id));
      if (!withInvoice) m.invoice = null;
      if (m.newPatient || m.invoice) out.set(r.id, m);
    }
    return out;
  });
}
