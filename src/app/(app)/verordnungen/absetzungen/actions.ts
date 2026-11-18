"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { parseEuroInputCents } from "@/lib/euro-input";
import { deductionUpdateInput, updateDeduction } from "@/server/gkv-billing";

export type DeductionStatusState = { error?: string; ok?: string } | undefined;

/** Status/Notiz einer Absetzung ändern (Betrag nur, solange offen) – Rolle mit Abrechnungsrecht */
export async function deductionStatusAction(_: DeductionStatusState, form: FormData): Promise<DeductionStatusState> {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) return { error: "Keine Berechtigung." };
  const rawAmount = String(form.get("amount") ?? "").trim();
  const amount = rawAmount ? parseEuroInputCents(rawAmount) : null;
  if (amount !== null && typeof amount === "object") return { error: amount.error };
  const parsed = deductionUpdateInput.safeParse({ id: form.get("id"), status: form.get("status"), note: form.get("note") ?? undefined, amountCents: amount ?? undefined });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const res = await updateDeduction(auth, parsed.data);
  if ("error" in res) return { error: res.error };
  revalidatePath("/verordnungen/absetzungen");
  revalidatePath("/verordnungen/abrechnung");
  return { ok: "Gespeichert." };
}
