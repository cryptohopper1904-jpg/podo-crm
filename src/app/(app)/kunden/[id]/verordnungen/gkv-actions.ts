"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { parseEuroInputCents } from "@/lib/euro-input";
import {
  billingDetailsInput,
  correctionInput,
  createDeduction,
  deductionInput,
  markCorrectionNeeded,
  resolveCorrectionInput,
  resolveCorrectionWithoutRebill,
  saveBillingDetails,
} from "@/server/gkv-billing";

/** GKV Paket C: Abrechnungsangaben, Absetzungen und Korrektur an der Verordnung (Akte) */
export type GkvActionState = { error?: string; ok?: string } | undefined;

const revalidate = (patientId: string) => {
  revalidatePath(`/kunden/${patientId}/verordnungen`);
  revalidatePath("/verordnungen");
  revalidatePath("/verordnungen/abrechnung");
  revalidatePath("/verordnungen/absetzungen");
};

/** Kennzeichen Verordnungsart bestätigen, Verordnungsbesonderheit und Genehmigung (SKZ B2) erfassen */
export async function billingDetailsAction(_: GkvActionState, form: FormData): Promise<GkvActionState> {
  const auth = await requireAuth("medical.write");
  const parsed = billingDetailsInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await saveBillingDetails(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidate(parsed.data.patientId);
  return { ok: "Abrechnungsangaben gespeichert (Kennzeichen Verordnungsart bestätigt)." };
}

/** Absetzung/Retaxe zu einer abgerechneten Verordnung erfassen */
export async function deductionAction(_: GkvActionState, form: FormData): Promise<GkvActionState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const amount = parseEuroInputCents(String(form.get("amount") ?? ""));
  if (amount === null) return { error: "Bitte den abgesetzten Betrag angeben." };
  if (typeof amount === "object") return { error: amount.error };
  const parsed = deductionInput.safeParse({ ...Object.fromEntries(form), amountCents: amount });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await createDeduction(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidate(parsed.data.patientId);
  return { ok: "Absetzung erfasst." };
}

/** „Korrektur nötig“: abgerechnete Verordnung mit Begründung zur Korrektur öffnen */
export async function correctionAction(_: GkvActionState, form: FormData): Promise<GkvActionState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const parsed = correctionInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await markCorrectionNeeded(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidate(parsed.data.patientId);
  return { ok: "Status „Korrektur nötig“ gesetzt – Verordnung korrigieren und erneut „abrechnungsreif“ setzen." };
}

/** Korrektur ohne Neuabrechnung abschließen */
export async function resolveCorrectionAction(_: GkvActionState, form: FormData): Promise<GkvActionState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const parsed = resolveCorrectionInput.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await resolveCorrectionWithoutRebill(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidate(parsed.data.patientId);
  return { ok: "Korrektur ohne Neuabrechnung abgeschlossen." };
}
