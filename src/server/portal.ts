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
import { cancelPortalAppointment, createPortalLink, portalFailLimiter, portalLimiter, resolvePortalLink } from "./portal-core";

export type PortalLinkState = { error?: string; url?: string; expires?: string } | undefined;
export type PortalCancelState = { error?: string; ok?: string; phone?: string | null } | undefined;

export async function createPortalLinkAction(_: PortalLinkState, form: FormData): Promise<PortalLinkState> {
  const auth = await requireAuth("patients.write");
  try {
    const r = await createPortalLink(auth, String(form.get("patientId") ?? ""));
    return { url: r.url, expires: dateDe(r.expiresAt) };
  } catch (e) {
    return { error: e instanceof Error && e.message === "Person nicht gefunden." ? e.message : "Link konnte nicht erzeugt werden." };
  }
}

export async function cancelPortalAppointmentAction(_: PortalCancelState, form: FormData): Promise<PortalCancelState> {
  const ip = (await requestMeta()).ip ?? "unbekannt";
  if (portalFailLimiter.exceeded(ip) || portalLimiter.limited(`cancel:${ip}`)) return { error: "Zu viele Anfragen. Bitte später erneut versuchen." };
  const link = await resolvePortalLink(String(form.get("token") ?? ""));
  if (!link) {
    portalFailLimiter.limited(ip);
    return { error: "Der Link ist abgelaufen oder ungültig. Bitte wenden Sie sich an die Praxis." };
  }
  const r = await cancelPortalAppointment(link, String(form.get("appointmentId") ?? ""));
  if (!r.ok) return { error: r.error, phone: r.phone };
  revalidatePath("/kalender");
  return { ok: r.message };
}
