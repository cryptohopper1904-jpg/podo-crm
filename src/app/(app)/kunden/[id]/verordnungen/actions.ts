"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { PRESCRIPTION_STATUSES } from "@/lib/rules/prescription";
import type { OcrSuggestion } from "@/integrations/ocr/schema";
import { extractPrescriptionFromMedia } from "@/server/ocr";
import { changePrescriptionStatus, prescriptionInput, savePrescription, setCopaymentPaid } from "@/server/prescriptions";

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

export async function copaymentPaidAction(form: FormData) {
  const auth = await requireAuth("medical.write");
  const id = z.string().uuid().parse(form.get("id"));
  const patientId = z.string().uuid().parse(form.get("patientId"));
  await setCopaymentPaid(auth, { id, patientId, paid: form.get("paid") === "1" });
  revalidatePath(`/kunden/${patientId}/verordnungen`);
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
