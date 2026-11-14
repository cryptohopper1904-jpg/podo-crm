import { describe, expect, it } from "vitest";
import { billingUpdateFromEvent, planFromItems } from "./events";
import { getBillingPort } from "./index";
import { StripeMock } from "./mock";
import { parseVerifiedEvent, signStripePayload, verifyStripeSignature } from "./signature";
import { checkoutParams, formEncode, StripeAdapter } from "./stripe";
import { WebhookSignatureError, type StripeEvent } from "./types";

const secret = "whsec_test_123";
const now = new Date("2026-11-08T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);
const body = JSON.stringify({ id: "evt_1", type: "invoice.payment_failed", created: t, data: { object: { customer: "cus_1" } } });

describe("Stripe-Signatur", () => {
  it("akzeptiert gültige Signatur (auch unter mehreren v1)", () => {
    expect(() => verifyStripeSignature(body, signStripePayload(body, secret, t), secret, { now })).not.toThrow();
    const multi = `t=${t},v1=${"0".repeat(64)},${signStripePayload(body, secret, t).split(",")[1]},v0=abc`;
    expect(() => verifyStripeSignature(body, multi, secret, { now })).not.toThrow();
    expect(parseVerifiedEvent(body, signStripePayload(body, secret, t), secret, now).id).toBe("evt_1");
  });
  it("lehnt falsche Signatur, falsches Secret, veränderten Body, fehlende Header ab", () => {
    const sig = signStripePayload(body, secret, t);
    expect(() => verifyStripeSignature(body + " ", sig, secret, { now })).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(body, sig, "whsec_other", { now })).toThrow(/ungültig/);
    expect(() => verifyStripeSignature(body, `t=${t},v1=zz`, secret, { now })).toThrow(/unvollständig/);
    expect(() => verifyStripeSignature(body, null, secret, { now })).toThrow(/fehlt/);
    expect(() => verifyStripeSignature(body, sig, null, { now })).toThrow(/Secret/);
  });
  it("lehnt abgelaufene Zeitstempel ab (> 5 Minuten)", () => {
    const old = signStripePayload(body, secret, t - 301);
    expect(() => verifyStripeSignature(body, old, secret, { now })).toThrow(/abgelaufen/);
    expect(() => verifyStripeSignature(body, signStripePayload(body, secret, t - 299), secret, { now })).not.toThrow();
    expect(() => verifyStripeSignature(body, signStripePayload(body, secret, t + 400), secret, { now })).toThrow(/abgelaufen/);
  });
  it("Mock prüft ebenfalls Signaturen; Produktion ohne Secret lehnt alles ab", () => {
    const mock = new StripeMock(secret);
    expect(mock.verifyWebhook(body, signStripePayload(body, secret, t), now).type).toBe("invoice.payment_failed");
    const prodMock = getBillingPort({ NODE_ENV: "production" });
    expect(prodMock.isMock).toBe(true);
    expect(() => prodMock.verifyWebhook(body, signStripePayload(body, "whsec_mock_dev_only", t), now)).toThrow(WebhookSignatureError);
  });
});

const prices = { starter: "price_s", praxis: "price_p", plus: "price_x", seat: "price_seat" };
const ev = (type: string, object: Record<string, unknown>, created = t): StripeEvent => ({ id: `evt_${type}`, type, created, data: { object } });
const ORG = "3f2a3c4e-1111-4222-8333-444455556666";

