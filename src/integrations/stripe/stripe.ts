/**
 * Echter Stripe-Adapter (REST, https://api.stripe.com/v1, form-encoded, Bearer STRIPE_SECRET_KEY).
 * Tarif-Preise als Price-IDs aus der Umgebung: STRIPE_PRICE_STARTER / _PRAXIS / _PLUS und STRIPE_PRICE_SEAT
 * (zusätzliche Plätze über die im Tarif enthaltenen hinaus, Menge = Anzahl Zusatzplätze).
 */
import { randomUUID } from "node:crypto";
import { PLANS } from "@/lib/plans";
import { parseVerifiedEvent } from "./signature";
import {
  BillingHttpError,
  BillingNotConfiguredError,
  CANCEL_REASON_METADATA_KEY,
  type BillingPort,
  type CheckoutInput,
  type FetchLike,
  type OpenBillingItems,
  type StripeEvent,
  type SubscriptionInfo,
} from "./types";

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

const unixDate = (v: unknown): Date | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : undefined);

/** Stripe-Abo-Objekt → SubscriptionInfo (Periodenfelder: ältere API am Abo, neuere je Position) */
export function subscriptionInfo(raw: Record<string, unknown>): SubscriptionInfo {
  const items = Array.isArray((raw.items as { data?: unknown } | undefined)?.data) ? ((raw.items as { data: Record<string, unknown>[] }).data) : [];
  const pick = (key: "current_period_start" | "current_period_end", agg: (a: number[]) => number) => {
    const top = unixDate(raw[key]);
    if (top) return top;
    const vals = items.map((i) => unixDate(i?.[key])).filter((d): d is Date => !!d).map((d) => d.getTime());
    return vals.length ? new Date(agg(vals)) : undefined;
  };
  const meta = raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : {};
  const reason = meta[CANCEL_REASON_METADATA_KEY];
  const customer = typeof raw.customer === "string" ? raw.customer : typeof (raw.customer as { id?: unknown } | null)?.id === "string" ? (raw.customer as { id: string }).id : null;
  // Intervall des Grundpreises (erste Position; ältere API zusätzlich raw.plan)
  const first = items[0] as { price?: { recurring?: { interval?: unknown; interval_count?: unknown } }; plan?: { interval?: unknown; interval_count?: unknown } } | undefined;
  const rec = first?.price?.recurring ?? first?.plan ?? (raw.plan as { interval?: unknown; interval_count?: unknown } | undefined);
  return {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    cancelAtPeriodEnd: raw.cancel_at_period_end === true || (typeof raw.cancel_at === "number" && raw.cancel_at > 0),
    cancelReason: typeof reason === "string" && reason ? reason : null,
    customerId: customer,
    currentPeriodStart: pick("current_period_start", (a) => Math.min(...a)),
    currentPeriodEnd: pick("current_period_end", (a) => Math.max(...a)),
    canceledAt: typeof raw.canceled_at === "number" && raw.canceled_at > 0 ? raw.canceled_at : null,
    interval: typeof rec?.interval === "string" ? rec.interval : null,
    intervalCount: typeof rec?.interval_count === "number" ? rec.interval_count : null,
  };
}

const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/** Stripe-IDs landen im URL-Pfad: nur das erwartete Format zulassen */
function stripeId(id: string, prefix: "sub_" | "cus_"): string {
  if (!new RegExp(`^${prefix}[A-Za-z0-9_]{1,250}$`).test(id)) throw new BillingHttpError(400, "Ungültige ID", prefix);
  return id;
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
    return this.request<T>("POST", path, params, idempotencyKey);
  }

  /** GET/DELETE: Parameter als Query-String (wie die offiziellen Stripe-Bibliotheken), POST: form-encoded Body */
  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const encoded = formEncode(params);
    const url = this.baseUrl + path + (method !== "POST" && encoded ? `?${encoded}` : "");
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.secretKey}`,
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(method === "POST" ? { body: encoded } : {}),
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

  async getSubscription(subscriptionId: string): Promise<SubscriptionInfo | null> {
    try {
      return subscriptionInfo(await this.request<Record<string, unknown>>("GET", `/subscriptions/${stripeId(subscriptionId, "sub_")}`));
    } catch (e) {
      if (e instanceof BillingHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, reason: string | null): Promise<SubscriptionInfo> {
    // Leerer Wert entfernt einen Metadaten-Schlüssel bei Stripe
    const params = { cancel_at_period_end: cancel ? "true" : "false", metadata: { [CANCEL_REASON_METADATA_KEY]: reason ?? "" } };
    return subscriptionInfo(await this.post<Record<string, unknown>>(`/subscriptions/${stripeId(subscriptionId, "sub_")}`, params));
  }

  async listSubscriptions(customerId: string): Promise<SubscriptionInfo[]> {
    const r = await this.request<{ data?: Record<string, unknown>[] }>("GET", "/subscriptions", { customer: stripeId(customerId, "cus_"), status: "all", limit: 100 });
    return (r.data ?? []).map(subscriptionInfo);
  }

  async openBillingItems(customerId: string): Promise<OpenBillingItems> {
    const customer = stripeId(customerId, "cus_");
    const inv = await this.request<{ data?: Record<string, unknown>[]; has_more?: boolean }>("GET", "/invoices", { customer, status: "open", limit: 100 });
    const items = await this.request<{ data?: Record<string, unknown>[]; has_more?: boolean }>("GET", "/invoiceitems", { customer, pending: "true", limit: 100 });
    // Kundensaldo (negativ = Guthaben); ein gelöschter Kunde liefert { deleted: true } ohne Saldo
    const cus = await this.request<{ balance?: unknown; deleted?: unknown }>("GET", `/customers/${customer}`);
    const invoices = inv.data ?? [];
    const pending = (items.data ?? []).map((i) => cents(i.amount));
    return {
      openInvoices: invoices.length,
      openInvoiceCents: invoices.reduce((s, i) => s + cents(i.amount_remaining), 0),
      pendingItems: pending.length,
      pendingItemCents: pending.reduce((s, a) => s + a, 0),
      pendingChargeCents: pending.filter((a) => a > 0).reduce((s, a) => s + a, 0),
      pendingCreditCents: pending.filter((a) => a < 0).reduce((s, a) => s + a, 0),
      customerBalanceCents: cus.deleted === true ? null : cents(cus.balance),
      truncated: inv.has_more === true || items.has_more === true,
    };
  }

  async cancelSubscriptionNow(subscriptionId: string): Promise<SubscriptionInfo | null> {
    try {
      return subscriptionInfo(
        await this.request<Record<string, unknown>>("DELETE", `/subscriptions/${stripeId(subscriptionId, "sub_")}`, { prorate: "false", invoice_now: "false" }),
      );
    } catch (e) {
      if (e instanceof BillingHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async deleteCustomer(customerId: string): Promise<void> {
    try {
      await this.request("DELETE", `/customers/${stripeId(customerId, "cus_")}`);
    } catch (e) {
      if (e instanceof BillingHttpError && e.status === 404) return;
      throw e;
    }
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null, now?: Date): StripeEvent {
    return parseVerifiedEvent(rawBody, signatureHeader, this.opts.webhookSecret, now);
  }
}
