/**
 * Kündigung des Stripe-Abos zum Ende des Abrechnungszeitraums (AGB § 8 Nr. 3) – Zustand in organizations.settings:
 *  - billingCancelAtPeriodEnd: Stripe meldet cancel_at_period_end (Webhook bzw. direkt nach unserem API-Aufruf)
 *  - billingCancelReason: Herkunft, NUR von PodoHero gesetzt: „deletion_request“ (Löschantrag unter Daten & Kündigung)
 *    oder „owner“ (Abo kündigen unter Einstellungen → Abo). Eine Kündigung über das Stripe-Kundenportal hat keine
 *    Herkunft – sie wird bei der Rücknahme des Löschantrags nie überschrieben.
 *  - billingCancelError: letzter fehlgeschlagener automatischer Kündigungsversuch (sichtbar für Praxis und Betreiber)
 * Rein (ohne DB) – testbar.
 */
export const CANCEL_REASONS = ["deletion_request", "owner"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type SubscriptionCancelState = {
  cancelAtPeriodEnd: boolean;
  reason: CancelReason | null;
  error: { at: string; trigger: CancelReason | "resume" } | null;
};

const isReason = (v: unknown): v is CancelReason => typeof v === "string" && (CANCEL_REASONS as readonly string[]).includes(v);

export function cancelStateFromSettings(settings: Record<string, unknown> | null | undefined): SubscriptionCancelState {
  const s = settings ?? {};
  const err = s.billingCancelError as { at?: unknown; trigger?: unknown } | undefined;
  return {
    cancelAtPeriodEnd: s.billingCancelAtPeriodEnd === true,
    reason: isReason(s.billingCancelReason) ? s.billingCancelReason : null,
    error:
      err && typeof err.at === "string" && (isReason(err.trigger) || err.trigger === "resume")
        ? { at: err.at, trigger: err.trigger as CancelReason | "resume" }
        : null,
  };
}

/** Status, in denen ein Stripe-Abo noch Zahlungen auslösen kann */
export const RUNNING_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "paused"] as const;
/** Stripe-Rohstatus, in denen das Abo noch nicht beendet ist (für den Löschlauf) */
export const STRIPE_LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] as const;

export type OrgSubscriptionFields = {
  plan: string;
  subscriptionStatus: string;
  stripeSubscriptionId: string | null;
};

/** Läuft ein Stripe-Abo, das gekündigt werden kann? (Testphase per Aktionscode, Kostenlos, Intern: nein) */
export function hasRunningSubscription(org: OrgSubscriptionFields): boolean {
  return !!org.stripeSubscriptionId && (RUNNING_SUBSCRIPTION_STATUSES as readonly string[]).includes(org.subscriptionStatus);
}

/**
 * Hinweis für den Betreiber: Löschantrag gestellt, aber ein Stripe-Abo läuft ungekündigt weiter (automatische
 * Kündigung fehlgeschlagen oder noch nicht bestätigt). null = alles in Ordnung.
 */
export function deletionBillingProblem(
  org: OrgSubscriptionFields & { deletionRequestedAt: Date | null; settings: Record<string, unknown> | null | undefined },
): string | null {
  if (!org.deletionRequestedAt || !hasRunningSubscription(org)) return null;
  const st = cancelStateFromSettings(org.settings);
  if (st.cancelAtPeriodEnd) return null;
  return st.error ? "Löschantrag gestellt, automatische Abo-Kündigung fehlgeschlagen – Abo läuft weiter" : "Löschantrag gestellt, Abo laut Stripe nicht gekündigt";
}

export const CANCEL_FAILED_MESSAGE = "Abo konnte nicht automatisch gekündigt werden – bitte unter Abo kündigen oder Support kontaktieren.";