describe("Stripe-Events → Abo", () => {
  it("checkout.session.completed: Tarif, Plätze, Kunde, Abo", () => {
    const u = billingUpdateFromEvent(
      ev("checkout.session.completed", { mode: "subscription", client_reference_id: ORG, customer: "cus_1", subscription: "sub_1", metadata: { plan: "praxis", seats: "4", organizationId: ORG } }),
      prices,
    );
    expect(u).toEqual({ organizationId: ORG, customerId: "cus_1", patch: { subscriptionStatus: "active", plan: "praxis", seats: 4, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }, cancelAtPeriodEnd: false });
  });
  it("subscription.updated/deleted: Kündigung zum Periodenende (cancel_at_period_end oder cancel_at)", () => {
    const base = { id: "sub_1", customer: "cus_1", status: "active", metadata: { organizationId: ORG } };
    expect(billingUpdateFromEvent(ev("customer.subscription.updated", { ...base, cancel_at_period_end: true }), prices)?.cancelAtPeriodEnd).toBe(true);
    expect(billingUpdateFromEvent(ev("customer.subscription.updated", { ...base, cancel_at_period_end: false, cancel_at: t + 100 }), prices)?.cancelAtPeriodEnd).toBe(true);
    expect(billingUpdateFromEvent(ev("customer.subscription.updated", { ...base, cancel_at_period_end: false, cancel_at: null }), prices)?.cancelAtPeriodEnd).toBe(false);
    expect(billingUpdateFromEvent(ev("customer.subscription.deleted", { ...base, status: "canceled", cancel_at_period_end: true }), prices)?.cancelAtPeriodEnd).toBe(false);
    expect(billingUpdateFromEvent(ev("invoice.payment_failed", { customer: "cus_1" }), prices)?.cancelAtPeriodEnd).toBeUndefined();
  });
  it("checkout.session.completed ohne Zahlung (z. B. SEPA ausstehend) schaltet nicht frei", () => {
    const u = billingUpdateFromEvent(
      ev("checkout.session.completed", { mode: "subscription", payment_status: "unpaid", client_reference_id: ORG, customer: "cus_1", metadata: { plan: "praxis", seats: "2" } }),
      prices,
    );
    expect(u?.patch.subscriptionStatus).toBeUndefined();
    expect(u?.patch.stripeCustomerId).toBe("cus_1");
  });
  it("subscription.updated: Plan/Plätze aus Positionen, Status, Periodenende (neue API je Position)", () => {
    const u = billingUpdateFromEvent(
      ev("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "past_due",
        metadata: { organizationId: ORG },
        items: { data: [{ price: { id: "price_x" }, quantity: 1, current_period_end: t + 100 }, { price: { id: "price_seat" }, quantity: 2, current_period_end: t + 100 }] },
      }),
      prices,
    );
    expect(u?.patch).toEqual({ subscriptionStatus: "past_due", plan: "plus", seats: 5, currentPeriodEnd: new Date((t + 100) * 1000), stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
  });
  it("subscription.deleted → beendet; payment_failed → überfällig; Unbekanntes wird ignoriert", () => {
    const del = billingUpdateFromEvent(ev("customer.subscription.deleted", { id: "sub_1", customer: { id: "cus_1" }, status: "canceled", ended_at: t }), prices);
    expect(del?.patch.subscriptionStatus).toBe("canceled");
    expect(del?.patch.currentPeriodEnd).toEqual(now);
    expect(del?.customerId).toBe("cus_1");
    expect(billingUpdateFromEvent(ev("invoice.payment_failed", { customer: "cus_1" }), prices)?.patch).toEqual({ subscriptionStatus: "past_due" });
    expect(billingUpdateFromEvent(ev("charge.refunded", {}), prices)).toBeNull();
    expect(billingUpdateFromEvent(ev("checkout.session.completed", { mode: "payment" }), prices)).toBeNull();
  });
  it("Praxis-ID nur als UUID; Plätze auf Tarif-Maximum begrenzt", () => {
    expect(billingUpdateFromEvent(ev("checkout.session.completed", { client_reference_id: "x'; drop", metadata: {} }), prices)?.organizationId).toBeNull();
    expect(planFromItems({ items: { data: [{ price: "price_p" }, { price: "price_seat", quantity: 10 }] } }, prices)).toEqual({ plan: "praxis", seats: 5 });
  });
});

describe("Stripe-Adapter (echt, mit Fake-fetch)", () => {
  it("formEncode im Stripe-Format", () => {
    expect(decodeURIComponent(formEncode({ a: 1, line_items: [{ price: "p", quantity: 2 }], m: { k: "v" } }))).toBe("a=1&line_items[0][price]=p&line_items[0][quantity]=2&m[k]=v");
  });
  it("Checkout: Grundpreis + Zusatzplätze, Metadaten, Auth-Header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const a = new StripeAdapter({
      secretKey: "sk_test_x",
      prices,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200 });
      },
    });
    const r = await a.createCheckoutSession({ organizationId: ORG, plan: "praxis", seats: 4, email: "inhaber@example.org", successUrl: "https://x/ok", cancelUrl: "https://x/no" });
    expect(r.url).toContain("checkout.stripe.com");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    const sent = new URLSearchParams(String(calls[0].init?.body));
    expect(sent.get("line_items[0][price]")).toBe("price_p");
    expect(sent.get("line_items[1][price]")).toBe("price_seat");
    expect(sent.get("line_items[1][quantity]")).toBe("2");
    expect(sent.get("client_reference_id")).toBe(ORG);
    expect(sent.get("subscription_data[metadata][organizationId]")).toBe(ORG);
    expect(sent.get("mode")).toBe("subscription");
  });
  it("Abo kündigen/fortsetzen/sofort beenden, Kunde löschen: Methode, Pfad, Parameter; 404 tolerant", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const subJson = (extra: Record<string, unknown>) =>
      JSON.stringify({ id: "sub_A1", status: "active", customer: "cus_B2", metadata: {}, items: { data: [{ current_period_start: t, current_period_end: t + 100 }] }, ...extra });
    let next: Response = new Response(subJson({}), { status: 200 });
    const a = new StripeAdapter({ secretKey: "sk_test_x", fetch: async (url, init) => (calls.push({ url, init }), next) });

    const got = await a.getSubscription("sub_A1");
    expect(calls[0].url).toBe("https://api.stripe.com/v1/subscriptions/sub_A1");
    expect(calls[0].init?.method).toBe("GET");
    expect(got).toMatchObject({ id: "sub_A1", status: "active", cancelAtPeriodEnd: false, cancelReason: null, customerId: "cus_B2", currentPeriodStart: now, currentPeriodEnd: new Date((t + 100) * 1000) });

    next = new Response(subJson({ cancel_at_period_end: true, metadata: { cancel_reason: "deletion_request" } }), { status: 200 });
    const c = await a.setCancelAtPeriodEnd("sub_A1", true, "deletion_request");
    expect(calls[1].init?.method).toBe("POST");
    const sent = new URLSearchParams(String(calls[1].init?.body));
    expect(sent.get("cancel_at_period_end")).toBe("true");
    expect(sent.get("metadata[cancel_reason]")).toBe("deletion_request");
    expect(c).toMatchObject({ cancelAtPeriodEnd: true, cancelReason: "deletion_request" });

    next = new Response(subJson({}), { status: 200 });
    await a.setCancelAtPeriodEnd("sub_A1", false, null);
    const sent2 = new URLSearchParams(String(calls[2].init?.body));
    expect(sent2.get("cancel_at_period_end")).toBe("false");
    expect(sent2.get("metadata[cancel_reason]")).toBe(""); // leerer Wert entfernt den Schlüssel

    next = new Response(subJson({ status: "canceled" }), { status: 200 });
    await a.cancelSubscriptionNow("sub_A1");
    expect(calls[3].init?.method).toBe("DELETE");
    expect(calls[3].url).toBe("https://api.stripe.com/v1/subscriptions/sub_A1?prorate=false&invoice_now=false");

    next = new Response("{}", { status: 200 });
    await a.deleteCustomer("cus_B2");
    expect(calls[4]).toMatchObject({ url: "https://api.stripe.com/v1/customers/cus_B2", init: { method: "DELETE" } });

    next = new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 404 });
    expect(await a.getSubscription("sub_A1")).toBeNull();
    next = new Response(JSON.stringify({ error: { code: "resource_missing" } }), { status: 404 });
    await expect(a.deleteCustomer("cus_B2")).resolves.toBeUndefined();
    next = new Response("boom", { status: 500 });
    await expect(a.setCancelAtPeriodEnd("sub_A1", true, "owner")).rejects.toThrow(/HTTP 500/);
    // IDs landen im Pfad: fremdes Format wird abgelehnt, ohne Anfrage
    const before = calls.length;
    await expect(a.getSubscription("sub_A1/../../customers")).rejects.toThrow();
    await expect(a.deleteCustomer("x")).rejects.toThrow();
    expect(calls.length).toBe(before);
  });
  it("fehlende Price-ID oder Schlüssel → nicht konfiguriert", () => {
    expect(() => checkoutParams({ organizationId: ORG, plan: "plus", seats: 1, successUrl: "a", cancelUrl: "b" }, {})).toThrow(/STRIPE_PRICE_PLUS/);
    expect(() => new StripeAdapter({})).toThrow(/STRIPE_SECRET_KEY/);
  });
});
