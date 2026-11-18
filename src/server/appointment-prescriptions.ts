import "server-only";
import { and, desc, eq, inArray, isNull, max, ne, notExists } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { appointments, patients, prescriptions, treatmentRecords } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { planningWarnings } from "@/lib/rules/prescription";
import { afterPrescriptionWarning } from "@/lib/rules/follow-up";
import { assertCan } from "./authz";
import { bookablePrescriptions, type BookablePrescription } from "./prescriptions";

/**
 * Termine gegen Verordnung: Auswahl im Terminformular (vorgeschlagen: offene/aktive Verordnung der Person) und
 * Warnungen beim Planen (Restmenge inkl. schon geplanter Termine, Beginnfrist, 12-Wochen-Unterbrechung, Frequenz).
 * Nur Hinweise – gespeichert wird trotzdem. Ohne GKV (billingMode private_only) gibt es keine Auswahl.
 */

export type PlanningOption = { id: string; label: string; remaining: number; units: number };
export type PlanningResult = { options: PlanningOption[]; selectedId: string | null; warnings: string[] };

/** geplante, noch nicht dokumentierte Termine je Verordnung (Berliner Datum) */
async function plannedDates(tx: Tx, org: string, ids: string[], excludeAppointmentId?: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const rows = await tx
    .select({ id: appointments.id, prescriptionId: appointments.prescriptionId, startsAt: appointments.startsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, org),
        inArray(appointments.prescriptionId, ids),
        inArray(appointments.status, ["planned", "confirmed"]),
        notExists(tx.select({ x: treatmentRecords.id }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.appointmentId, appointments.id)))),
      ),
    );
  for (const r of rows) {
    if (!r.prescriptionId || r.id === excludeAppointmentId) continue;
    map.set(r.prescriptionId, [...(map.get(r.prescriptionId) ?? []), berlinDateIso(r.startsAt)]);
  }
  return map;
}

function warningsFor(vo: BookablePrescription, planned: string[], newDates: string[]): string[] {
  return planningWarnings({
    group: vo.diagnosisGroup,
    frequency: vo.frequency,
    urgent: vo.urgent,
    issuedAt: vo.issuedAt,
    startBy: vo.startBy,
    started: vo.started,
    reopenedOn: vo.reopenedAt,
    units: vo.units,
    treatmentDates: vo.dates,
    plannedDates: planned,
    newDates,
  });
}

export async function planningForPatient(
  auth: AuthContext,
  input: { patientId: string; dates: string[]; prescriptionId?: string | null },
): Promise<PlanningResult> {
  assertCan(auth, "appointments.read");
  if (!feature(auth.organization, "verordnungen")) return { options: [], selectedId: null, warnings: [] };
  const org = auth.organization.id;
  const medical = auth.can("medical.read");
  return withOrg(org, async (tx) => {
    const vos = await bookablePrescriptions(tx, org, input.patientId, { medical });
    const planned = await plannedDates(tx, org, vos.map((v) => v.id));
    const options = vos.map((v) => ({ id: v.id, label: v.label, remaining: v.remaining, units: v.units }));
    // Vorschlag: ausdrücklich gewählte, sonst die älteste laufende Verordnung (Vertrag § 7 Abs. 5: erst die frühere zu Ende).
    // Ausdrücklich gewählte, die nicht (mehr) buchbar ist → keine stille Ersatzauswahl, sondern Hinweis (PR #111 Nice).
    // Reihenfolge (Review R2-19): erst die ausdrücklich gewählte, nicht mehr buchbare Verordnung melden …
    if (input.prescriptionId && !vos.some((v) => v.id === input.prescriptionId)) {
      return { options, selectedId: null, warnings: ["Die gewählte Verordnung ist nicht mehr buchbar (abgeschlossen, Frist überschritten oder keine Einheit frei) – bitte eine andere wählen oder ohne Verordnung planen."] };
    }
    // … dann: keine laufende Verordnung, Termin nach dem Ende der letzten (GKV-)Verordnung → Hinweis Folgeverordnung
    if (!vos.length) {
      const w = await afterEndWarning(tx, org, input.patientId, input.dates, medical);
      return { options, selectedId: null, warnings: w ? [w] : [] };
    }
    const selectedId = input.prescriptionId === "" ? null : (input.prescriptionId ?? vos[0]?.id ?? null);
    const vo = vos.find((v) => v.id === selectedId);
    const warnings = vo ? warningsFor(vo, planned.get(vo.id) ?? [], input.dates) : [];
    // Einheiten reichen nicht für alle Termine → an die Folgeverordnung erinnern
    if (vo && input.dates.length > vo.remaining - (planned.get(vo.id)?.length ?? 0)) warnings.push("Für Termine über die Restmenge hinaus bitte rechtzeitig eine Folgeverordnung anfordern.");
    return { options, selectedId, warnings };
  });
}

/** Letzte Verordnung der Person beendet und neue Termine danach → Hinweis (nur GKV-Versicherte) */
async function afterEndWarning(tx: Tx, org: string, patientId: string, dates: string[], medical: boolean): Promise<string | null> {
  if (!dates.length) return null;
  const [p] = await tx.select({ type: patients.insuranceType }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
  if (p?.type !== "gkv") return null;
  const [last] = await tx
    .select({ id: prescriptions.id, issuedAt: prescriptions.issuedAt, status: prescriptions.status })
    .from(prescriptions)
    .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.patientId, patientId), ne(prescriptions.status, "cancelled")))
    .orderBy(desc(prescriptions.issuedAt), desc(prescriptions.createdAt))
    .limit(1);
  if (!last) return null;
  const [rec] = await tx
    .select({ at: max(treatmentRecords.treatedAt) })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, last.id)));
  const w = afterPrescriptionWarning({ lastPrescription: { issuedAt: last.issuedAt, status: last.status, lastDate: rec?.at ? berlinDateIso(rec.at) : null }, newDates: dates });
  // ohne medizinisches Leserecht (Empfang) keine Verordnungs-/Behandlungsdaten im Hinweis (Review R2-22)
  return w && !medical ? "Keine laufende Verordnung – Termin nach dem Ende der letzten Verordnung. Bitte Folgeverordnung anfordern (sonst Behandlung als Selbstzahler)." : w;
}

/**
 * Prüft beim Anlegen, ob die Verordnung zur Person gehört und noch läuft (in der Buchungs-Transaktion).
 * Gibt eine Fehlermeldung zurück oder null.
 */
export async function checkAppointmentPrescription(tx: Tx, org: string, patientId: string | null, prescriptionId: string): Promise<string | null> {
  if (!patientId) return "Eine Verordnung lässt sich nur einem Termin mit Patient:in zuordnen.";
  const [vo] = await tx
    .select({ id: prescriptions.id, status: prescriptions.status })
    .from(prescriptions)
    .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, prescriptionId), eq(prescriptions.patientId, patientId), isNull(prescriptions.billedAt)));
  if (!vo) return "Die Verordnung gehört nicht zu dieser Patient:in.";
  if (vo.status !== "open" && vo.status !== "active") return "Auf diese Verordnung können keine Termine mehr geplant werden (abgeschlossen oder Frist überschritten).";
  return null;
}
