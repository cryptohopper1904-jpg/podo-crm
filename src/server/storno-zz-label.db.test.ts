/**
 * Storno einer Zuzahlungsquittung heißt „Storno Zuzahlungsquittung“ (nicht „Stornorechnung“) – serverseitig:
 * Zahlungsbeleg (festgeschriebene Originalart), Patientenportal und lexoffice-Bemerkung. Erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { hashPortalToken, newPortalToken } from "@/lib/portal";
import { LexofficeMock } from "@/integrations/lexoffice/mock";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Storno Zuzahlungsquittung – Bezeichnungen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let receipts: typeof import("./payment-receipts");
  let portal: typeof import("./portal-core");
  let dbm: typeof import("@/db");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    invoices = await import("./invoices");
    receipts = await import("./payment-receipts");
    portal = await import("./portal-core");
    dbm = await import("@/db");
  });
  afterAll(async () => {
    await f.end();
    await (dbm.db.$client as { end: () => Promise<void> }).end();
  });

  async function setup() {
    const org = await f.org();
    const user = await f.user(org);
    const auth = { organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Anna Test" }, can: () => true } as never;
    const patient = await f.patient(org);
    /** ausgestellter Beleg; Storno (credit_note) mit negativen Beträgen */
    const doc = (kind: string, opts: { cancels?: string; totalCents?: number; paidCents?: number; status?: string } = {}) =>
      f.asOrg(org, async (c) => {
        const prescription =
          kind === "copayment"
            ? ((await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,'2026-11-02','DF',6) returning id", [org, patient])).rows[0].id as string)
            : null;
        const total = opts.totalCents ?? (kind === "credit_note" ? -1000 : 1000);
        const id = (
          await c.query("insert into invoices (organization_id, patient_id, status, kind, cancels_invoice_id, prescription_id) values ($1,$2,'draft',$3,$4,$5) returning id", [
            org,
            patient,
            kind,
            opts.cancels ?? null,
            prescription,
          ])
        ).rows[0].id as string;
        await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Zuzahlung',$3,$3,0,1)", [org, id, total]);
        const number = `${kind === "credit_note" ? "ST" : kind === "copayment" ? "ZZ" : "R"}-${Math.random().toString(36).slice(2, 10)}`;
        await c.query("update invoices set status=$5, number=$2, issued_at='2026-11-05', total_cents=$3, net_cents=$3, paid_cents=$4 where id=$1 and organization_id=$6", [
          id,
          number,
          total,
          opts.paidCents ?? 0,
          opts.status ?? "issued",
          org,
        ]);
        return { id, number };
      });
    return { org, auth, patient, doc };
  }

  it("4. Zahlungsbeleg zur Erstattung auf das Storno einer Zuzahlungsquittung schreibt die Originalart fest", async () => {
    const { org, doc } = await setup();
    const zz = await doc("copayment", { status: "cancelled", paidCents: 1000 });
    const st = await doc("credit_note", { cancels: zz.id });
    const r = await doc("invoice", { status: "cancelled" });
    const sr = await doc("credit_note", { cancels: r.id });
    const refund = async (invoiceId: string) => {
      const payId = await f.asOrg(org, async (c) => {
        const id = (await c.query("insert into payments (organization_id, invoice_id, method, amount_cents, paid_at) values ($1,$2,'cash',-1000,now()) returning id", [org, invoiceId])).rows[0].id as string;
        await c.query("update invoices set paid_cents = paid_cents - 1000 where id = $1 and organization_id = $2", [invoiceId, org]);
        return id;
      });
      const [rec] = await dbm.withOrg(org, (tx) => receipts.recordPaymentReceipts(tx, org, invoiceId, [payId], null));
      return f.asOrg(org, async (c) => (await c.query("select data from payment_receipts where id = $1", [rec.id])).rows[0].data);
    };
    const zzData = await refund(st.id);
    expect(zzData.invoice).toMatchObject({ number: st.number, kind: "credit_note", cancelsKind: "copayment" });
    const { paymentReceiptTitle } = await import("@/lib/payment-receipt");
    expect(paymentReceiptTitle(zzData)).toMatch(/zu Storno Zuzahlungsquittung Nr\. /);
    const srData = await refund(sr.id);
    expect(srData.invoice.cancelsKind).toBe("invoice");
    expect(paymentReceiptTitle(srData)).toMatch(/zu Stornorechnung Nr\. /);
  });

  it("3. Patientenportal: Storno einer Zuzahlungsquittung heißt „Storno Zuzahlungsquittung“, Rechnung bleibt „Rechnung“", async () => {
    const { org, patient, doc } = await setup();
    const zz = await doc("copayment", { status: "cancelled", paidCents: 1000 });
    // offener Betrag > 0 (sonst erscheint ein Storno nicht in „Offene Rechnungen“)
    const st = await doc("credit_note", { cancels: zz.id, totalCents: -1000, paidCents: -1500 });
    const inv = await doc("invoice");
    const token = newPortalToken();
    await f.pool.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at) values ($1,$2,'portal',$3,$4)", [
      org,
      patient,
      hashPortalToken(token),
      new Date(Date.now() + 86400_000),
    ]);
    const view = await portal.loadPortalView((await portal.resolvePortalLink(token))!);
    const label = (id: string) => view!.invoices.find((i) => i.id === id)?.label;
    expect(label(st.id)).toBe("Storno Zuzahlungsquittung");
    expect(label(inv.id)).toBe("Rechnung");
    expect(view!.invoices.some((i) => "cancelsInvoiceId" in i)).toBe(false);
  });

  it("5. lexoffice-Bemerkung: „Storno Zuzahlungsquittung …“; normales Storno bleibt „Stornorechnung …“", async () => {
    const { auth, doc } = await setup();
    const spy = vi.spyOn(LexofficeMock.prototype, "pushVoucher");
    try {
      const zz = await doc("copayment", { status: "cancelled", paidCents: 1000 });
      const st = await doc("credit_note", { cancels: zz.id });
      expect((await invoices.pushInvoiceToAccounting(auth, st.id)).ok).toBe(true);
      expect(spy.mock.calls.at(-1)![0].remark).toBe(`Storno Zuzahlungsquittung ${st.number}`);
      const r = await doc("invoice", { status: "cancelled" });
      const sr = await doc("credit_note", { cancels: r.id });
      expect((await invoices.pushInvoiceToAccounting(auth, sr.id)).ok).toBe(true);
      expect(spy.mock.calls.at(-1)![0].remark).toBe(`Stornorechnung ${sr.number}`);
    } finally {
      spy.mockRestore();
    }
  });
});
