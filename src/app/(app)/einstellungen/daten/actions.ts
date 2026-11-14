"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { confirmsPracticeName, isWithinGrace } from "@/lib/org-deletion";
import { accessMode } from "@/lib/plans";
import { isAutoDeletion } from "@/lib/readonly-expiry";
import { CANCEL_FAILED_MESSAGE } from "@/lib/subscription-cancel";
import { cancelSubscriptionAtPeriodEnd, resumeSubscription } from "@/server/subscription-cancel";

export type DataState = { error?: string; ok?: string; warning?: string } | undefined;

/** Auch im Nur-Lesen-Modus erlaubt: Löschantrag und Rücknahme sind Wege aus dem Nur-Lesen-Modus (AGB § 9 Nr. 2). */
async function requireOwner() {
  const auth = await requireAuth("settings.manage", { allowReadOnly: true });
  if (auth.role !== "owner" || auth.support) throw new Error("Nur Inhaber:innen können die Praxis kündigen.");
  return auth;
}

/** Schritt 2 der Kündigung: Praxisname eingetippt + Export-Hinweis bestätigt → Löschung beantragen. */
export async function requestDeletionAction(_: DataState, form: FormData): Promise<DataState> {
  let auth;
  try {
    auth = await requireOwner();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const name = String(form.get("confirmName") ?? "");
  if (form.get("acknowledge") !== "on") return { error: "Bitte bestätige, dass du einen Export gesichert hast und deine Aufbewahrungspflichten kennst." };
  if (!confirmsPracticeName(name, auth.organization.name)) return { error: "Der eingegebene Praxisname stimmt nicht überein." };
  // organizations hat keine RLS – Filter auf die eigene Praxis ist hier die Zugriffskontrolle
  const [row] = await db
    .update(organizations)
    .set({ deletionRequestedAt: new Date() })
    .where(and(eq(organizations.id, auth.organization.id), isNull(organizations.deletionRequestedAt)))
    .returning({ at: organizations.deletionRequestedAt });
  if (!row) return { error: "Die Löschung wurde bereits beantragt." };
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "org.deletion_requested", entity: "organization", entityId: auth.organization.id });
  // AGB § 8 Nr. 3: Der Löschantrag gilt als Kündigung → Stripe-Abo zum Periodenende kündigen. Ein Fehler verhindert den
  // (bereits gespeicherten) Antrag nicht, wird aber protokolliert, im Posteingang und beim Betreiber angezeigt.
  const c = await cancelSubscriptionAtPeriodEnd(auth.organization.id, auth.user.id, "deletion_request");
  revalidatePath("/einstellungen/daten");
  revalidatePath("/einstellungen/abo");
  if (c.status === "failed") return { ok: "Kündigung und Löschung beantragt.", warning: CANCEL_FAILED_MESSAGE };
  if (c.status === "canceled" || c.status === "already_canceled") {
    return { ok: `Kündigung und Löschung beantragt. Dein Abo endet zum ${c.periodEnd ? dateDe(c.periodEnd) : "Ende des Abrechnungszeitraums"}; danach wird nichts mehr abgebucht.` };
  }
  return { ok: "Kündigung und Löschung beantragt." };
}

/** Rücknahme innerhalb der Karenzzeit. */
export async function cancelDeletionAction(_: DataState, _form: FormData): Promise<DataState> {
  void _form;
  let auth;
  try {
    auth = await requireOwner();
  } catch (e) {
    return { error: (e as Error).message };
  }
  const [org] = await db
    .select({
      at: organizations.deletionRequestedAt,
      settings: organizations.settings,
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      trialEndsAt: organizations.trialEndsAt,
      currentPeriodEnd: organizations.currentPeriodEnd,
      seats: organizations.seats,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.id, auth.organization.id));
  if (!org?.at) return { ok: "Es ist keine Löschung beantragt." };
  // automatischer Antrag (Ende des Nur-Lesen-Modus, AGB § 9 Nr. 2): endet nur mit einem Tarif
  if (isAutoDeletion(org.settings)) {
    return { error: "Diese Löschung erfolgt automatisch, weil der Nur-Lesen-Modus nach 12 Monaten endet. Wähle unter Einstellungen → Abo einen Tarif (bis 20 Patient:innen auch kostenlos), dann entfällt sie." };
  }
  if (!isWithinGrace(org.at)) return { error: "Die Karenzzeit ist abgelaufen. Bitte wende dich an den Support." };
  await db.update(organizations).set({ deletionRequestedAt: null }).where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "org.deletion_cancelled", entity: "organization", entityId: auth.organization.id });
  // Rücknahme gilt auch für die Kündigung – aber nur, wenn sie durch den Löschantrag kam (eine separat, z. B. über das
  // Stripe-Kundenportal ausgesprochene Kündigung bleibt bestehen).
  const r = await resumeSubscription(auth.organization.id, auth.user.id, { onlyReason: "deletion_request" });
  revalidatePath("/einstellungen/daten");
  revalidatePath("/einstellungen/abo");
  const base = "Die Löschung wurde zurückgenommen. Deine Praxis bleibt bestehen.";
  if (r.status === "failed") {
    return { ok: base, warning: "Die Kündigung deines Abos konnte nicht automatisch zurückgenommen werden – bitte unter Einstellungen → Abo „Kündigung zurücknehmen“ wählen oder den Support kontaktieren." };
  }
  if (r.status === "resumed") return { ok: `${base} Auch die Kündigung ist zurückgenommen – dein Abo läuft weiter.` };
  if (r.status === "kept") {
    return { ok: base, warning: `Dein Abo bleibt gekündigt (zum ${r.periodEnd ? dateDe(r.periodEnd) : "Ende des Abrechnungszeitraums"}), weil die Kündigung separat ausgesprochen wurde. Du kannst sie unter Einstellungen → Abo zurücknehmen.` };
  }
  // Abo schon beendet (Rücknahme nach Ende des Abrechnungszeitraums): Kündigung lässt sich nicht mehr zurücknehmen
  if (r.status === "no_subscription" && org.plan !== "free" && org.plan !== "internal") {
    if (accessMode(org).mode === "readonly") {
      return { ok: base, warning: "Dein Abo ist bereits beendet. Die Praxis bleibt im Nur-Lesen-Modus, bis du wieder einen Tarif wählst (Einstellungen → Abo)." };
    }
    if (org.stripeSubscriptionId && ["canceled", "none"].includes(org.subscriptionStatus)) {
      return { ok: base, warning: "Dein Abo ist bereits beendet. Wähle unter Einstellungen → Abo einen Tarif, sonst wechselt die Praxis in den Nur-Lesen-Modus." };
    }
  }
  return { ok: base };
}
