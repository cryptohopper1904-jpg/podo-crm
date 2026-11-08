/**
 * Echter Stripe-Adapter (REST, https://api.stripe.com/v1, form-encoded, Bearer STRIPE_SECRET_KEY).
 * Tarif-Preise als Price-IDs aus der Umgebung: STRIPE_PRICE_STARTER / _PRAXIS / _PLUS und STRIPE_PRICE_SEAT
 * (zusätzliche Plätze über die im Tarif enthaltenen hinaus, Menge = Anzahl Zusatzplätze).
 */
import { randomUUID } from "node:crypto";
import { PLANS } from "@/lib/plans";
import { parseVerifiedEvent } from "./signature";
import { BillingHttpError, BillingNotConfiguredError, type BillingPort, type CheckoutInput, type FetchLike, type StripeEvent } from "./types";

export type PriceIds = { starter?: string; praxis?: string; plus?: string; seat?: string };

export function priceIdsFromEnv(env: Record<string, string | undefined> = process.env): PriceIds {
  return { starter: env.STRIPE_PRICE_STARTER, praxis: env.STRIPE_PRICE_PRAXIS, plus: env.STRIPE_PRICE_PLUS, seat: env.STRIPE_PRICE_SEAT };
}

/** Verschachtelte Parameter im Stripe-Format: a[b][0][c]=… */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.append(prefix, String(v));
  };
  walk("", params);
  return out.toString();
}

export function checkoutParams(input: CheckoutInput, prices: PriceIds): Record<string, unknown> {
  const base = prices[input.plan];
  if (!base) throw new BillingNotConfiguredError(`Price-ID für Tarif „${input.plan}“ fehlt (STRIPE_PRICE_${input.plan.toUpperCase()}).`);
  const extra = Math.max(0, input.seats - PLANS[input.plan].includedSeats);
  if (extra > 0 && !prices.seat) throw new BillingNotConfiguredError("Price-ID für Zusatzplätze fehlt (STRIPE_PRICE_SEAT).");
  const metadata = { organizationId: input.organizationId, plan: input.plan, seats: String(input.seats) };
  return {
    mode: "subscription",
    client_reference_id: input.organizationId,
    ...(input.customerId ? { customer: input.customerId } : input.email ? { customer_email: input.email } : {}),
    line_items: [{ price: base, quantity: 1 }, ...(extra > 0 ? [{ price: prices.seat, quantity: extra }] : [])],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    locale: "de",
    billing_address_collection: "required",
    tax_id_collection: { enabled: true },
    allow_promotion_codes: true,
    metadata,
    subscription_data: { metadata },
  };
}

export class StripeAdapter implements BillingPort {
  readonly isMock = false;
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly opts: { secretKey?: string; webhookSecret?: string; prices?: PriceIds; fetch?: FetchLike; baseUrl?: string },
  ) {
    if (!opts.secretKey) throw new BillingNotConfiguredError("STRIPE_SECRET_KEY fehlt.");
    this.fetch = opts.fetch ?? ((u, i) => fetch(u, i));
    this.baseUrl = (opts.baseUrl ?? "https://api.stripe.com/v1").replace(/\/$/, "");
  }

  private async post<T>(path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const res = await this.fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: formEncode(params),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new BillingHttpError(res.status, text, path);
    return JSON.parse(text) as T;
  }

  async createCheckoutSession(input: CheckoutInput) {
    const s = await this.post<{ id: string; url: string }>("/checkout/sessions", checkoutParams(input, this.opts.prices ?? priceIdsFromEnv()), randomUUID());
    if (!s.url) throw new BillingHttpError(500, "Keine Checkout-URL erhalten", "/checkout/sessions");
    return { id: s.id, url: s.url };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    const s = await this.post<{ url: string }>("/billing_portal/sessions", { customer: input.customerId, return_url: input.returnUrl });
    return { url: s.url };
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null, now?: Date): StripeEvent {
    return parseVerifiedEvent(rawBody, signatureHeader, this.opts.webhookSecret, now);
  }
}
