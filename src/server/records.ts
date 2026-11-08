import { checkBatchUsable } from "@/server/hygiene";
import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { appointments, patients, prescriptions, treatmentRecords, type FootPoint } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/permissions";
import { chainHash, treatmentContent } from "@/lib/records";
import { acceptsUnit, statusAfterUnit, type PrescriptionStatus } from "@/lib/rules/prescription";

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
  if (!p) return "Kunde nicht gefunden.";
  if (input.appointmentId) {
    const [a] = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.id, input.appointmentId), eq(appointments.patientId, input.patientId)));
    if (!a) return "Der Termin gehört nicht zu diesem Kunden.";
  }
  if (input.prescriptionId) {
    const [vo] = await tx
      .select({ status: prescriptions.status, units: prescriptions.units })
      .from(prescriptions)
      .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, input.prescriptionId), eq(prescriptions.patientId, input.patientId)));
    if (!vo) return "Die Verordnung gehört nicht zu diesem Kunden.";
    const used = await unitsUsed(tx, org, input.prescriptionId);
    if (!acceptsUnit(vo.status, used, vo.units)) return "Auf diese Verordnung kann keine weitere Einheit gebucht werden (abgeschlossen oder alle Einheiten erbracht).";
  }
  return null;
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

  const [prev] = await tx
    .select({ hash: treatmentRecords.hash })
    .from(treatmentRecords)
    .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.patientId, input.patientId)))
    .orderBy(desc(treatmentRecords.createdAt))
    .limit(1);
  const treatedAt = new Date();
  const values = {
    findings: input.findings,
    servicesText: input.servicesText,
    material: input.material ?? null,
    sterileBatchCode: input.sterileBatchCode ?? null,
    reaction: input.reaction ?? null,
    recommendation: input.recommendation ?? null,
    footPoints: input.footPoints ?? [],
    structured: input.structured ?? {},
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
