"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { EURO_INPUT_MAX_LENGTH, parseEuroInputCents } from "@/lib/euro-input";
import { PRESCRIPTION_STATUSES } from "@/lib/rules/prescription";
import type { OcrSuggestion } from "@/integrations/ocr/schema";
import { extractPrescriptionFromMedia } from "@/server/ocr";
import { changePrescriptionStatus, prescriptionInput, savePrescription, setCopaymentPaid } from "@/server/prescriptions";
import { createCopaymentReceipt, refundCopaymentReceipt, type CopaymentReceiptInput, type CopaymentRefundInput } from "@/server/copayments";
import { addSignature, markPaperSignatures, signatureFields } from "@/server/signatures";
import { saveTherapyReport, therapyReportInput } from "@/server/therapy-reports";
import { markFollowUpRequested, setFollowUpExpected } from "@/server/follow-ups";
import { addCopaymentExemption, exemptionInput, removeCopaymentExemption } from "@/server/copayment-exemptions";

export type PrescriptionFormState = { error?: string } | undefined;

export async function savePrescriptionAction(_: PrescriptionFormState, form: FormData): Promise<PrescriptionFormState> {
  const auth = await requireAuth("medical.write");
  const parsed = prescriptionInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await savePrescription(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
  revalidatePath("/verordnungen");
  const w = res.warnings.length ? `&hinweise=${encodeURIComponent(res.warnings.join("\n"))}` : "";
  redirect(`/kunden/${parsed.data.patientId}/verordnungen?gespeichert=${res.id}${w}`);
}

const statusSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  to: z.enum(PRESCRIPTION_STATUSES),
  interruptionNote: z.string().trim().max(500).optional(),
});

export async function prescriptionStatusAction(_: PrescriptionFormState, form: FormData): Promise<PrescriptionFormState> {
  const auth = await requireAuth("medical.write");
  const parsed = statusSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Ungültige Anfrage." };
  const res = await changePrescriptionStatus(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
  revalidatePath("/verordnungen");
  return undefined;
}

const legacyResetSchema = z.object({ id: z.string().uuid(), patientId: z.string().uuid(), reason: z.string().max(300).optional() });

export type CopaymentPaidState = { error?: string; warning?: string; ok?: string } | undefined;

/** Altvermerk „Zuzahlung erhalten“ (vor Paket B) entfernen – nur „Vermerk war falsch, nichts erhalten“ mit Begründung */
export async function copaymentLegacyResetAction(_: CopaymentPaidState, form: FormData): Promise<CopaymentPaidState> {
  const auth = await requireAuth("invoices.write");
  const parsed = legacyResetSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Ungültige Anfrage – bitte Seite neu laden." };
  const res = await setCopaymentPaid(auth, { ...parsed.data, paid: false });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
  return { ok: "Vermerk entfernt (war falsch – nichts erhalten)." };
}

const copaymentReceiptSchema = z.object({
  prescriptionId: z.string().uuid(),
  patientId: z.string().uuid(),
  /** Betrag in Euro („12,50“, „12.5“, „1.234,56“); leer = offene Zuzahlung – Parser: src/lib/euro-input.ts */
  amount: z.string().max(EURO_INPUT_MAX_LENGTH, "Betrag ungültig – bitte z. B. 12,50 eingeben.").optional(),
  method: z.string().max(20),
  registerReceiptNo: z.string().max(60).optional(),
  confirmOverpay: z.string().optional(),
});

/** „Zuzahlung erhalten“ → Zuzahlungsquittung mit Kassenbuchung (PodoHero-Kasse mit TSE bzw. Vermerk der Praxiskasse) */
export async function copaymentReceiptAction(_: CopaymentPaidState, form: FormData): Promise<CopaymentPaidState> {
  const auth = await requireAuth("invoices.write");
  const parsed = copaymentReceiptSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues.find((i) => i.path[0] === "amount")?.message ?? "Ungültige Anfrage – bitte Seite neu laden." };
  const d = parsed.data;
  const amount = parseEuroInputCents(d.amount);
  if (amount !== null && typeof amount === "object") return { error: amount.error };
  const res = await createCopaymentReceipt(auth, { prescriptionId: d.prescriptionId, patientId: d.patientId, amountCents: amount, method: d.method as CopaymentReceiptInput["method"], registerReceiptNo: d.registerReceiptNo ?? null, confirmOverpay: d.confirmOverpay === "on" });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${d.patientId}/verordnungen`);
  revalidatePath("/kasse");
  return { ok: `Zuzahlungsquittung ${res.number} erstellt.`, ...(res.warning ? { warning: res.warning } : {}) };
}

const refundSchema = z.object({
  invoiceId: z.string().uuid(),
  patientId: z.string().uuid(),
  method: z.string().max(20),
  registerReceiptNo: z.string().max(60).optional(),
  reason: z.string().max(300).optional(),
});

/** Zuzahlungsquittung stornieren und erstatten (negative Zahlung über die Kasse) */
export async function copaymentRefundAction(_: CopaymentPaidState, form: FormData): Promise<CopaymentPaidState> {
  const auth = await requireAuth("invoices.write");
  const parsed = refundSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Ungültige Anfrage – bitte Seite neu laden." };
  const d = parsed.data;
  const res = await refundCopaymentReceipt(auth, { invoiceId: d.invoiceId, patientId: d.patientId, method: d.method as CopaymentRefundInput["method"], registerReceiptNo: d.registerReceiptNo ?? null, reason: d.reason ?? "" });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${d.patientId}/verordnungen`);
  revalidatePath("/kasse");
  if (res.refundError) return { warning: `Storniert (${res.number}), die Erstattung konnte aber nicht gebucht werden: ${res.refundError} Bitte am Stornobeleg „Zahlung erfassen“.` };
  return { ok: `Storniert (${res.number}) – ${(res.refundedCents / 100).toFixed(2).replace(".", ",")} € erstattet.` };
}

