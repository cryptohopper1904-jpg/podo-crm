/**
 * Mock-Abrechnung für Entwicklung/Demo: keine Aufrufe an Stripe. Der Checkout führt direkt zurück zur
 * Abo-Seite; die Server Action stellt den Tarif dann sofort um (nur außerhalb von Produktion).
 */
import { parseVerifiedEvent } from "./signature";
import type { BillingPort, CheckoutInput, StripeEvent } from "./types";

export const MOCK_WEBHOOK_SECRET = "whsec_mock_dev_only";

export class StripeMock implements BillingPort {
  readonly isMock = true;
  constructor(private readonly webhookSecret: string | null = MOCK_WEBHOOK_SECRET) {}

  async createCheckoutSession(input: CheckoutInput) {
    const id = `cs_mock_${input.organizationId.slice(0, 8)}_${Date.now()}`;
    const u = new URL(input.successUrl);
    u.searchParams.set("mock", "1");
    return { id, url: u.toString() };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    return { url: input.returnUrl };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null, now?: Date): StripeEvent {
    return parseVerifiedEvent(rawBody, signatureHeader, this.webhookSecret, now);
  }
}
