import "server-only";
import { and, eq, inArray, notInArray, or, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { invoiceLines, invoices, treatmentRecords } from "@/db/schema";

/**
 * Abrechnungsstand je Termin – EINE Regel für das R-Symbol im Kalender (writtenIdsInTx), die Zieh-/Verschiebe-Sperre
 * „abgerechnet“ (billedIdsInTx, auch bei Statuswechsel und im Formular) und dieselbe wie die Doppelabrechnungs-Prüfung
 * (assertNotInvoiced in src/server/invoices.ts): Für den Termin ODER einen zu ihm gehörenden Doku-Eintrag
 * (treatment_records.appointment_id = Termin) steht eine Position auf einem Beleg, der weder Entwurf noch storniert
 * ist. Gutschriften zählen nie. Anzahlungen nur mit `deposits: true` – sie sind noch keine Rechnung (kein R), sperren
 * aber das Verschieben (ein Termin mit Anzahlung wird nicht stillschweigend verlegt).
 *
 * Zwei Abfragen für alle Termine zusammen, jeweils auf die Praxis gefiltert (zusätzlich zu RLS).
 * Indizes: treatment_records_appointment (organization_id, appointment_id), invoice_lines_appointment
 * (organization_id, appointment_id), invoice_lines_treatment_record (organization_id, treatment_record_id).
 */
export async function invoicedAppointmentIdsInTx(tx: Tx, org: string, appointmentIds: readonly string[], opts: { deposits: boolean }): Promise<Set<string>> {
  const ids = [...new Set(appointmentIds)];
  if (!ids.length) return new Set();
  const recs = await tx
    .select({ id: treatmentRecords.id, appointmentId: treatmentRecords.appointmentId })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.appointmentId, ids)));
  const apptOfRec = new Map(recs.map((r) => [r.id, r.appointmentId!]));
  const conds: SQL[] = [inArray(invoiceLines.appointmentId, ids)];
  if (recs.length) conds.push(inArray(invoiceLines.treatmentRecordId, [...apptOfRec.keys()]));
  const lines = await tx
    .selectDistinct({ appointmentId: invoiceLines.appointmentId, recordId: invoiceLines.treatmentRecordId })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.organizationId, org),
        eq(invoices.organizationId, org),
        or(...conds),
        notInArray(invoices.status, ["cancelled", "draft"]),
        notInArray(invoices.kind, opts.deposits ? ["credit_note"] : ["deposit", "credit_note"]),
      ),
    );
  const wanted = new Set(ids);
  const out = new Set<string>();
  for (const l of lines) {
    if (l.appointmentId && wanted.has(l.appointmentId)) out.add(l.appointmentId);
    const viaRec = l.recordId ? apptOfRec.get(l.recordId) : undefined;
    if (viaRec) out.add(viaRec);
  }
  return out;
}
