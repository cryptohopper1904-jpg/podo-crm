"use server";

import { revalidatePath } from "next/cache";
import { requestMeta } from "@/lib/auth/session";
import { clientKey } from "@/lib/rate-limit";
import { portalFailLimiter, portalLimiter } from "@/server/portal-core";
import { acceptOffer } from "@/server/waitlist";

export type OfferAcceptState = { error?: string; ok?: string; taken?: boolean } | undefined;

/** Wartelisten-Angebot annehmen (öffentlich, Einmal-Token aus dem persönlichen Link; wer zuerst kommt). */
export async function acceptOfferAction(_: OfferAcceptState, form: FormData): Promise<OfferAcceptState> {
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`offer:${key}`)) return { error: "Zu viele Anfragen. Bitte später erneut versuchen." };
  const r = await acceptOffer(String(form.get("token") ?? ""));
  if (!r.ok) {
    if (r.state === "invalid") portalFailLimiter.limited(key);
    return { error: r.error, taken: r.state === "taken" };
  }
  revalidatePath("/kalender");
  return { ok: r.message };
}
