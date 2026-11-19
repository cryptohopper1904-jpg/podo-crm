/**
 * Altbestand aus dem Import (Excel-Rechnungsmanager, invoices.source ≠ "crm") in Buchhaltung, Portal, Zahlungslink,
 * Versand, Mahnwesen und Auswertung (Buchhaltung Runde 2: L1, P1, F1). Erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// PDF-Erzeugung beobachten (Verhalten unverändert): Altbestand darf vor der Herkunftsprüfung kein PDF rendern
vi.mock("@/lib/invoice-pdf", async (orig) => {
  const m = await orig<typeof import("@/lib/invoice-pdf")>();
  return { ...m, renderInvoicePdf: vi.fn(m.renderInvoicePdf) };
});
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { hashPortalToken, newPortalToken } from "@/lib/portal";
import { IMPORTED_INVOICE_LOCKED, IMPORTED_RECEIPT_MARK } from "@/lib/invoice-labels";
import { receiptMark } from "@/lib/partial-lines";
import { IMPORTED_NOT_DUNNABLE } from "@/lib/dunning";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Altbestand aus Import: Buchhaltung, Portal, Mahnwesen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let cards: typeof import("./card-payments");
  let delivery: typeof import("./invoice-delivery");
  let dunning: typeof import("./dunning");
  let portal: typeof import("./portal-core");
  let finance: typeof import("./finance");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    invoices = await import("./invoices");
    cards = await import("./card-payments");
    delivery = await import("./invoice-delivery");
    dunning = await import("./dunning");
    portal = await import("./portal-core");
    finance = await import("./finance");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function setup() {
    const org = await f.org();
    const user = await f.user(org);
    const auth = { organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Anna Test" }, can: () => true } as never;
    const patient = await f.patient(org, { email: "erika@example.invalid" });
    /** ausgestellte Rechnung (überfällig), wahlweise als Altbestand aus dem Excel-Import */
    const invoice = (source: "crm" | "excel-import", opts: { kind?: string; cancels?: string | null; paidCents?: number; status?: string } = {}) =>
      f.asOrg(org, async (c) => {
        const id = (
          await c.query("insert into invoices (organization_id, patient_id, status, source, kind, cancels_invoice_id) values ($1,$2,'draft',$3,$4,$5) returning id", [
            org,
            patient,
            source,
            opts.kind ?? "invoice",
            opts.cancels ?? null,
          ])
        ).rows[0].id as string;
        await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Behandlung',5000,5000,0,1)", [org, id]);
        await c.query("update invoices set status=$5, number=$2, issued_at='2026-09-01', due_at='2026-09-15', total_cents=5000, net_cents=5000, paid_cents=$3 where id=$1 and organization_id=$4", [
          id,
          `${source === "crm" ? "R" : "ALT"}-${Math.random().toString(36).slice(2, 10)}`,
          opts.paidCents ?? 0,
          org,
          opts.status ?? "issued",
        ]);
        return id;
      });
    return { org, user, auth, patient, invoice };
  }

  it("L1: Altrechnung aus dem Import wird nicht an lexoffice übertragen; Storno einer Altrechnung ebenso nicht", async () => {
    const { auth, invoice } = await setup();
    const alt = await invoice("excel-import");
    await expect(invoices.pushInvoiceToAccounting(auth, alt)).rejects.toThrow(
      "Übernommene Altrechnung (Import) – sie wurde in deiner bisherigen Software bzw. Buchhaltung erfasst und wird nicht an lexoffice übertragen.",
    );
    const storno = await invoice("crm", { kind: "credit_note", cancels: alt });
    await expect(invoices.pushInvoiceToAccounting(auth, storno)).rejects.toThrow("Storno einer übernommenen Altrechnung – bitte in der Buchhaltung manuell gegen den Originalbeleg buchen.");
    // eigene Rechnung: Übertragung (Testmodus) möglich
    const own = await invoice("crm");
    await expect(invoices.pushInvoiceToAccounting(auth, own)).resolves.toMatchObject({ ok: true });
  });

  it("L1: bereits übertragene Rechnung wird nicht erneut übertragen", async () => {
    const { org, auth, invoice } = await setup();
    const own = await invoice("crm");
    await f.asOrg(org, (c) => c.query("update invoices set external_ref='lx-1', external_synced_at='2026-10-02 10:00+02' where id=$1", [own]));
    await expect(invoices.pushInvoiceToAccounting(auth, own)).rejects.toThrow("Diese Rechnung wurde bereits am 02.10.2026 an lexoffice übertragen.");
  });

  it("P1: kein Zahlungslink, keine Kartenzahlung und kein Rechnungsversand für Altbestand", async () => {
    const { auth, invoice } = await setup();
    const alt = await invoice("excel-import");
    await expect(cards.createPaymentLink(auth, alt)).rejects.toThrow(IMPORTED_INVOICE_LOCKED);
    await expect(cards.startTerminalPayment(auth, alt)).rejects.toThrow(IMPORTED_INVOICE_LOCKED);
    await expect(delivery.sendInvoiceEmail(auth, alt)).rejects.toThrow(IMPORTED_INVOICE_LOCKED);
  });

  it("Code-Review Runde 3: sendInvoiceEmail prüft die Herkunft VOR der PDF-Erzeugung (kein Archiv-PDF für Altbestand)", async () => {
    const { org, auth, invoice } = await setup();
    const alt = await invoice("excel-import");
    vi.mocked(renderInvoicePdf).mockClear();
    await expect(delivery.sendInvoiceEmail(auth, alt)).rejects.toThrow(IMPORTED_INVOICE_LOCKED);
    expect(renderInvoicePdf).not.toHaveBeenCalled();
    const n = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from document_archive where invoice_id = $1", [alt])).rows[0].n);
    expect(n).toBe(0);
  });

  it("BC: Sammelrechnung – übernommene Quittungen erscheinen in der Auswahl, gekennzeichnet als „Altbestand“", async () => {
    const { auth, patient, invoice } = await setup();
    const alt = await invoice("excel-import", { kind: "receipt", status: "paid", paidCents: 5000 });
    const own = await invoice("crm", { kind: "receipt", status: "paid", paidCents: 5000 });
    const list = await invoices.openReceiptsForPatient(auth, patient, 2026);
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(alt)?.source).toBe("excel-import");
    expect(byId.get(own)?.source).toBe("crm");
    expect(receiptMark(byId.get(alt)!)).toBe(IMPORTED_RECEIPT_MARK);
    expect(IMPORTED_RECEIPT_MARK).toBe("Altbestand");
    expect(receiptMark(byId.get(own)!)).toBeNull();
  });

  it("P1: Mahnwesen – Altbestand erscheint nicht in der Mahnliste und wird nicht gemahnt", async () => {
    const { auth, invoice } = await setup();
    const alt = await invoice("excel-import");
    const own = await invoice("crm");
    const list = await dunning.dunningOverview(auth);
    const ids = JSON.stringify(list);
    expect(ids).toContain(own);
    expect(ids).not.toContain(alt);
    const r = await dunning.createDunnings(auth, [alt]);
    expect(r.created).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ reason: IMPORTED_NOT_DUNNABLE });
  });

  it("P1: Portal zeigt nur eigene offene Rechnungen, kein PDF des Altbestands", async () => {
    const { org, patient, invoice } = await setup();
    const alt = await invoice("excel-import");
    const own = await invoice("crm");
    const token = newPortalToken();
    await f.pool.query("insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at) values ($1,$2,'portal',$3,$4)", [org, patient, hashPortalToken(token), new Date(Date.now() + 86400_000)]);
    const l = (await portal.resolvePortalLink(token))!;
    const view = await portal.loadPortalView(l);
    expect(view?.invoices.map((i) => i.id)).toEqual([own]);
    expect(await portal.portalInvoicePdf(l, alt)).toBeNull();
  });

  it("F1: Auswertung weist den übernommenen Anteil an Umsatz und offenen Forderungen getrennt aus", async () => {
    const { org, user, auth, invoice } = await setup();
    const year = 2026;
    const alt = await invoice("excel-import", { status: "partially_paid", paidCents: 2000 });
    await f.asOrg(org, (c) =>
      c.query("insert into payments (organization_id, invoice_id, method, amount_cents, paid_at, external_ref, created_by) values ($1,$2,'cash',2000,'2026-09-01 12:00+02','excel:ALT',$3)", [org, alt, user]),
    );
    const own = await invoice("crm");
    await f.asOrg(org, (c) => c.query("insert into payments (organization_id, invoice_id, method, amount_cents, paid_at, created_by) values ($1,$2,'card',1000,'2026-09-02 12:00+02',$3)", [org, own, user]));
    const d = await finance.financeOverview(auth, year);
    expect(d.revenueYear).toBe(3000);
    expect(d.revenueImportedYear).toBe(2000);
    expect(d.receivables).toMatchObject({ openCents: 3000 + 5000, importedCents: 3000 });
  });
});
