"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { EURO_INPUT_MAX_LENGTH, parseEuroInputCents } from "@/lib/euro-input";
import { PRESCRIPTION_STATUSES } from "@/lib/rules/prescription";
import type { OcrSuggestion } from "@/integrations/ocr/schema";
import { extractPrescriptionFromMedia } from "@/server/ocr";
import { COPAYMENT_METHODS, changePrescriptionStatus, prescriptionInput, savePrescription, setCopaymentPaid, type CopaymentMethod } from "@/server/prescriptions";
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

const copaymentPaidSchema = z.object({
  id: z.string().uuid(),
  patientId: z.string().uuid(),
  paid: z.enum(["0", "1"]),
  /** Betrag in Euro („12,50“, „12.5“, „1.234,56“); leer = berechnete Zuzahlung – Parser: src/lib/euro-input.ts */
  amount: z.string().max(EURO_INPUT_MAX_LENGTH, "Betrag ungültig – bitte z. B. 12,50 eingeben.").optional(),
  method: z.preprocess((v) => (v === "" ? undefined : v), z.enum(Object.keys(COPAYMENT_METHODS) as [CopaymentMethod, ...CopaymentMethod[]]).optional()),
});

export type CopaymentPaidState = { error?: string; warning?: string } | undefined;

export async function copaymentPaidAction(_: CopaymentPaidState, form: FormData): Promise<CopaymentPaidState> {
  const auth = await requireAuth("medical.write");
  const parsed = copaymentPaidSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues.find((i) => i.path[0] === "amount")?.message ?? "Ungültige Anfrage – bitte Seite neu laden." };
  const d = parsed.data;
  const amount = d.paid === "1" ? parseEuroInputCents(d.amount) : null;
  if (amount !== null && typeof amount === "object") return { error: amount.error };
  const res = await setCopaymentPaid(auth, { id: d.id, patientId: d.patientId, paid: d.paid === "1", amountCents: amount, method: d.method ?? null });
  if ("error" in res) return { error: res.error };
  revalidatePath(`/kunden/${d.patientId}/verordnungen`);
  return res.warning ? { warning: res.warning } : undefined;
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
