import { checkBatchUsable } from "@/server/hygiene";
import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { appointments, organizations, patients, prescriptions, treatmentRecords, type FootPoint } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/permissions";
import { chainHash, treatmentContent } from "@/lib/records";
import { assertCan } from "./authz";
import { gkvGuard } from "@/lib/features";
import {
  FREQUENCY_NOTE_MIN,
  RULES_VERSION,
  acceptsUnit,
  anlage3Findings,
  evaluatePrescription,
  frequencyDeviation,
  frequencyDeviationText,
  statusAfterUnit,
  type FrequencyDeviation,
  type PrescriptionStatus,
} from "@/lib/rules/prescription";
import { berlinDateIso } from "@/lib/format";

/**
 * Gemeinsame Logik zum Anlegen eines Behandlungseintrags (Hash-Kette je Patient, append-only).
 * Genutzt von der Einzel-Doku (/kunden/[id]/doku) und der Listen-Doku im Pflegeheim-Modus.
 */

export type RecordCtx = { org: string; userId: string; role: Role };

export type NewTreatment = {
  patientId: string;
  appointmentId?: string | null;
  prescriptionId?: string | null;
  findings: string | null;
  servicesText: string | null;
  material?: string | null;
  sterileBatchCode?: string | null;
  reaction?: string | null;
  recommendation?: string | null;
  footPoints?: FootPoint[];
  structured?: Record<string, unknown>;
  missingPhotoReason?: string | null;
  aiAssisted?: boolean;
  /** Begründung, wenn die Behandlung von der verordneten Frequenz abweicht (Pflicht, s. prescriptionGate) */
  frequencyDeviationNote?: string | null;
};

/** Fachlicher Fehler – wird geworfen, damit die umgebende Transaktion zurückgerollt wird. */
export class RecordInputError extends Error {}

