"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import { deleteFixedCost, fixedCostInput, saveFixedCost, setMaterialCost } from "@/server/finance";

export type FinanceFormState = { error?: string; success?: string } | undefined;

export async function saveFixedCostAction(_: FinanceFormState, form: FormData): Promise<FinanceFormState> {
  const auth = await requireAuth("settings.manage");
  const id = String(form.get("id") ?? "") || null;
  const parsed = fixedCostInput.safeParse({
    category: form.get("category"),
    amountCents: parseMoney(String(form.get("amount") ?? "")) ?? 0,
    interval: form.get("interval"),
    startDate: form.get("startDate"),
    note: form.get("note"),
    active: form.get("active") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  const saved = await saveFixedCost(auth, id, parsed.data);
  if (!saved) return { error: "Eintrag nicht gefunden." };
  revalidatePath("/auswertung");
  return { success: id ? "Fixkosten aktualisiert." : "Fixkosten angelegt." };
}

export async function deleteFixedCostAction(form: FormData) {
  const auth = await requireAuth("settings.manage");
  const id = String(form.get("id") ?? "");
  if (id) await deleteFixedCost(auth, id);
  revalidatePath("/auswertung");
}

export async function saveMaterialCostAction(_: FinanceFormState, form: FormData): Promise<FinanceFormState> {
  const auth = await requireAuth("settings.manage");
  const cents = parseMoney(String(form.get("materialCost") ?? ""));
  if (cents === null || cents < 0 || cents > 100_000) return { error: "Bitte einen Betrag zwischen 0 und 1.000 € angeben." };
  await setMaterialCost(auth, cents);
  revalidatePath("/auswertung");
  return { success: "Materialkosten gespeichert." };
}
