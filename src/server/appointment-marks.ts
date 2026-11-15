import "server-only";
import { and, eq, inArray, isNotNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointments, invoiceLines, invoices, treatmentRecords } from "@/db/schema";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { invoiceRelevant, markFor, type AppointmentMark } from "@/lib/appointment-marks";
import { billedIdsInTx } from "./appointments";

const a0 = alias(appointments, "a0");

/**
 * „Rechnung geschrieben“ für das R-Symbol: Für den Termin oder einen zu ihm gehörenden Doku-Eintrag steht eine
 * Position auf einem gültigen Beleg (Rechnung, Quittung, Sammelrechnung, Ausfallhonorar) – nicht Entwurf, nicht
 * storniert, keine Anzahlung (wird erst angerechnet), keine Gutschrift. Dieselbe Regel wie die Doppelabrechnungs-
 * Prüfung (assertNotInvoiced in src/server/invoices.ts: Termin und Doku-Eintrag gelten als dieselbe Leistung).
 * Zwei Abfragen für alle Termine zusammen.
 */
async function writtenIdsInTx(tx: Tx, org: string, appointmentIds: string[]): Promise<Set<string>> {
  if (!appointmentIds.length) return new Set();
  const recs = await tx
    .select({ id: treatmentRecords.id, appointmentId: treatmentRecords.appointmentId })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.appointmentId, appointmentIds)));
  const apptOfRec = new Map(recs.map((r) => [r.id, r.appointmentId!]));
  const conds: SQL[] = [inArray(invoiceLines.appointmentId, appointmentIds)];
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
        notInArray(invoices.kind, ["deposit", "credit_note"]),
      ),
    );
  const wanted = new Set(appointmentIds);
  const out = new Set<string>();
  for (const l of lines) {
    if (l.appointmentId && wanted.has(l.appointmentId)) out.add(l.appointmentId);
    const viaRec = l.recordId ? apptOfRec.get(l.recordId) : undefined;
    if (viaRec) out.add(viaRec);
  }
  return out;
}

export type CalendarAppointmentInfo = {
  /** Symbole N/R je Termin (nur Termine mit mindestens einem Symbol) */
  marks: Map<string, AppointmentMark>;
  /** Zieh-Sperre „abgerechnet“ (billedIdsInTx, gleiche Regel wie beim Verschieben über das Formular) */
  billed: Set<string>;
};

/**
 * Kalender (vollständige Ansicht): Symbole „N“ (Neupatient:in) und „R“ (Rechnung offen/geschrieben) sowie die
 * Zieh-Sperre „abgerechnet“ für die Termine einer Ansicht – in EINER Transaktion mit Praxis-Kontext (RLS), zusätzlich
 * auf die Praxis gefiltert, ohne N+1. Status, Ende und Patient:in kommen aus der DB (nicht vom Aufrufer); fremde IDs
 * liefern nichts. Regeln siehe src/lib/appointment-marks.ts. „R“ nur mit Recht auf Belege (invoices.read).
 * `marks: false` (Monatsansicht) bzw. `dragLock: false` (kein Verschieben) lassen den jeweiligen Teil weg.
 * Index: appointments_org_patient (organization_id, patient_id, starts_at), treatment_records_patient.
 */
export async function calendarAppointmentInfo(
  auth: AuthContext,
  appointmentIds: readonly string[],
  opts: { marks: boolean; dragLock: boolean; now?: Date },
): Promise<CalendarAppointmentInfo> {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const ids = [...new Set(appointmentIds.filter((id) => z.uuid().safeParse(id).success))];
  const marks = new Map<string, AppointmentMark>();
  if (!ids.length || (!opts.marks && !opts.dragLock)) return { marks, billed: new Set() };
  const now = opts.now ?? new Date();
  const withInvoice = auth.can("invoices.read");
  return withOrg(org, async (tx) => {
    const billed = opts.dragLock ? await billedIdsInTx(tx, org, ids) : new Set<string>();
    if (!opts.marks) return { marks, billed };
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
          -- übernommen (jede Fremd-ID: Excel-Import, Doctolib …) → war schon Patient:in; ältere Excel-Importe ohne
          -- Alt-ID erkennt man an extra.legacyExcel
          and not exists (select 1 from patients p where p.organization_id = ${org} and p.id = a0.patient_id
                and (p.external_ids <> '{}'::jsonb or p.extra ? 'legacyExcel'))
          -- früherer wahrgenommener bzw. geplanter Termin (nicht abgesagt, nicht „nicht erschienen“); bei gleicher
          -- Startzeit entscheidet die ID, damit genau einer der beiden das N trägt
          and not exists (select 1 from appointments b where b.organization_id = ${org} and b.patient_id = a0.patient_id
                and b.id <> a0.id and b.status not in ('cancelled', 'no_show')
                and (b.starts_at < a0.starts_at or (b.starts_at = a0.starts_at and b.id < a0.id)))
          -- frühere dokumentierte Behandlung – nicht die Doku zu diesem Termin selbst (auch wenn sie etwas früher datiert)
          and not exists (select 1 from treatment_records t where t.organization_id = ${org} and t.patient_id = a0.patient_id
                and t.appointment_id is distinct from a0.id and t.treated_at < a0.starts_at)
        )`,
      })
      .from(a0)
      .where(and(eq(a0.organizationId, org), inArray(a0.id, ids), isNotNull(a0.patientId)));
    const billable: string[] = withInvoice ? rows.filter((r) => invoiceRelevant(r, now)).map((r) => r.id) : [];
    const written = await writtenIdsInTx(tx, org, billable);
    for (const r of rows) {
      const m = markFor(r, now, r.isNew === true, written.has(r.id));
      if (!withInvoice) m.invoice = null;
      if (m.newPatient || m.invoice) marks.set(r.id, m);
    }
    return { marks, billed };
  });
}

/** Nur die Symbole N/R (siehe calendarAppointmentInfo) */
export async function appointmentMarks(auth: AuthContext, appointmentIds: readonly string[], now = new Date()): Promise<Map<string, AppointmentMark>> {
  return (await calendarAppointmentInfo(auth, appointmentIds, { marks: true, dragLock: false, now })).marks;
}
