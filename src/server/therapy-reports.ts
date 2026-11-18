import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { prescriptions, therapyReports, treatmentRecords, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { gkvGuard } from "@/lib/features";
import { berlinDateIso } from "@/lib/format";
import { renderTherapyReportPdf } from "@/lib/gkv-pdf";
import { THERAPY_REPORT_HPNR } from "@/lib/rules/prescription";
import { toZlHpnr } from "@/lib/rules/podologie-verguetung";
import { assertCan } from "./authz";
import { letterOrg, loadPrescriptionWithPatient, pdfPatient, pdfPrescription } from "./gkv-documents";
import { loadLogos } from "./practice-logos";

/**
 * Therapiebericht je Verordnung (Position 78530, GKV Paket B Teil 2): Befund, Verlauf, Ergebnis, Empfehlung, Freitext.
 * Anlegen/Ändern nur mit medical.write, ansehen/PDF mit medical.read. Ab „abrechnungsreif“ gesperrt (DB-Trigger,
 * Migration 0065), weil das Berichtsdatum als Einheit 78530 in den Preis-Snapshot eingeht. Versand bleibt manuell
 * (Download/Druck) – für die Ärztin/den Arzt ist keine E-Mail-Adresse gespeichert.
 */

const text = z.preprocess((v) => (typeof v === "string" ? v.trim() || null : v ?? null), z.string().max(4000, "Höchstens 4000 Zeichen je Feld.").nullable());

export const therapyReportInput = z
  .object({
    prescriptionId: z.string().uuid(),
    patientId: z.string().uuid(),
    // echtes Kalenderdatum (2026-02-30 → Formularfehler statt Datenbankfehler, Review R2-20)
    reportDate: z.iso.date({ message: "Berichtsdatum fehlt oder ist kein gültiges Datum." }),
    findings: text,
    course: text,
    result: text,
    recommendation: text,
    notes: text,
  })
  .refine((d) => !!(d.findings || d.course || d.result || d.recommendation), { message: "Bitte mindestens Befund, Verlauf, Ergebnis oder Empfehlung ausfüllen." });
export type TherapyReportInput = z.infer<typeof therapyReportInput>;

export type TherapyReportRow = typeof therapyReports.$inferSelect;

/** Steht 78530 (Therapiebericht) auf der Verordnung? */
export const reportOrdered = (positions: { position?: string }[]) => positions.some((p) => (toZlHpnr(p.position) ?? p.position) === THERAPY_REPORT_HPNR);

export async function reportsFor(tx: Tx, org: string, prescriptionIds: string[]): Promise<Map<string, TherapyReportRow>> {
  if (!prescriptionIds.length) return new Map();
  const rows = await tx.select().from(therapyReports).where(and(eq(therapyReports.organizationId, org), inArray(therapyReports.prescriptionId, prescriptionIds)));
  return new Map(rows.map((r) => [r.prescriptionId, r]));
}

/** Berichtsdatum für den Preis-Snapshot (null = kein Bericht) */
export async function therapyReportDate(tx: Tx, org: string, prescriptionId: string): Promise<string | null> {
  return (await reportsFor(tx, org, [prescriptionId])).get(prescriptionId)?.reportDate ?? null;
}

function dbMessage(e: unknown): string | null {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code ?? err?.code;
  if (code === "P0001") return err?.cause?.message ?? err?.message ?? null;
  if (code === "23505") return "Für diese Verordnung gibt es bereits einen Therapiebericht – bitte Seite neu laden.";
  return null;
}

/** Therapiebericht anlegen bzw. ändern (einer je Verordnung) */
export async function saveTherapyReport(auth: AuthContext, raw: TherapyReportInput): Promise<{ id: string; created: boolean } | { error: string }> {
  assertCan(auth, "medical.write");
  const blocked = gkvGuard(auth.organization, "verordnungen");
  if (blocked) return blocked;
  const parsed = therapyReportInput.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const d = parsed.data;
  if (d.reportDate > berlinDateIso()) return { error: "Das Berichtsdatum darf nicht in der Zukunft liegen." };
  const org = auth.organization.id;
  try {
    const res = await withOrg(org, async (tx): Promise<{ id: string; created: boolean } | { error: string }> => {
      const [vo] = await tx
        .select({ status: prescriptions.status, issuedAt: prescriptions.issuedAt })
        .from(prescriptions)
        .where(and(eq(prescriptions.organizationId, org), eq(prescriptions.id, d.prescriptionId), eq(prescriptions.patientId, d.patientId)))
        .for("update");
      if (!vo) return { error: "Verordnung nicht gefunden." };
      if (vo.status === "billing_ready" || vo.status === "billed") return { error: "Die Verordnung ist abrechnungsreif bzw. abgerechnet – der Therapiebericht ist nicht mehr änderbar." };
      if (vo.status === "cancelled") return { error: "Die Verordnung ist storniert." };
      if (d.reportDate < vo.issuedAt) return { error: "Das Berichtsdatum liegt vor dem Ausstellungsdatum der Verordnung." };
      // Bericht über die Behandlung: nicht vor dem ersten Behandlungstag (Review R2-20)
      const [first] = await tx
        .select({ at: treatmentRecords.treatedAt })
        .from(treatmentRecords)
        .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, d.prescriptionId)))
        .orderBy(asc(treatmentRecords.treatedAt))
        .limit(1);
      if (first && d.reportDate < berlinDateIso(first.at)) return { error: `Das Berichtsdatum liegt vor dem ersten Behandlungstag (${berlinDateIso(first.at).split("-").reverse().join(".")}).` };
      const values = { reportDate: d.reportDate, findings: d.findings, course: d.course, result: d.result, recommendation: d.recommendation, notes: d.notes };
      const [existing] = await tx.select({ id: therapyReports.id }).from(therapyReports).where(and(eq(therapyReports.organizationId, org), eq(therapyReports.prescriptionId, d.prescriptionId)));
      if (existing) {
        await tx.update(therapyReports).set({ ...values, updatedBy: auth.user.id, updatedAt: new Date() }).where(and(eq(therapyReports.organizationId, org), eq(therapyReports.id, existing.id)));
        return { id: existing.id, created: false };
      }
      const [row] = await tx
        .insert(therapyReports)
        .values({ ...values, organizationId: org, prescriptionId: d.prescriptionId, patientId: d.patientId, createdBy: auth.user.id })
        .returning({ id: therapyReports.id });
      return { id: row.id, created: true };
    });
    if ("error" in res) return res;
    // ohne Inhalte (Gesundheitsdaten) im Protokoll
    await audit({ organizationId: org, userId: auth.user.id, action: res.created ? "prescription.therapy_report_create" : "prescription.therapy_report_update", entity: "prescription", entityId: d.prescriptionId, meta: { reportId: res.id, reportDate: d.reportDate, patientId: d.patientId } });
    return res;
  } catch (e) {
    const msg = dbMessage(e);
    if (msg) return { error: msg };
    throw e;
  }
}

