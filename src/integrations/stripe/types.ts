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
