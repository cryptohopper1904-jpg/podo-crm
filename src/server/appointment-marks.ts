import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { appointments } from "@/db/schema";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { DOCTOLIB_CSV_SOURCE, EXCEL_IMPORT_SOURCE_PREFIX, invoiceRelevant, markFor, type AppointmentMark } from "@/lib/appointment-marks";
import { invoicedAppointmentIdsInTx } from "./appointment-invoiced";
import { billedIdsInTx } from "./appointments";

const a0 = alias(appointments, "a0");

/**
 * „Rechnung geschrieben“ für das R-Symbol: wie die Zieh-Sperre (invoicedAppointmentIdsInTx), aber ohne Anzahlungen –
 * sie werden erst auf die Rechnung angerechnet.
 */
function writtenIdsInTx(tx: Tx, org: string, appointmentIds: string[]): Promise<Set<string>> {
  return invoicedAppointmentIdsInTx(tx, org, appointmentIds, { deposits: false });
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
 * `marks: false` bzw. `dragLock: false` (kein Verschieben) lassen den jeweiligen Teil weg; `markIds` beschränkt die Symbole
 * auf einen Teil der Termine (Monatsansicht: nur die Tagesliste des gewählten Tags).
 * Index: appointments_org_patient (organization_id, patient_id, starts_at), treatment_records_patient.
 */
export async function calendarAppointmentInfo(
  auth: AuthContext,
  appointmentIds: readonly string[],
  opts: { marks: boolean; dragLock: boolean; markIds?: readonly string[]; now?: Date },
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
    const only = opts.markIds ? new Set(opts.markIds) : null;
    const markIds = only ? ids.filter((id) => only.has(id)) : ids;
    if (!opts.marks || !markIds.length) return { marks, billed };
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
          -- übernommen (jede Fremd-ID bzw. Import-Marker: Excel-Import, Doctolib …) → war schon Patient:in; ältere
          -- Importe ohne Fremd-ID erkennt man an extra.legacyExcel bzw. an der Quelle (Doctolib-CSV, Excel-Import)
          and not exists (select 1 from patients p where p.organization_id = ${org} and p.id = a0.patient_id
                and (p.external_ids <> '{}'::jsonb or p.extra ? 'legacyExcel'
                     or p.source = ${DOCTOLIB_CSV_SOURCE} or starts_with(p.source, ${EXCEL_IMPORT_SOURCE_PREFIX})))
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
      .where(and(eq(a0.organizationId, org), inArray(a0.id, markIds), isNotNull(a0.patientId)));
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
