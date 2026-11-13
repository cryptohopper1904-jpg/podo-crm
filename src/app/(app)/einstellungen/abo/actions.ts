"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getBillingPort } from "@/integrations/stripe";
import { audit } from "@/lib/audit";
import { requestMeta, requireAuth, revokeUserSessions, type AuthContext } from "@/lib/auth/session";
import { isPaidPlan, PLANS } from "@/lib/plans";
import { applyMockSubscription, loadOrgBilling, switchToFreePlan, usedSeats } from "@/server/billing";
import { dateDe } from "@/lib/format";
import { PROMO_INVALID, trialDaysLabel } from "@/lib/promo-codes";
import { clientKey } from "@/lib/rate-limit";
import { PromoCodeError, promoFailLimiter, redeemPromoCodeForOrganization } from "@/server/promo-codes";

export type AboState = { error?: string; ok?: string } | undefined;

/** Abo-Aktionen bleiben im Nur-Lesen-Modus erlaubt – sie sind der Weg hinaus. Nur Inhaber:in, nie im Support-Modus. */
async function ownerAuth(): Promise<AuthContext | null> {
  const auth = await requireAuth("settings.manage", { allowReadOnly: true });
  return auth.role === "owner" && !auth.support ? auth : null;
}

const publicBase = () => (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

export async function startCheckoutAction(_: AboState, form: FormData): Promise<AboState> {
  const auth = await ownerAuth();
  if (!auth) return { error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann das Abo verwalten." };
  const d = z.object({ plan: z.string(), seats: z.coerce.number().int().min(1).max(999) }).safeParse(Object.fromEntries(form));
  if (!d.success || !isPaidPlan(d.data.plan)) return { error: "Bitte Tarif und Anzahl Plätze wählen." };
  const plan = d.data.plan;
  const info = PLANS[plan];
  const seats = Math.max(d.data.seats, info.includedSeats);
  if (info.maxSeats !== null && seats > info.maxSeats) return { error: `Im Tarif „${info.label}“ sind höchstens ${info.maxSeats} Plätze möglich.` };
  const used = await usedSeats(auth.organization.id);
  if (seats < used) {
    return { error: `Aktuell sind ${used} Plätze belegt. Bitte mindestens ${used} Plätze wählen oder vorher Personen im Team sperren.` };
  }
  const org = await loadOrgBilling(auth.organization.id);
  if (!org) return { error: "Praxis nicht gefunden." };

  const port = getBillingPort();
  if (port.isMock) {
    if (process.env.NODE_ENV === "production") return { error: "Die Zahlungsabwicklung ist auf diesem Server noch nicht eingerichtet." };
    await applyMockSubscription(auth.organization.id, auth.user.id, plan, seats);
    revalidatePath("/", "layout");
    return { ok: `Testmodus: Tarif „${info.label}“ mit ${seats} Plätzen ist sofort aktiv (keine echte Zahlung).` };
  }
  if (org.stripeCustomerId && ["active", "past_due", "trialing"].includes(org.subscriptionStatus) && org.plan !== "trial" && org.plan !== "free") {
    return { error: "Es besteht bereits ein Abo. Tarif und Plätze änderst du über „Rechnungen & Zahlungsart“." };
  }
  const base = publicBase();
  if (!base) return { error: "PUBLIC_URL ist nicht konfiguriert." };
  let url: string;
  try {
    ({ url } = await port.createCheckoutSession({
      organizationId: auth.organization.id,
      plan,
      seats,
      customerId: org.stripeCustomerId,
      email: auth.user.email,
      successUrl: `${base}/einstellungen/abo?checkout=ok`,
      cancelUrl: `${base}/einstellungen/abo?checkout=abgebrochen`,
    }));
  } catch (e) {
    console.error("[billing] Checkout fehlgeschlagen", e instanceof Error ? e.message : e);
    return { error: "Der Bezahlvorgang konnte nicht gestartet werden. Bitte später erneut versuchen." };
  }
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "billing.checkout_started", meta: { plan, seats } });
  redirect(url);
}

export async function openPortalAction(): Promise<void> {
  const auth = await ownerAuth();
  if (!auth) redirect("/kein-zugriff");
  const org = await loadOrgBilling(auth.organization.id);
  const port = getBillingPort();
  if (!org?.stripeCustomerId || port.isMock) redirect("/einstellungen/abo?portal=nicht-verfuegbar");
  const base = publicBase();
  const { url } = await port.createPortalSession({ customerId: org.stripeCustomerId, returnUrl: `${base}/einstellungen/abo` });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "billing.portal_opened" });
  redirect(url);
}

/** Kostenlos weiterführen (bis 20 Patient:innen) – auch aus dem Nur-Lesen-Modus heraus. */
export async function switchToFreeAction(): Promise<AboState> {
  const auth = await ownerAuth();
  if (!auth) return { error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann den Tarif wechseln." };
  const r = await switchToFreePlan(auth.organization.id, auth.user.id);
  if ("error" in r) return { error: r.error };
  // deaktivierte Teammitglieder: laufende Sitzungen in dieser Praxis sofort beenden
  for (const u of r.deactivated) await revokeUserSessions(u, { organizationId: auth.organization.id });
  revalidatePath("/", "layout");
  return {
    ok: `Die Praxis nutzt jetzt den kostenlosen Tarif (bis 20 Patient:innen).${r.deactivated.length ? ` ${r.deactivated.length} weitere Teammitglied(er) wurden deaktiviert.` : ""}`,
  };
}

/**
 * Aktionscode einlösen (Inhaber:in): in der Testphase, nach deren Ablauf (Nur-Lesen), im Kostenlos-Tarif oder nach
 * beendetem Abo – nicht bei laufendem bezahlten Abo, je Praxis nur einmal. Fehlversuche je Anschluss UND je Praxis gedrosselt.
 */
export async function redeemPromoAction(_: AboState, form: FormData): Promise<AboState> {
  const auth = await ownerAuth();
  if (!auth) return { error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann einen Aktionscode einlösen." };
  const keys = [`abo:${clientKey(await requestMeta())}`, `abo-org:${auth.organization.id}`];
  if (keys.some((k) => promoFailLimiter.exceeded(k))) return { error: `${PROMO_INVALID} Zu viele Versuche – bitte später erneut versuchen.` };
  const code = String(form.get("code") ?? "").slice(0, 64);
  try {
    const r = await redeemPromoCodeForOrganization(auth.organization.id, auth.user.id, code);
    revalidatePath("/", "layout");
    return { ok: `Aktionscode ${r.code} eingelöst: Die Testphase läuft jetzt bis ${dateDe(r.trialEndsAt)} (${trialDaysLabel(r.trialDays)}).` };
  } catch (e) {
    if (!(e instanceof PromoCodeError)) throw e;
    for (const k of keys) promoFailLimiter.limited(k);
    return { error: e.message };
  }
}
