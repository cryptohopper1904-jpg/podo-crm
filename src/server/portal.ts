"use server";

/**
 * Server Actions für das Kundenportal.
 * - createPortalLinkAction: Praxis (patients.write) erzeugt einen 30-Tage-Link für eine Person.
 * - cancelPortalAppointmentAction: öffentlich (Token), Absage ≥ 24 h vorher.
 * Die Logik liegt in ./portal-core (server-only).
 */
import { revalidatePath } from "next/cache";
import { requestMeta, requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { clientKey } from "@/lib/rate-limit";
import { cancelPortalAppointment, createPortalLink, currentPortalLink, portalFailLimiter, portalLimiter } from "./portal-core";
import { assertEntitled, EntitlementError } from "@/lib/plans";

export type PortalLinkState = { error?: string; url?: string; expires?: string } | undefined;
export type PortalCancelState = { error?: string; ok?: string; phone?: string | null } | undefined;

export async function createPortalLinkAction(_: PortalLinkState, form: FormData): Promise<PortalLinkState> {
  const auth = await requireAuth("patients.write");
  try {
    assertEntitled(auth.billing, "portal");
  } catch (e) {
    if (e instanceof EntitlementError) return { error: e.message };
    throw e;
  }
  try {
    const r = await createPortalLink(auth, String(form.get("patientId") ?? ""));
    return { url: r.url, expires: dateDe(r.expiresAt) };
  } catch (e) {
    return { error: e instanceof Error && e.message === "Person nicht gefunden." ? e.message : "Link konnte nicht erzeugt werden." };
  }
}

export async function cancelPortalAppointmentAction(_: PortalCancelState, form: FormData): Promise<PortalCancelState> {
  const key = clientKey(await requestMeta());
  if (portalFailLimiter.exceeded(key) || portalLimiter.limited(`cancel:${key}`)) return { error: "Zu viele Anfragen. Bitte später erneut versuchen." };
  // Sitzung aus dem HttpOnly-Cookie (SameSite=Strict) – kein Token im Formular
  const link = await currentPortalLink();
  if (!link) return { error: "Ihre Sitzung ist abgelaufen. Bitte öffnen Sie den Link aus Ihrer Nachricht erneut." };
  const r = await cancelPortalAppointment(link, String(form.get("appointmentId") ?? ""));
  if (!r.ok) {
    portalFailLimiter.limited(key);
    return { error: r.error, phone: r.phone };
  }
  revalidatePath("/kalender");
  revalidatePath("/portal");
  return { ok: r.message };
}
