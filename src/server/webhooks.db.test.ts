/** SumUp-Webhook → Zahlung: idempotent (Wiederholung, parallele Zustellung), Zuordnung über Referenz oder checkout_ref. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { SumupMock } from "@/integrations/sumup/mock";
import type { NormalizedWebhookEvent } from "@/integrations/types";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("SumUp-Zahlungen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let wh: typeof import("./webhooks");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    wh = await import("./webhooks");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const state = async (org: string, inv: string) =>
    f.asOrg(org, async (c) => ({
      inv: (await c.query("select status, paid_cents from invoices where id = $1", [inv])).rows[0],
      payments: (await c.query("select method, amount_cents, external_ref from payments where invoice_id = $1", [inv])).rows,
    }));

  it("bucht einen Zahlungslink genau einmal – auch bei Wiederholung und paralleler Zustellung", async () => {
    const org = await f.org();
    const p = await f.patient(org);
    const inv = await f.invoice(org, p, 6500);
    const port = new SumupMock();
    const { checkoutId } = await port.createCheckout({ reference: `${inv}.ab12cd34`, amountCents: 6500 });
    const ev: NormalizedWebhookEvent = { provider: "sumup", externalId: "e1", type: "CHECKOUT_STATUS_CHANGED", objectId: checkoutId, status: null, needsFetch: true, raw: {} };

    const results = await Promise.all([wh.processSumupEvent(org, ev, { port }), wh.processSumupEvent(org, ev, { port }), wh.processSumupEvent(org, ev, { port })]);
    expect(results.filter((r) => r === "gebucht")).toHaveLength(1);
    expect(results.filter((r) => r === "bereits gebucht")).toHaveLength(2);
    expect(await wh.processSumupEvent(org, ev, { port })).toBe("bereits gebucht");

    const s = await state(org, inv);
    expect(s.inv).toEqual({ status: "paid", paid_cents: 6500 });
    expect(s.payments).toEqual([{ method: "payment_link", amount_cents: 6500, external_ref: `sumup:${checkoutId}` }]);
  });

  it("Terminal ohne Referenz: Zuordnung über invoices.checkout_ref, Methode Karte", async () => {
    const org = await f.org();
    const inv = await f.invoice(org, await f.patient(org), 4000);
    const port = new SumupMock();
    const { clientTransactionId } = await port.startTerminalPayment({ readerId: "rdr", amountCents: 4000 });
    await f.asOrg(org, (c) => c.query("update invoices set checkout_ref = $2 where id = $1", [inv, `reader:${clientTransactionId}`]));
    const ev: NormalizedWebhookEvent = { provider: "sumup", externalId: "e2", type: "solo.transaction.updated", objectId: clientTransactionId, status: "paid", needsFetch: true, raw: {} };
    expect(await wh.processSumupEvent(org, ev, { port })).toBe("gebucht");
    expect(await wh.processSumupEvent(org, ev, { port })).toBe("bereits gebucht");
    const s = await state(org, inv);
    expect(s.inv.status).toBe("paid");
    expect(s.payments.map((x: { method: string }) => x.method)).toEqual(["card"]);
  });

  it("bucht nicht in fremde Praxis, nicht bei fehlgeschlagener Zahlung, Teilzahlung → teilbezahlt", async () => {
    const orgA = await f.org();
    const orgB = await f.org();
    const invA = await f.invoice(orgA, await f.patient(orgA), 5000);
    // Referenz zeigt auf Rechnung von A, Ereignis kommt aber für Praxis B → RLS findet nichts
    expect((await wh.recordProviderPayment(orgB, { invoiceId: invA, externalRef: "sumup:x1", amountCents: 5000, method: "card" })).status).toBe("Rechnung nicht gefunden");

    const port = new SumupMock();
    const failed = await port.createCheckout({ reference: invA, amountCents: 5013 }); // Mock: …13 Cent = fehlgeschlagen
    expect(await wh.processSumupEvent(orgA, { provider: "sumup", externalId: "e3", type: "CHECKOUT_STATUS_CHANGED", objectId: failed.checkoutId, status: null, needsFetch: true, raw: {} }, { port })).toBe("Status failed");

    expect((await wh.recordProviderPayment(orgA, { invoiceId: invA, externalRef: "sumup:part", amountCents: 2000, method: "payment_link" })).status).toBe("gebucht");
    const s = await state(orgA, invA);
    expect(s.inv).toEqual({ status: "partially_paid", paid_cents: 2000 });
  });

  it("Referenz-Format: Rechnungs-ID mit Suffix", () => {
    const id = "0b9c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f";
    expect(wh.invoiceIdFromReference(id)).toBe(id);
    expect(wh.invoiceIdFromReference(`${id}.ab12`)).toBe(id);
    expect(wh.invoiceIdFromReference(`${id}x`)).toBeNull();
    expect(wh.invoiceIdFromReference("R2026-0001")).toBeNull();
  });
});
