/** Leistungsdatum (§ 14 Abs. 4 Nr. 6 UStG) je Belegart – speichern, festschreiben, auf dem Beleg ausgeben (echte DB, erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { dateDe } from "@/lib/format";
import { invoiceHeading } from "@/lib/invoice-view";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Leistungsdatum auf Belegen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let withOrg: typeof import("@/db").withOrg;
  let berlinDateIso: typeof import("@/lib/format").berlinDateIso;
  const authFor = (org: string, user: string) =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;
  const line = (patch: Record<string, unknown> = {}) => ({ serviceId: null, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0, ...patch });
  const base = (patientId: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "invoice", patientId, billingContactId: null, issuedAt: "2026-11-13", dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], lines: [line()], ...patch }) as never;
  const bundle = (org: string, id: string) => withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, id)).then((b) => b!);
  const heading = (b: Awaited<ReturnType<typeof bundle>>) => invoiceHeading(b.invoice, b.serviceDates, dateDe, b.cancels?.number);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    invoices = await import("./invoices");
    ({ withOrg } = await import("@/db"));
    ({ berlinDateIso } = await import("@/lib/format"));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("ohne Termin-Bezug: Standard = Rechnungsdatum, ausdrücklich gesetztes Datum wird gespeichert und gedruckt; Zukunft abgelehnt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);

    const dflt = await invoices.createInvoice(auth, base(patient));
    const b1 = await bundle(org, dflt.id);
    expect(b1.invoice.serviceDate).toBe("2026-11-13");
    expect(heading(b1)).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum: 13.11.2026" });

    const rec = await invoices.createInvoice(auth, base(patient, { kind: "receipt", serviceDate: "2026-11-10", payments: [{ method: "cash", amountCents: 6500, voucherCode: null, externalRef: null }] }));
    const b2 = await bundle(org, rec.id);
    expect(b2.invoice.serviceDate).toBe("2026-11-10");
    expect(heading(b2)).toEqual({ heading: "Quittung", serviceDateNote: "Leistungsdatum: 10.11.2026" });

    await expect(invoices.createInvoice(auth, base(patient, { serviceDate: "2999-01-01" }))).rejects.toThrow(/Leistungsdatum darf nicht in der Zukunft/);
  });

  it("mit Termin: Datum des Termins gilt (kein gespeichertes Leistungsdatum), Storno nennt es weiter", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const appt = await f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,'2026-03-12 09:00+01','2026-03-12 09:45+01','done') returning id", [org, patient])).rows[0].id as string);
    // Formularwert wird bei verknüpfter Position ignoriert
    const inv = await invoices.createInvoice(auth, base(patient, { serviceDate: "2026-11-13", lines: [line({ appointmentId: appt })] }));
    const b = await bundle(org, inv.id);
    expect(b.invoice.serviceDate).toBeNull();
    expect(heading(b)).toEqual({ heading: "Rechnung zur Behandlung am 12.03.2026", serviceDateNote: null });

    const storno = await invoices.cancelInvoice(auth, inv.id, "Test");
    const s = await bundle(org, storno.id);
    expect(heading(s)).toEqual({ heading: `Stornorechnung zur Rechnung ${inv.number}`, serviceDateNote: "Leistungsdatum der stornierten Rechnung: 12.03.2026" });

    // Storno einer Rechnung ohne Bezug: gespeichertes Leistungsdatum der Originalrechnung
    const plain = await invoices.createInvoice(auth, base(patient, { serviceDate: "2026-11-11" }));
    const s2 = await bundle(org, (await invoices.cancelInvoice(auth, plain.id, "Test")).id);
    expect(heading(s2).serviceDateNote).toBe("Leistungsdatum der stornierten Rechnung: 11.11.2026");
  });

  it("Anzahlung für einen künftigen Termin: Zahlungstag + „Leistung noch nicht erbracht“", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const appt = await f.asOrg(org, async (c) =>
      (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() + interval '8 days', now() + interval '8 days 45 minutes','planned') returning id", [org, patient])).rows[0].id as string,
    );
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: appt, description: "Anzahlung Spangenbehandlung", amountCents: 5000, vatRate: 0, method: "cash" } as never);
    const b = await bundle(org, dep.id);
    expect(b.invoice.serviceDate).toBeNull();
    const n = heading(b);
    expect(n.heading).toBe("Quittung über eine Anzahlung");
    expect(n.serviceDateNote).toMatch(new RegExp(`^Anzahlung erhalten am ${dateDe(berlinDateIso())} für die Behandlung am \\d\\d\\.\\d\\d\\.\\d{4} – Leistung noch nicht erbracht\\.$`));
  });

  it("Leistungsdatum ist nach dem Ausstellen unveränderbar (GoBD-Trigger)", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const inv = await invoices.createInvoice(auth, base(await f.patient(org)));
    await expect(f.asOrg(org, (c) => c.query("update invoices set service_date = '2026-01-01' where id = $1", [inv.id]))).rejects.toThrow(/unveränderbar/);
  });
});
