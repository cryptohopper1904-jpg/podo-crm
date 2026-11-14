import { describe, expect, it } from "vitest";
import { cancelStateFromSettings, deletionBillingProblem, hasRunningSubscription } from "./subscription-cancel";

const sub = { plan: "praxis", subscriptionStatus: "active", stripeSubscriptionId: "sub_1" };

describe("Kündigungszustand des Abos", () => {
  it("liest nur gültige Werte aus den Einstellungen", () => {
    expect(cancelStateFromSettings(undefined)).toEqual({ cancelAtPeriodEnd: false, reason: null, error: null });
    expect(cancelStateFromSettings({ billingCancelAtPeriodEnd: true, billingCancelReason: "deletion_request" })).toMatchObject({ cancelAtPeriodEnd: true, reason: "deletion_request" });
    expect(cancelStateFromSettings({ billingCancelAtPeriodEnd: "true", billingCancelReason: "portal" })).toMatchObject({ cancelAtPeriodEnd: false, reason: null });
    expect(cancelStateFromSettings({ billingCancelError: { at: "2026-11-14T10:00:00Z", trigger: "deletion_request" } }).error).toEqual({ at: "2026-11-14T10:00:00Z", trigger: "deletion_request" });
    expect(cancelStateFromSettings({ billingCancelError: { at: 1, trigger: "x" } }).error).toBeNull();
  });

  it("laufendes Abo: nur mit Stripe-Abo-ID und nicht beendet", () => {
    expect(hasRunningSubscription(sub)).toBe(true);
    expect(hasRunningSubscription({ ...sub, subscriptionStatus: "past_due" })).toBe(true);
    expect(hasRunningSubscription({ ...sub, subscriptionStatus: "canceled" })).toBe(false);
    expect(hasRunningSubscription({ ...sub, stripeSubscriptionId: null, subscriptionStatus: "trialing" })).toBe(false);
  });

  it("Betreiber-Hinweis nur bei Löschantrag mit ungekündigtem laufendem Abo", () => {
    const at = new Date();
    expect(deletionBillingProblem({ ...sub, deletionRequestedAt: null, settings: {} })).toBeNull();
    expect(deletionBillingProblem({ ...sub, deletionRequestedAt: at, settings: { billingCancelAtPeriodEnd: true } })).toBeNull();
    expect(deletionBillingProblem({ ...sub, subscriptionStatus: "canceled", deletionRequestedAt: at, settings: {} })).toBeNull();
    expect(deletionBillingProblem({ ...sub, deletionRequestedAt: at, settings: {} })).toMatch(/nicht gekündigt/);
    expect(deletionBillingProblem({ ...sub, deletionRequestedAt: at, settings: { billingCancelError: { at: at.toISOString(), trigger: "deletion_request" } } })).toMatch(/fehlgeschlagen/);
  });
});
