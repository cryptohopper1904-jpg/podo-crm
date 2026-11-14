/**
 * Mock-Abrechnung für Entwicklung/Demo: keine Aufrufe an Stripe. Der Checkout führt direkt zurück zur
 * Abo-Seite; die Server Action stellt den Tarif dann sofort um (nur außerhalb von Produktion).
 */
import { parseVerifiedEvent } from "./signature";
import type { BillingPort, CheckoutInput, OpenBillingItems, StripeEvent, SubscriptionInfo } from "./types";

export const MOCK_WEBHOOK_SECRET = "whsec_mock_dev_only";

/** Abos im Testmodus (je Prozess, nur Entwicklung): unbekannte Abo-IDs gelten als laufendes Monatsabo. */
const mockSubscriptions = new Map<string, SubscriptionInfo>();

export class StripeMock implements BillingPort {
  readonly isMock = true;
  constructor(private readonly webhookSecret: string | null = MOCK_WEBHOOK_SECRET) {}

  private sub(id: string): SubscriptionInfo {
    let s = mockSubscriptions.get(id);
    if (!s) {
      const now = Date.now();
      s = {
        id,
        status: "active",
        cancelAtPeriodEnd: false,
        cancelReason: null,
        customerId: null,
        currentPeriodStart: new Date(now),
        currentPeriodEnd: new Date(now + 30 * 86_400_000),
        canceledAt: null,
        interval: "month",
        intervalCount: 1,
      };
      mockSubscriptions.set(id, s);
    }
    return s;
  }

  async getSubscription(subscriptionId: string) {
    return { ...this.sub(subscriptionId) };
  }

  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, reason: string | null) {
    const s = this.sub(subscriptionId);
    Object.assign(s, { cancelAtPeriodEnd: cancel, cancelReason: reason, canceledAt: cancel ? Math.floor(Date.now() / 1000) : null });
    return { ...s };
  }

  /** Testmodus: Pseudo-Abos haben keinen Kunden – die Praxis-Abo-ID genügt */
  async listSubscriptions(_customerId: string): Promise<SubscriptionInfo[]> {
    void _customerId;
    return [];
  }

  async openBillingItems(_customerId: string): Promise<OpenBillingItems> {
    void _customerId;
    return { openInvoices: 0, openInvoiceCents: 0, pendingItems: 0, pendingItemCents: 0, truncated: false };
  }

  async cancelSubscriptionNow(subscriptionId: string) {
    const s = this.sub(subscriptionId);
    Object.assign(s, { status: "canceled", cancelAtPeriodEnd: false });
    return { ...s };
  }

  async deleteCustomer(_customerId: string) {
    void _customerId;
  }

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
