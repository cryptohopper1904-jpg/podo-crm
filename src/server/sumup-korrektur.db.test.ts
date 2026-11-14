/**
 * Migration 0048 (Altdaten-Korrektur paid_cents/status nach SumUp-Zahlungen auf Rechnungen mit angerechneten
 * Anzahlungen/Quittungen) und Webhook-Nebenläufigkeit. Echte DB, erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrlFrom = (url: string) => url.replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
const MIGRATION = readFileSync(path.join(__dirname, "../../drizzle/0048_sumup_zahlungen_korrektur.sql"), "utf8");

(TEST_DB ? describe : describe.skip)("SumUp-Zahlungen: Altdaten-Korrektur und Nebenläufigkeit (DB)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 1 });
  let invoices: typeof import("./invoices");
  let webhooks: typeof import("./webhooks");
  let delivery: typeof import("./invoice-delivery");
  let withOrg: typeof import("@/db").withOrg;
  const authFor = (org: string, user: string) =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;
  const line = { serviceId: null, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0 };
  const base = (patientId: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "invoice", patientId, billingContactId: null, issuedAt: "2026-11-13", dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], lines: [line], ...patch }) as never;
  const row = (org: string, id: string) =>
    f.asOrg(org, async (c) => (await c.query("select paid_cents, status from invoices where id = $1", [id])).rows[0] as { paid_cents: number; status: string });
  const corrections = (org: string, id: string) =>
    f.asOrg(org, async (c) => (await c.query("select meta from audit_log where entity_id = $1 and action = 'invoice.paid_correction'", [id])).rows.map((r) => r.meta));

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    invoices = await import("./invoices");
    webhooks = await import("./webhooks");
    delivery = await import("./invoice-delivery");
    ({ withOrg } = await import("@/db"));
  });
  afterAll(async () => {
    await owner.end();
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Altfall (Anzahlung angerechnet, SumUp-Zahlung, paid_cents falsch) wird korrigiert – korrekte Rechnungen bleiben unberührt, zweiter Lauf ändert nichts", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Behandlung", amountCents: 1500, vatRate: 0, method: "cash", notes: null });
    const broken = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    expect((await webhooks.recordProviderPayment(org, { invoiceId: broken.id, externalRef: `sumup:alt-${broken.id}`, amountCents: 5000, method: "card" })).status).toBe("gebucht");
    // Zustand wie nach dem früheren Webhook: paid_cents = nur Summe der Zahlungszeilen
    await f.asOrg(org, (c) => c.query("update invoices set paid_cents = 5000, status = 'partially_paid' where id = $1", [broken.id]));

    const ok = await invoices.createInvoice(auth, base(patient));
    await webhooks.recordProviderPayment(org, { invoiceId: ok.id, externalRef: `sumup:ok-${ok.id}`, amountCents: 2000, method: "payment_link" });
    // ohne SumUp-Zahlung: nicht im Umfang der Korrektur (auch wenn abweichend)
    const other = await invoices.createInvoice(auth, base(patient));
    await f.asOrg(org, (c) => c.query("update invoices set paid_cents = 100, status = 'partially_paid' where id = $1", [other.id]));

    await owner.query(MIGRATION);
    expect(await row(org, broken.id)).toEqual({ paid_cents: 6500, status: "paid" });
    expect(await corrections(org, broken.id)).toEqual([
      expect.objectContaining({ old: { paidCents: 5000, status: "partially_paid" }, new: { paidCents: 6500, status: "paid" }, migration: "0048_sumup_zahlungen_korrektur" }),
    ]);
    expect(await row(org, ok.id)).toEqual({ paid_cents: 2000, status: "partially_paid" });
    expect(await corrections(org, ok.id)).toEqual([]);
    expect(await row(org, other.id)).toEqual({ paid_cents: 100, status: "partially_paid" });

    await owner.query(MIGRATION);
    expect(await corrections(org, broken.id)).toHaveLength(1);
    expect(await row(org, broken.id)).toEqual({ paid_cents: 6500, status: "paid" });
    const idx = await owner.query("select 1 from pg_indexes where indexname = 'payments_org_sumup_ref'");
    expect(idx.rowCount).toBe(1);
  });

  it("Korrektur: stornierte Teilbelege zählen nicht; Überzahlung wird im Audit markiert", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Behandlung", amountCents: 1500, vatRate: 0, method: "cash", notes: null });
    const inv = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:ueber-${inv.id}`, amountCents: 5000, method: "card" });
    // erfundener Altzustand: Anzahlung als storniert markiert (dürfte so nicht vorkommen – Härtung der Korrektur) …
    await f.asOrg(org, (c) => c.query("update invoices set status = 'cancelled' where id = $1", [dep.id]));
    await f.asOrg(org, (c) => c.query("update invoices set paid_cents = 9000, status = 'paid' where id = $1", [inv.id]));
    await owner.query(MIGRATION);
    expect(await row(org, inv.id)).toEqual({ paid_cents: 5000, status: "partially_paid" });
    expect((await corrections(org, inv.id))[0]).not.toHaveProperty("overpaid");

    // … Überzahlung (zweite SumUp-Zahlung, Altbestand) → overpaid: true
    const inv2 = await invoices.createInvoice(auth, base(patient));
    await webhooks.recordProviderPayment(org, { invoiceId: inv2.id, externalRef: `sumup:u1-${inv2.id}`, amountCents: 6500, method: "card" });
    await f.asOrg(org, (c) => c.query("insert into payments (organization_id, invoice_id, method, amount_cents, external_ref) values ($1,$2,'card',1000,$3)", [org, inv2.id, `sumup:u2-${inv2.id}`]));
    await owner.query(MIGRATION);
    expect(await row(org, inv2.id)).toEqual({ paid_cents: 7500, status: "paid" });
    expect((await corrections(org, inv2.id))[0]).toMatchObject({ overpaid: true, new: { paidCents: 7500, status: "paid" } });
  });

  it("manuelle Zahlung mit Referenz „sumup:“ (jede Schreibweise) wird abgelehnt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient));
    for (const ref of ["sumup:fake-1", "SumUp:fake-2", "  SUMUP:fake-3"]) {
      await expect(invoices.addPayments(auth, inv.id, [{ method: "transfer", amountCents: 100, voucherCode: null, externalRef: ref } as never])).rejects.toThrow(/nicht mit „sumup:“ beginnen/);
    }
    await expect(invoices.createInvoice(auth, base(patient, { payments: [{ method: "transfer", amountCents: 100, voucherCode: null, externalRef: "sumup:x" }] }))).rejects.toThrow(/sumup:/);
    expect(await row(org, inv.id)).toEqual({ paid_cents: 0, status: "issued" });
  });

  it("Unique-Verletzung auf payments_org_sumup_ref wird als „bereits gebucht“ erkannt", async () => {
    const org = await f.org();
    const patient = await f.patient(org);
    const inv = await f.invoice(org, patient, 6500);
    const ref = `sumup:dup-${inv}`;
    await f.asOrg(org, (c) => c.query("insert into payments (organization_id, invoice_id, method, amount_cents, external_ref) values ($1,$2,'card',100,$3)", [org, inv, ref]));
    // echter Fehler aus der App-DB-Schicht (Drizzle verpackt den pg-Fehler)
    const { payments } = await import("@/db/schema");
    const err = await withOrg(org, (tx) => tx.insert(payments).values({ organizationId: org, invoiceId: inv, method: "card", amountCents: 100, externalRef: ref })).catch((e: unknown) => e);
    expect(webhooks.isDuplicateProviderRef(err)).toBe(true);
    expect(webhooks.isDuplicateProviderRef(new Error("x"))).toBe(false);
    expect(webhooks.isDuplicateProviderRef({ code: "23505", constraint: "prescriptions_external_ref_org" })).toBe(false);
  });

  it("5 gleichzeitige Zustellungen derselben Transaktion → genau eine Zahlung", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient));
    const input = { invoiceId: inv.id, externalRef: `sumup:par-${inv.id}`, amountCents: 6500, method: "card" as const };
    const res = await Promise.all(Array.from({ length: 5 }, () => webhooks.recordProviderPayment(org, input)));
    expect(res.filter((r) => r.status === "gebucht")).toHaveLength(1);
    expect(res.filter((r) => r.status === "bereits gebucht")).toHaveLength(4);
    const n = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from payments where invoice_id = $1", [inv.id])).rows[0].n);
    expect(n).toBe(1);
    expect(await row(org, inv.id)).toEqual({ paid_cents: 6500, status: "paid" });
    // Index sperrt eine zweite Zeile mit derselben SumUp-Referenz auch direkt
    await expect(f.asOrg(org, (c) => c.query("insert into payments (organization_id, invoice_id, method, amount_cents, external_ref) values ($1,$2,'card',1,$3)", [org, inv.id, input.externalRef]))).rejects.toThrow(/payments_org_sumup_ref/);
  });

  it("Webhook parallel zu „Zahlung erfassen“ → keine Überzahlung", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient));
    const [hook, manual] = await Promise.allSettled([
      webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:race-${inv.id}`, amountCents: 6500, method: "card" }),
      invoices.addPayments(auth, inv.id, [{ method: "cash", amountCents: 6500, voucherCode: null, externalRef: null } as never]),
    ]);
    const booked = (hook.status === "fulfilled" && hook.value.status === "gebucht" ? 1 : 0) + (manual.status === "fulfilled" ? 1 : 0);
    expect(booked).toBe(1);
    expect(await row(org, inv.id)).toEqual({ paid_cents: 6500, status: "paid" });
    const sum = await f.asOrg(org, async (c) => (await c.query("select coalesce(sum(amount_cents),0)::int as s from payments where invoice_id = $1", [inv.id])).rows[0].s);
    expect(sum).toBe(6500);
  });

  it("Begleittext bei späterer Teilzahlung: Eingang und Restbetrag, Hinweis auf Stand bei Ausstellung", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient));
    await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:teil-${inv.id}`, amountCents: 2500, method: "payment_link" });
    const bundle = (await withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, inv.id)))!;
    const body = delivery.invoiceEmailText(bundle).body;
    expect(body).toContain("Bereits eingegangen: 25,00");
    expect(body).toMatch(/Bitte nur den Restbetrag von 40,00\s€ bis zum 27\.11\.2026 unter Angabe der Rechnungsnummer überweisen – Betrag und GiroCode im PDF entsprechen dem Stand bei Ausstellung\./);
  });
});
