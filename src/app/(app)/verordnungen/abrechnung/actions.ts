"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { createBillingBatch } from "@/server/prescriptions";

export type BatchState = { error?: string; ok?: string; batchId?: string } | undefined;

const PARTNERS = ["manual", "opta-data", "optica", "azh", "rzh", "other"] as const;

export async function createBatchAction(_: BatchState, form: FormData): Promise<BatchState> {
  const auth = await requireAuth("invoices.write");
  const ids = z.array(z.string().uuid()).safeParse(form.getAll("prescriptionId"));
  if (!ids.success || ids.data.length === 0) return { error: "Bitte mindestens eine Verordnung auswählen." };
  const partner = z.enum(PARTNERS).catch("manual").parse(form.get("partner"));
  const note = z.string().trim().max(500).optional().parse(form.get("note") || undefined);
  const res = await createBillingBatch(auth, ids.data, { partner, note });
  if ("error" in res) return { error: res.error };
  revalidatePath("/verordnungen");
  revalidatePath("/verordnungen/abrechnung");
  return { ok: `Abrechnungslauf mit ${res.count} Verordnung(en) erstellt.`, batchId: res.id };
}