/** Serialisiert die Hash-Kette eines Patienten (parallele Einträge dürfen nicht verzweigen). */
export async function lockPatientChain(tx: Tx, patientId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"rec:" + patientId}))`);
}

/** Prüft Patient, Termin und Verordnung. Gibt eine Fehlermeldung zurück oder null. Vorher lockPatientChain aufrufen. */
export async function checkTreatmentRefs(tx: Tx, ctx: RecordCtx, input: Pick<NewTreatment, "patientId" | "appointmentId" | "prescriptionId">): Promise<string | null> {
  const { org } = ctx;
  const [p] = await tx.select({ id: patients.id }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, input.patientId)));
  if (!p) return "Patient nicht gefunden.";
  if (input.appointmentId) {
    const [a] = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId), eq(appointments.patientId, input.patientId)));
    if (!a) return "Der Termin gehört nicht zu diesem Patienten.";
  }
  if (input.prescriptionId) {
    const [vo] = await tx
      .select({ status: prescriptions.status, units: prescriptions.units })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId), eq(prescriptions.patientId, input.patientId)));
    if (!vo) return "Die Verordnung gehört nicht zu diesem Patienten.";
    const used = await unitsUsed(tx, org, input.prescriptionId);
    if (!acceptsUnit(vo.status, used, vo.units)) return "Auf diese Verordnung kann keine weitere Einheit gebucht werden (abgeschlossen oder alle Einheiten erbracht).";
  }
  return null;
}

/**
 * Prüfungen vor dem Buchen einer Einheit auf eine Verordnung am Tag `date` (Berliner Datum):
 *  - Frist überschritten (Beginnfrist HeilM-RL § 15 / Vertrag § 6 Abs. 4, Unterbrechung Vertrag § 7 Abs. 7) → Fehler
 *  - Pflichtangaben, ohne die die Behandlung nicht beginnen darf (Anlage 3 Ziff. 3/Buchst. a, n) → Fehler
 *    (nur Verordnungen nach aktuellem Regelwerk)
 *  - Abweichung von der Frequenz über ± 2 Werktage (Vertrag § 7 Abs. 6, HeilM-RL § 16 Abs. 3) → Begründung Pflicht
 */
export async function prescriptionGate(
  tx: Tx,
  org: string,
  input: { prescriptionId: string; date: string; frequencyDeviationNote?: string | null },
): Promise<{ error: string } | { deviation: FrequencyDeviation | null }> {
  const [vo] = await tx.select().from(prescriptions).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId)));
  if (!vo) return { error: "Verordnung nicht gefunden." };
  const recs = await tx
    .select({ treatedAt: treatmentRecords.treatedAt })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, input.prescriptionId)));
  const dates = recs.map((r) => berlinDateIso(r.treatedAt)).sort();
  const ev = evaluatePrescription({ issuedAt: vo.issuedAt, urgent: vo.urgent, units: vo.units, status: vo.status, frequency: vo.frequencyPerWeek, treatmentDates: dates, today: input.date, startBy: vo.startBy });
  if (ev.expiry === "start_missed") return { error: `Frist überschritten: Die Behandlung hätte bis ${ev.startBy.split("-").reverse().join(".")} beginnen müssen – die Verordnung ist ungültig.` };
  if (ev.expiry === "interrupted") return { error: "Frist überschritten: Seit der letzten Behandlung sind mehr als 12 Wochen vergangen – die Verordnung ist ungültig." };
  if (vo.rulesVersion === RULES_VERSION) {
    const [o] = await tx.select({ ik: organizations.ik }).from(organizations).where(eq(organizations.id, org));
    const start = anlage3Findings({ ...vo, icd10Second: vo.icd10Second, frequency: vo.frequencyPerWeek, practiceIk: o?.ik ?? null }).find((f) => f.level === "start");
    if (start) return { error: `Behandlung auf diese Verordnung noch nicht möglich: ${start.message}` };
  }
  const deviation = frequencyDeviation({ group: vo.diagnosisGroup, frequency: vo.frequencyPerWeek, lastDate: dates.at(-1), date: input.date });
  if (deviation && (input.frequencyDeviationNote ?? "").trim().length < FREQUENCY_NOTE_MIN) {
    return { error: `${frequencyDeviationText(deviation)} Bitte die Absprache mit der Ärztin/dem Arzt als Begründung eintragen.` };
  }
  return { deviation };
}

export async function unitsUsed(tx: Tx, org: string, prescriptionId: string): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, prescriptionId)));
  return Number(r?.n ?? 0);
}

/**
 * Legt den Eintrag an (innerhalb einer withOrg-Transaktion). Wirft RecordInputError bei ungültigen Bezügen.
 * Zählt bei gesetzter Verordnung eine Einheit (Status open → active → completed).
 */
export async function insertTreatmentRecord(tx: Tx, ctx: RecordCtx, input: NewTreatment): Promise<{ id: string }> {
  const { org, userId, role } = ctx;
  await lockPatientChain(tx, input.patientId);
  const refError = await checkTreatmentRefs(tx, ctx, input);
  if (refError) throw new RecordInputError(refError);
  // Gesperrte oder abgelaufene Sterilgut-Chargen dürfen nicht dokumentiert werden.
  // Unbekannte Chargen bleiben erlaubt (Praxen ohne Hygiene-Modul / Fremdetiketten).
  if (input.sterileBatchCode) {
    const batch = await checkBatchUsable(tx, org, input.sterileBatchCode);
    if (!batch.ok && (batch.reason === "rejected" || batch.reason === "expired")) {
      throw new RecordInputError(
        batch.reason === "rejected"
          ? "Diese Sterilgut-Charge ist gesperrt und darf nicht verwendet werden."
          : "Diese Sterilgut-Charge ist abgelaufen.",
      );
    }
  }

  const treatedAt = new Date();
  let structured = input.structured ?? {};
  if (input.prescriptionId) {
    const gate = await prescriptionGate(tx, org, { prescriptionId: input.prescriptionId, date: berlinDateIso(treatedAt), frequencyDeviationNote: input.frequencyDeviationNote });
    if ("error" in gate) throw new RecordInputError(gate.error);
    // Abweichung + Begründung gehen in die Hash-Kette ein (structured) – Dokumentation „auf der Verordnung“ (Anlage 3 Buchst. i a)
    if (gate.deviation) structured = { ...structured, frequencyDeviation: { ...gate.deviation, note: input.frequencyDeviationNote!.trim().slice(0, 500) } };
  }
  const [prev] = await tx
    .select({ hash: treatmentRecords.hash })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.patientId, input.patientId)))
    .orderBy(desc(treatmentRecords.createdAt))
    .limit(1);
  const values = {
    findings: input.findings,
    servicesText: input.servicesText,
    material: input.material ?? null,
    sterileBatchCode: input.sterileBatchCode ?? null,
    reaction: input.reaction ?? null,
    recommendation: input.recommendation ?? null,
    footPoints: input.footPoints ?? [],
    structured,
    appointmentId: input.appointmentId ?? null,
    missingPhotoReason: input.missingPhotoReason ?? null,
    aiAssisted: input.aiAssisted ?? false,
    countersignRequired: role === "trainee",
  };
  const content = treatmentContent({
    patientId: input.patientId,
    authorId: userId,
    treatedAt: treatedAt.toISOString(),
    ...values,
    prescriptionId: input.prescriptionId ?? null,
  });
  const hash = chainHash(prev?.hash ?? null, content);
  const [rec] = await tx
    .insert(treatmentRecords)
    .values({
      organizationId: org,
      patientId: input.patientId,
      authorId: userId,
      treatedAt,
      prescriptionId: input.prescriptionId ?? null,
      ...values,
      prevHash: prev?.hash ?? null,
      hash,
    })
    .returning({ id: treatmentRecords.id });

  if (input.appointmentId) {
    await tx
      .update(appointments)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId), eq(appointments.patientId, input.patientId)));
  }
  if (input.prescriptionId) {
    const [vo] = await tx
      .select({ status: prescriptions.status, units: prescriptions.units })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId)));
    const used = await unitsUsed(tx, org, input.prescriptionId);
    const next = statusAfterUnit(vo.status as PrescriptionStatus, used, vo.units);
    if (next !== vo.status) {
      await tx.update(prescriptions).set({ status: next }).where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId)));
    }
  }
  return rec;
}

/** Komfortfunktion: eigener Mandanten-Kontext + Audit. Gibt Fehlertext statt Exception zurück. */
export async function createTreatmentRecord(auth: AuthContext, input: NewTreatment, auditMeta: Record<string, unknown> = {}): Promise<{ id: string } | { error: string }> {
  assertCan(auth, "medical.write");
  if (input.prescriptionId) {
    const blocked = gkvGuard(auth.organization, "verordnungen");
    if (blocked) return blocked;
  }
  const org = auth.organization.id;
  try {
    const rec = await withOrg(org, (tx) => insertTreatmentRecord(tx, { org, userId: auth.user.id, role: auth.role }, input));
    await audit({ organizationId: org, userId: auth.user.id, action: "record.create", entity: "treatment_record", entityId: rec.id, meta: { patientId: input.patientId, prescriptionId: input.prescriptionId ?? null, ...auditMeta } });
    return rec;
  } catch (e) {
    if (e instanceof RecordInputError) return { error: e.message };
    throw e;
  }
}
