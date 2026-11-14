/**
 * Abo-Abrechnung der SaaS (Stripe Billing) – plattformweit, NICHT pro Praxis konfiguriert.
 * Enthält keine Gesundheitsdaten: an Stripe gehen nur Praxis-ID, E-Mail der Inhaber:in, Tarif und Plätze.
 */
import type { PaidPlan } from "@/lib/plans";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckoutInput {
  organizationId: string;
  plan: PaidPlan;
  /** gewünschte Gesamtzahl Plätze (inkl. der im Tarif enthaltenen) */
  seats: number;
  customerId?: string | null;
  email?: string | null;
  successUrl: string;
  cancelUrl: string;
}

/** Metadaten-Schlüssel am Stripe-Abo: Herkunft einer Kündigung zum Periodenende (z. B. „deletion_request“) */
export const CANCEL_REASON_METADATA_KEY = "cancel_reason";

/** Für Kündigung/Rücknahme benötigte Teile eines Stripe-Abos (https://docs.stripe.com/api/subscriptions/object) */
export interface SubscriptionInfo {
  id: string;
  /** Roh-Status von Stripe: active, trialing, past_due, unpaid, incomplete, incomplete_expired, paused, canceled */
  status: string;
  /** zum Periodenende gekündigt (cancel_at_period_end oder ein gesetztes cancel_at) */
  cancelAtPeriodEnd: boolean;
  /** metadata.cancel_reason – nur von PodoHero gesetzt */
  cancelReason: string | null;
  customerId: string | null;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
}

/** Minimal benötigte Teile eines Stripe-Events (https://docs.stripe.com/api/events/object) */
export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export interface BillingPort {
  readonly isMock: boolean;
  createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Abo lesen; null, wenn es bei Stripe nicht (mehr) existiert. */
  getSubscription(subscriptionId: string): Promise<SubscriptionInfo | null>;
  /**
   * Kündigung zum Periodenende setzen (true) oder zurücknehmen (false). `reason` wird als metadata.cancel_reason
   * gespeichert; null entfernt den Schlüssel.
   */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, reason: string | null): Promise<SubscriptionInfo>;
  /** Abo sofort beenden – ohne anteilige Gutschrift und ohne Abschlussrechnung (prorate=false, invoice_now=false). */
  cancelSubscriptionNow(subscriptionId: string): Promise<SubscriptionInfo | null>;
  /** Stripe-Kunden löschen (Zahlungsmittel, Adresse; ausgestellte Rechnungen bleiben bei Stripe erhalten). 404 = schon gelöscht. */
  deleteCustomer(customerId: string): Promise<void>;
  /** Prüft die Signatur (Header `Stripe-Signature`) und liefert das Event – wirft WebhookSignatureError. */
  verifyWebhook(rawBody: string, signatureHeader: string | null, now?: Date): StripeEvent;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class BillingNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`Abo-Abrechnung (Stripe) ist nicht konfiguriert: ${detail}`);
    this.name = "BillingNotConfiguredError";
  }
}

export class BillingHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string,
    path: string,
  ) {
    super(`Stripe: ${path} fehlgeschlagen (HTTP ${status}): ${body.slice(0, 300)}`);
    this.name = "BillingHttpError";
  }
}
