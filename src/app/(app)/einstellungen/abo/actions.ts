"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getBillingPort } from "@/integrations/stripe";
import { audit } from "@/lib/audit";
import { requireAuth, type AuthContext } from "@/lib/auth/session";
import { isPaidPlan, PLANS } from "@/lib/plans";
import { applyMockSubscription, loadOrgBilling, usedSeats } from "@/server/billing";

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
  if (org.stripeCustomerId && ["active", "past_due", "trialing"].includes(org.subscriptionStatus) && org.plan !== "trial") {
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
