/** Sammelrechnung Pflegeheim: Behandlung wird über invoice_lines.treatment_record_id nur einmal abgerechnet (erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Sammelrechnung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let delivery: typeof import("./invoice-delivery");
  let invoices: typeof import("./invoices");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delivery = await import("./invoice-delivery");
    invoices = await import("./invoices");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("schlägt nur nicht abgerechnete Behandlungen vor und verhindert Doppelabrechnung", async () => {
    const org = await f.org();
    const user = await f.user();
    const auth = { organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true } as never;
    const { home, resident, recs } = await f.asOrg(org, async (c) => {
      const home = (await c.query("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Haus Sonnenschein') returning id", [org])).rows[0].id as string;
      const resident = (await c.query("insert into patients (organization_id, number, last_name, first_name, care_home_id) values ($1, 1, 'Bewohner', 'Otto', $2) returning id", [org, home])).rows[0].id as string;
      const r1 = (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prev_hash, hash) values ($1,$2,$3,'2026-10-05 10:00+02',null,'a') returning id", [org, resident, user])).rows[0].id as string;
      const r2 = (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prev_hash, hash) values ($1,$2,$3,'2026-10-31 23:30+01','a','b') returning id", [org, resident, user])).rows[0].id as string;
      return { home, resident, recs: [r1, r2] };
    });
    expect(resident).toBeTruthy();

    const s1 = await delivery.collectiveSuggestion(auth, home, "2026-10");
    expect(s1!.lines.map((l) => l.treatmentRecordId)).toEqual(recs);
    // 31.10. 23:30 Berlin gehört zum Oktober (Zeitzone)
    expect(s1!.lines[1].description).toContain("31.10.2026");

    const line = (rid: string) => ({ serviceId: null, treatmentRecordId: rid, description: `Behandlung ${rid.slice(0, 4)}`, quantity: 1, factor: 1, unitPriceCents: 4000, vatRate: 0 });
    const base = { kind: "collective" as const, patientId: null, billingContactId: home, issuedAt: "2026-11-01", dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [] };
    const inv = await invoices.createInvoice(auth, { ...base, lines: [line(recs[0])] });

    // Mail-Text: „sofort“ statt Datum bei Zahlungsziel 0, sonst Datum
    const mailOf = (dueAt: string) =>
      delivery.invoiceEmailText({ invoice: { ...inv, issuedAt: "2026-11-01", dueAt, status: "issued", paidCents: 0, totalCents: 4000 }, organization: { name: "Praxis", legalName: null, phone: null } } as never).body;
    expect(mailOf("2026-11-01")).toMatch(/offenen Betrag von 40,00\s€ sofort unter Angabe/);
    expect(mailOf("2026-11-15")).toContain("bis zum 15.11.2026");

    const s2 = await delivery.collectiveSuggestion(auth, home, "2026-10");
    expect(s2!.lines.map((l) => l.treatmentRecordId)).toEqual([recs[1]]);
    expect(s2!.skipped).toBe(1);

    await expect(invoices.createInvoice(auth, { ...base, lines: [line(recs[0])] })).rejects.toThrow(/bereits in Rechnung/);
    // parallel: dieselbe Behandlung zweimal gleichzeitig → nur eine Rechnung
    const both = await Promise.allSettled([invoices.createInvoice(auth, { ...base, lines: [line(recs[1])] }), invoices.createInvoice(auth, { ...base, lines: [line(recs[1])] })]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // Storno gibt die Behandlung wieder frei
    await invoices.cancelInvoice(auth, inv.id, "falscher Monat");
    const s3 = await delivery.collectiveSuggestion(auth, home, "2026-10");
    expect(s3!.lines.map((l) => l.treatmentRecordId)).toEqual([recs[0]]);

    // fremde Behandlung (anderes Pflegeheim) wird abgelehnt
    const otherHome = await f.asOrg(org, async (c) => (await c.query("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Anderes Heim') returning id", [org])).rows[0].id as string);
    await expect(invoices.createInvoice(auth, { ...base, billingContactId: otherHome, lines: [line(recs[0])] })).rejects.toThrow(/gehört nicht/);
  });
});
