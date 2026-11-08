"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/session";
import { parseMoney } from "@/lib/format";
import { createVoucher, voucherInput } from "@/server/vouchers";

export type VoucherFormState = { error?: string } | undefined;

export async function createVoucherAction(_: VoucherFormState, form: FormData): Promise<VoucherFormState> {
  const auth = await requireAuth("invoices.write");
  const parsed = voucherInput.safeParse({
    amountCents: parseMoney(String(form.get("amount") ?? "")) ?? 0,
    issuedAt: form.get("issuedAt"),
    validUntil: form.get("validUntil"),
    purpose: form.get("purpose"),
    note: form.get("note"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Eingaben prüfen." };
  let id: string;
  try {
    id = (await createVoucher(auth, parsed.data)).id;
  } catch (e) {
    console.error(e);
    return { error: "Gutschein konnte nicht angelegt werden." };
  }
  revalidatePath("/gutscheine");
  redirect(`/gutscheine/${id}`);
}