export type SignatureState = { error?: string; ok?: string } | undefined;

/** Unterschrift (bzw. Papier-Vermerk) zu einer Behandlung nachtragen – Leistungsnachweis */
export async function addSignatureAction(_: SignatureState, form: FormData): Promise<SignatureState> {
  const auth = await requireAuth("medical.write");
  const ids = z.object({ recordId: z.string().uuid(), patientId: z.string().uuid(), prescriptionId: z.string().uuid() }).safeParse(Object.fromEntries(form));
  if (!ids.success) return { error: "Ungültige Anfrage – bitte Seite neu laden." };
  const fields = signatureFields.safeParse(Object.fromEntries([...form.entries()].filter(([k, v]) => v !== "" && ["signatureData", "signerName", "signerRole", "paperSigned"].includes(k))));
  if (!fields.success) return { error: fields.error.issues[0]?.message ?? "Unterschrift prüfen." };
  const res = await addSignature(auth, { recordId: ids.data.recordId, patientId: ids.data.patientId, ...fields.data });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${ids.data.patientId}/verordnungen/${ids.data.prescriptionId}/nachweis`);
  revalidatePath(`/kunden/${ids.data.patientId}/verordnungen`);
  return { ok: "Unterschrift gespeichert." };
}

export type OcrActionResult = { ok: true; suggestion: OcrSuggestion; mock: boolean; at: string } | { ok: false; error: string };

/** Foto der Verordnung auslesen (nur Vorschlag – gespeichert wird erst mit „Übernehmen“). */
export async function readPrescriptionPhotoAction(input: { patientId: string; mediaId: string }): Promise<OcrActionResult> {
  const auth = await requireAuth("medical.write");
  const ids = z.object({ patientId: z.string().uuid(), mediaId: z.string().uuid() }).safeParse(input);
  if (!ids.success) return { ok: false, error: "Ungültige Anfrage." };
  const res = await extractPrescriptionFromMedia(auth, ids.data);
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, suggestion: res.suggestion, mock: res.mock, at: new Date().toISOString() };
}

export async function addExemptionAction(_: PrescriptionFormState, form: FormData): Promise<PrescriptionFormState & { ok?: string }> {
  const auth = await requireAuth("medical.write");
  const parsed = exemptionInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await addCopaymentExemption(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
  return { ok: "Befreiung gespeichert." };
}

export async function removeExemptionAction(form: FormData) {
  const auth = await requireAuth("medical.write");
  // safeParse: manipulierte Formulare führen nicht zu einem Serverfehler (PR #111 A4/Nice)
  const parsed = z.object({ patientId: z.string().uuid(), id: z.string().uuid() }).safeParse({ patientId: form.get("patientId"), id: form.get("id") });
  if (!parsed.success) return;
  await removeCopaymentExemption(auth, parsed.data);
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
}

export type ReportState = { error?: string } | undefined;

/** Therapiebericht anlegen/ändern (Position 78530) */
export async function saveTherapyReportAction(_: ReportState, form: FormData): Promise<ReportState> {
  const auth = await requireAuth("medical.write");
  const parsed = therapyReportInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await saveTherapyReport(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${parsed.data.patientId}/verordnungen`);
  redirect(`/kunden/${parsed.data.patientId}/verordnungen/${parsed.data.prescriptionId}/therapiebericht?gespeichert=1`);
}

export type FollowUpActionState = { error?: string; ok?: string } | undefined;

/** Vermerk „Folgeverordnung angefordert am heute“ */
export async function followUpRequestedAction(_: FollowUpActionState, form: FormData): Promise<FollowUpActionState> {
  const auth = await requireAuth("medical.write");
  const res = await markFollowUpRequested(auth, { prescriptionId: String(form.get("prescriptionId") ?? ""), patientId: String(form.get("patientId") ?? ""), note: form.get("note") ? String(form.get("note")) : null });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${String(form.get("patientId"))}/verordnungen`);
  revalidatePath("/heute");
  return { ok: "Als angefordert vermerkt." };
}

/** Dauerpatient:in (Folgeverordnung erwarten) an/aus */
export async function followUpExpectedAction(form: FormData) {
  const auth = await requireAuth("medical.write");
  const patientId = String(form.get("patientId") ?? "");
  const res = await setFollowUpExpected(auth, { patientId, on: form.get("on") === "1" });
  if ("error" in res) return;
  revalidatePath(`/kunden/${patientId}/verordnungen`);
  revalidatePath("/heute");
}


/** Sammel-Vermerk „Unterschriften liegen auf der Papier-Verordnung vor“ bis Datum (Bestand, Review R2-13) */
export async function paperBulkAction(_: SignatureState, form: FormData): Promise<SignatureState> {
  const auth = await requireAuth("medical.write");
  const d = { prescriptionId: String(form.get("prescriptionId") ?? ""), patientId: String(form.get("patientId") ?? ""), until: String(form.get("until") ?? "") };
  if (form.get("confirm") !== "on") return { error: "Bitte bestätigen, dass die Unterschriften auf der Papier-Verordnung vorliegen." };
  const res = await markPaperSignatures(auth, d);
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${d.patientId}/verordnungen/${d.prescriptionId}/nachweis`);
  revalidatePath(`/kunden/${d.patientId}/verordnungen`);
  return { ok: res.count ? `${res.count} ${res.count === 1 ? "Behandlung" : "Behandlungen"} als „auf Papier unterschrieben“ vermerkt.` : "Keine offene Behandlung bis zu diesem Datum." };
}
