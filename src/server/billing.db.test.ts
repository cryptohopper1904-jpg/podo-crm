/** Stripe-Webhooks → Abo: idempotent (Wiederholung, parallele Zustellung), sichere Zuordnung, Plätze. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { StripeEvent } from "@/integrations/stripe/types";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Abo-Abrechnung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let billing: typeof import("./billing");
  const prices = { starter: "price_s", praxis: "price_p", plus: "price_x", seat: "price_seat" };
  const sfx = () => Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    billing = await import("./billing");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const orgRow = async (id: string) =>
    (await f.pool.query("select plan, subscription_status, seats, stripe_customer_id, stripe_subscription_id, current_period_end from organizations where id = $1", [id])).rows[0];

  it("checkout.session.completed genau einmal – auch parallel und wiederholt", async () => {
    const org = await f.org();
    const ev: StripeEvent = {
      id: `evt_${sfx()}`,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { mode: "subscription", client_reference_id: org, customer: `cus_${sfx()}`, subscription: "sub_1", metadata: { plan: "praxis", seats: "3" } } },
    };
    const results = await Promise.all([1, 2, 3].map(() => billing.processBillingEvent(ev, { prices })));
    expect(results.filter((r) => r === "processed")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(2);
    expect(await billing.processBillingEvent(ev, { prices })).toBe("duplicate");
    const o = await orgRow(org);
    expect(o).toMatchObject({ plan: "praxis", subscription_status: "active", seats: 3, stripe_subscription_id: "sub_1" });
    const rows = (await f.pool.query("select organization_id, processed_at from billing_events where external_id = $1", [ev.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(org);
    expect(rows[0].processed_at).not.toBeNull();
  });

  it("Folge-Events über die Kunden-ID; veraltete Events und fremde Kunden ändern nichts", async () => {
    const org = await f.org();
    const cus = `cus_${sfx()}`;
    const created = Math.floor(Date.now() / 1000);
    await billing.processBillingEvent(
      { id: `evt_${sfx()}`, type: "checkout.session.completed", created, data: { object: { client_reference_id: org, customer: cus, metadata: { plan: "starter", seats: "1" } } } },
      { prices },
    );
    const end = created + 30 * 86400;
    expect(
      await billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.updated", created: created + 10, data: { object: { id: "sub_9", customer: cus, status: "active", current_period_end: end, items: { data: [{ price: { id: "price_x" }, quantity: 1 }] } } } },
        { prices },
      ),
    ).toBe("processed");
    expect(await orgRow(org)).toMatchObject({ plan: "plus", seats: 3, stripe_subscription_id: "sub_9" });
    // älteres Event (Reihenfolge vertauscht) → ignoriert
    expect(
      await billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.updated", created: created + 5, data: { object: { id: "sub_9", customer: cus, status: "past_due" } } },
        { prices },
      ),
    ).toBe("ignored");
    expect((await orgRow(org)).subscription_status).toBe("active");
    // Metadaten zeigen auf diese Praxis, aber anderer Stripe-Kunde → nicht übernommen
    expect(
      await billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.deleted", created: created + 20, data: { object: { id: "sub_x", customer: "cus_fremd", metadata: { organizationId: org } } } },
        { prices },
      ),
    ).toBe("unassigned");
    expect((await orgRow(org)).subscription_status).toBe("active");
    // Zahlung fehlgeschlagen
    expect(await billing.processBillingEvent({ id: `evt_${sfx()}`, type: "invoice.payment_failed", created: created + 30, data: { object: { customer: cus } } }, { prices })).toBe("processed");
    expect((await orgRow(org)).subscription_status).toBe("past_due");
    // unbekannter Kunde
    expect(await billing.processBillingEvent({ id: `evt_${sfx()}`, type: "invoice.payment_failed", created, data: { object: { customer: "cus_unbekannt" } } }, { prices })).toBe("unassigned");
  });

  it("belegte Plätze: nur aktive Mitglieder, ohne Steuerberatung", async () => {
    const org = await f.org();
    for (const [role, active] of [["owner", true], ["therapist", true], ["accountant", true], ["reception", false]] as const) {
      const u = await f.user();
      await f.pool.query("insert into memberships (organization_id, user_id, role, active) values ($1,$2,$3,$4)", [org, u, role, active]);
    }
    expect(await billing.usedSeats(org)).toBe(2);
  });
});
