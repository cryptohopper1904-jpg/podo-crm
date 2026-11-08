"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { createSupportGrant, revokeSupportGrant, validateGrantInput } from "@/server/support";

export type SupportState = { error?: string; ok?: string } | undefined;

/** Support-Freigaben: nur Inhaber:in; auch im Nur-Lesen-Modus (Abo) erlaubt, nie im Support-Modus selbst. */
async function ownerAuth() {
  const auth = await requireAuth("users.manage", { allowReadOnly: true });
  return auth.role === "owner" && !auth.support ? auth : null;
}

export async function grantSupportAction(_: SupportState, form: FormData): Promise<SupportState> {
  const auth = await ownerAuth();
  if (!auth) return { error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann Support-Zugriff freigeben." };
  const d = z
    .object({ reason: z.string().trim(), hours: z.coerce.number().int(), scope: z.enum(["read", "write"]).default("read"), confirm: z.literal("on", { message: "Bitte die Freigabe bestätigen." }) })
    .safeParse(Object.fromEntries(form));
  if (!d.success) return { error: d.error.issues[0]?.message ?? "Eingaben prüfen." };
  const problem = validateGrantInput(d.data);
  if (problem) return { error: problem };
  await createSupportGrant(auth, d.data);
  revalidatePath("/einstellungen/support");
  return { ok: `Support-Zugriff für ${d.data.hours} Stunden freigegeben. Du kannst ihn jederzeit widerrufen.` };
}

export async function revokeSupportAction(form: FormData) {
  const auth = await ownerAuth();
  if (!auth) return;
  const id = z.string().uuid().safeParse(form.get("id"));
  if (!id.success) return;
  await revokeSupportGrant(auth, id.data);
  revalidatePath("/einstellungen/support");
}
