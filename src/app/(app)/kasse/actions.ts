"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import { DENOMINATIONS } from "@/lib/kasse/labels";
import { addCashMovement, closeDay, closingInput, KasseError, movementInput } from "@/server/kasse";

export type KasseState = { error?: string; ok?: string } | undefined;

function errorMessage(e: unknown): string {
  if (e instanceof KasseError) return e.message;
  console.error(e);
  return "Speichern fehlgeschlagen. Bitte erneut versuchen.";
}

export async function addMovementAction(_: KasseState, form: FormData): Promise<KasseState> {
  const auth = await requireAuth("invoices.write");
  const amount = parseMoney(String(form.get("amount") ?? ""));
  const parsed = movementInput.safeParse({ kind: form.get("kind"), amountCents: amount ?? 0, reason: form.get("reason") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  try {
    await addCashMovement(auth, parsed.data);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/kasse");
  return { ok: "Im Kassenbuch erfasst." };
}

export async function closeDayAction(_: KasseState, form: FormData): Promise<KasseState> {
  const auth = await requireAuth("invoices.write");
  if (form.get("confirm") !== "on") return { error: "Bitte bestätigen, dass der Bestand gezählt wurde und der Abschluss endgültig ist." };
  const denominations: Record<string, unknown> = {};
  for (const d of DENOMINATIONS) {
    const v = String(form.get(`d_${d}`) ?? "").trim();
    if (v) denominations[String(d)] = v;
  }
  const openingRaw = String(form.get("opening") ?? "").trim();
  const opening = openingRaw ? parseMoney(openingRaw) : undefined;
  if (opening === null) return { error: "Anfangsbestand ungültig." };
  const parsed = closingInput.safeParse({
    businessDate: form.get("businessDate"),
    denominations,
    openingCents: opening,
    differenceReason: form.get("differenceReason"),
    note: form.get("note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let id: string;
  try {
    id = (await closeDay(auth, parsed.data)).id;
  } catch (e) {
    return { error: errorMessage(e) };
  }
  revalidatePath("/kasse");
  redirect(`/kasse/abschluss/${id}`);
}
