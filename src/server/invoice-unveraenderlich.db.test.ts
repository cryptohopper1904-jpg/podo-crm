/**
 * Unveränderbarkeit ausgestellter Belege (GoBD, § 14 UStG): Eine später erfasste Zahlung („Zahlung erfassen“ bar,
 * SumUp-Zahlung) darf Text, Beträge, Hinweise und GiroCode des PDFs nicht ändern. Beim Ausstellen erfasste Zahlungen
 * (Quittung, Teilzahlung am Tresen) stehen weiterhin auf dem Beleg. Echte DB, erfundene Daten.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PDFPage } from "pdf-lib";
import { invoiceAsIssued } from "@/lib/invoice-view";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

let drawn: string[] = [];
beforeEach(() => {
  drawn = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
    drawn.push(text);
    return orig.call(this, text, options);
  });
});
afterEach(() => vi.restoreAllMocks());

(TEST_DB ? describe : describe.skip)("Beleg bleibt nach späterer Zahlung unverändert (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let delivery: typeof import("./invoice-delivery");
  let webhooks: typeof import("./webhooks");
  let withOrg: typeof import("@/db").withOrg;
  const authFor = (org: string, user: string) =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;
  const line = { serviceId: null, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0 };
  const base = (patientId: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "invoice", patientId, billingContactId: null, issuedAt: "2026-11-13", dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], lines: [line], ...patch }) as never;
  const pay = (method: string, amountCents: number) => ({ method, amountCents, voucherCode: null, externalRef: null }) as never;
  /** Belegtext des PDFs, wie es Download, E-Mail-Versand und Patientenportal ausliefern (invoicePdfForOrg) */
  const pdfText = async (org: string, id: string) => {
    drawn = [];
    const pdf = await delivery.invoicePdfForOrg(org, id);
    expect(pdf).not.toBeNull();
    return [...drawn];
  };
  const bundle = (org: string, id: string) => withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, id)).then((b) => b!);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    invoices = await import("./invoices");
    delivery = await import("./invoice-delivery");
    webhooks = await import("./webhooks");
    ({ withOrg } = await import("@/db"));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Rechnung mit Zahlungsziel: „Zahlung erfassen“ (bar) ändert das PDF nicht – App-Status wird „bezahlt“", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    await f.asOrg(org, (c) => c.query("update organizations set iban = 'DE02120300000000202051' where id = $1", [org]));
    const inv = await invoices.createInvoice(auth, base(patient));
    const before = await pdfText(org, inv.id);
    expect(before).toContain("Zahlbar bis:");
    expect(before.join("\n")).toMatch(/Bitte überweisen Sie den Betrag bis zum 27\.11\.2026/);
    expect(before).toContain("Bezahlen per GiroCode");

    await invoices.addPayments(auth, inv.id, [pay("cash", 6500)]);
    const after = await pdfText(org, inv.id);
    expect(after).toEqual(before);
    expect(after.join("\n")).not.toMatch(/in bar|erhalten|bezahlt – vielen Dank/);
    // erneuter E-Mail-Versand: PDF wie ausgestellt, der Begleittext nennt den aktuellen Stand
    const mail = delivery.invoiceEmailText(await bundle(org, inv.id)).body;
    expect(mail).toContain("bereits vollständig bei uns eingegangen");
    expect(mail).not.toContain("Bitte überweisen");

    // App (außerhalb des Belegs): aktueller Stand und die spätere Zahlung als eigener Vorgang
    const b = await bundle(org, inv.id);
    expect(b.invoice).toMatchObject({ status: "paid", paidCents: 6500 });
    const issued = invoiceAsIssued(b.invoice, b.payments);
    expect(issued.invoice).toMatchObject({ status: "issued", paidCents: 0 });
    expect(issued.payments).toEqual([]);
    expect(issued.laterPayments.map((p) => ({ method: p.method, amountCents: p.amountCents }))).toEqual([{ method: "cash", amountCents: 6500 }]);
  });

  it("Quittung (bar beim Ausstellen): „Betrag dankend erhalten“ und Zahlungsblock bleiben auf dem Beleg", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const rec = await invoices.createInvoice(auth, base(patient, { kind: "receipt", payments: [pay("cash", 6500)] }));
    const text = await pdfText(org, rec.id);
    expect(text).toContain("Zahlung in bar – Betrag dankend erhalten.");
    expect(text).toContain("Zahlungen");
    expect(text).not.toContain("Zahlbar bis:");
    const b = await bundle(org, rec.id);
    expect(invoiceAsIssued(b.invoice, b.payments)).toMatchObject({ invoice: { status: "paid", paidCents: 6500 }, laterPayments: [] });
  });

  it("Teilzahlung beim Ausstellen bleibt, die spätere Restzahlung nicht", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient, { payments: [pay("card", 2000)] }));
    const before = await pdfText(org, inv.id);
    expect(before).toContain("Bereits bezahlt per Karte: 20,00 €. Offen: 45,00 €.");

    await invoices.addPayments(auth, inv.id, [pay("cash", 4500)]);
    expect(await pdfText(org, inv.id)).toEqual(before);
    expect((await bundle(org, inv.id)).invoice).toMatchObject({ status: "paid", paidCents: 6500 });
  });

  it("angerechnete Anzahlung + spätere SumUp-Zahlung: Beleg unverändert, Status/paid_cents korrekt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Behandlung", amountCents: 1500, vatRate: 0, method: "cash", notes: null });
    const inv = await invoices.createInvoice(auth, base(patient, { depositIds: [dep.id] }));
    const before = await pdfText(org, inv.id);
    expect(before.some((t) => t.startsWith("abzgl. Anzahlung"))).toBe(true);

    const res = await webhooks.recordProviderPayment(org, { invoiceId: inv.id, externalRef: `sumup:test-${inv.id}`, amountCents: 5000, method: "payment_link" });
    expect(res.status).toBe("gebucht");
    // paid_cents = Anzahlung + Zahlung (früher: nur Summe der Zahlungszeilen → angerechnete Anzahlung ging verloren)
    expect((await bundle(org, inv.id)).invoice).toMatchObject({ status: "paid", paidCents: 6500 });
    expect(await pdfText(org, inv.id)).toEqual(before);
  });

  it("Anzahlungs-Quittung: Zahlung beim Ausstellen gehört zum Beleg", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Nagelspange", amountCents: 3000, vatRate: 0, method: "card", notes: null });
    expect(await pdfText(org, dep.id)).toContain("Zahlung per Karte – Betrag dankend erhalten.");
  });
});