/** Bericht + Verordnung + Person zum Ansehen (medical.read; nicht bei „nur Privat“, Review R3-10) */
export async function getTherapyReport(auth: AuthContext, prescriptionId: string, patientId: string) {
  assertCan(auth, "medical.read");
  if (gkvGuard(auth.organization, "verordnungen")) return null;
  const org = auth.organization.id;
  return withOrg(org, async (tx) => {
    const row = await loadPrescriptionWithPatient(tx, org, prescriptionId, patientId);
    if (!row) return null;
    const report = (await reportsFor(tx, org, [prescriptionId])).get(prescriptionId) ?? null;
    return { ...row, report };
  });
}

/** Therapiebericht als PDF für die verordnende Ärztin/den Arzt (Praxiskopf mit Logo) */
export async function therapyReportPdf(auth: AuthContext, prescriptionId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  assertCan(auth, "medical.read");
  if (gkvGuard(auth.organization, "verordnungen")) return null;
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const row = await loadPrescriptionWithPatient(tx, org, prescriptionId);
    if (!row) return null;
    const report = (await reportsFor(tx, org, [prescriptionId])).get(prescriptionId);
    if (!report) return null;
    const o = await letterOrg(tx, org);
    if (!o) return null;
    const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, report.updatedBy ?? report.createdBy));
    const recs = await tx
      .select({ treatedAt: treatmentRecords.treatedAt })
      .from(treatmentRecords)
      .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.prescriptionId, prescriptionId)))
      .orderBy(asc(treatmentRecords.treatedAt));
    return { ...row, report, o, author: author?.name ?? null, dates: [...new Set(recs.map((r) => berlinDateIso(r.treatedAt)))] };
  });
  if (!data) return null;
  const bytes = await renderTherapyReportPdf({
    organization: data.o,
    logos: await loadLogos(org),
    patient: pdfPatient(data.p, data.vo),
    prescription: pdfPrescription(data.vo),
    report: { ...data.report, author: data.author },
    treatmentDates: data.dates,
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.therapy_report_pdf", entity: "prescription", entityId: prescriptionId, meta: { patientId: data.p.id } });
  return { bytes, filename: `Therapiebericht-${data.report.reportDate}-${prescriptionId.slice(0, 8)}.pdf` };
}
