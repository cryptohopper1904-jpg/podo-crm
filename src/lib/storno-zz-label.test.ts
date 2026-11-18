/**
 * Storno einer Zuzahlungsquittung ist keine „Stornorechnung“: Bezeichnung in PDF-Titel, Stornovermerk, Fußzeile,
 * Zahlungsbelegen und lexoffice-Bemerkung. Normale Rechnungen bleiben unverändert. Erfundene Daten.
 */
import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { accountingRemark, invoiceDocLabel } from "./invoice-labels";
import { invoiceTitle } from "./invoice-view";
import { cancellationStamp, renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { paymentReceiptEmail, paymentReceiptTitle, paymentReceiptVatNote, type PaymentReceiptSnapshot } from "./payment-receipt";

const ORG = { name: "Praxis Fußwohl", legalName: null, street: "Musterweg 1", zip: "14467", city: "Potsdam", phone: null, email: null, taxNumber: "046/123/45678", vatId: null, iban: null, smallBusiness: false };

const storno = (cancelsKind: string): InvoicePdfData => ({
  invoice: { id: "00000000-0000-4000-8000-000000000002", number: "ST2026-0003", kind: "credit_note", status: "issued", issuedAt: "2026-11-05", dueAt: null, totalCents: -1000, paidCents: 0, createdAt: null, notes: null, serviceDateFixed: true },
  lines: [{ description: "Zuzahlung je Verordnung (Verordnungsblattgebühr)", quantity: "1", factor: "1", unitPriceCents: -1000, vatRate: 0, totalCents: -1000 }],
  payments: [],
  organization: ORG,
  patient: { number: 17, firstName: "Erika", lastName: "Mustermann" },
  billingContact: null,
  cancels: { number: cancelsKind === "copayment" ? "ZZ2026-0001" : "R2026-0001", kind: cancelsKind, issuedAt: "2026-11-01" },
});

async function drawnTexts(input: InvoicePdfData) {
  const { PDFPage } = await import("pdf-lib");
  const texts: string[] = [];
  const spy = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: unknown, t: string) {
    texts.push(t);
  });
  try {
    const bytes = await renderInvoicePdf(input);
    return { texts, title: (await PDFDocument.load(bytes, { updateMetadata: false })).getTitle() };
  } finally {
    spy.mockRestore();
  }
}

describe("Storno Zuzahlungsquittung – Bezeichnungen", () => {
  it("1. PDF-Metadaten-Titel (invoiceTitle)", async () => {
    expect(invoiceTitle({ kind: "credit_note", number: "ST2026-0003" }, "copayment")).toBe("Storno Zuzahlungsquittung ST2026-0003");
    expect(invoiceTitle({ kind: "credit_note", number: "ST2026-0003" }, "invoice")).toBe("Stornorechnung ST2026-0003");
    expect(invoiceTitle({ kind: "credit_note", number: "ST2026-0003" })).toBe("Stornorechnung ST2026-0003");
    expect(invoiceTitle({ kind: "copayment", number: "ZZ2026-0001" })).toBe("Zuzahlungsquittung ZZ2026-0001");
    expect((await drawnTexts(storno("copayment"))).title).toBe("Storno Zuzahlungsquittung ST2026-0003");
    expect((await drawnTexts(storno("invoice"))).title).toBe("Stornorechnung ST2026-0003");
  });

  it("PDF: Überschrift und Kopfzeile der Folgeseiten nennen „Storno Zuzahlungsquittung“, nie „Stornorechnung“", async () => {
    // viele Positionen → Folgeseite mit Kopfzeile („<Belegart> Nr. … – Seite 2 von N“)
    const long = (k: string): InvoicePdfData => {
      const d = storno(k);
      return { ...d, lines: Array.from({ length: 45 }, () => d.lines[0]) };
    };
    const zz = (await drawnTexts(long("copayment"))).texts.join(" ");
    expect(zz).toMatch(/Storno zur Zuzahlungsquittung ZZ2026-0001/);
    expect(zz).toMatch(/Storno Zuzahlungsquittung Nr\. ST2026-0003 – Seite 2 von/);
    expect(zz).not.toMatch(/Stornorechnung/);
    expect((await drawnTexts(long("invoice"))).texts.join(" ")).toMatch(/Stornorechnung Nr\. ST2026-0003 – Seite 2 von/);
  });

  it("2. Vermerk beim Neudruck des stornierten Originals", async () => {
    const c = { number: "ST2026-0003", issuedAt: "2026-11-05" };
    expect(cancellationStamp(c, "copayment")).toBe("STORNIERT durch Storno Nr. ST2026-0003 vom 05.11.2026");
    expect(cancellationStamp(c, "invoice")).toBe("STORNIERT durch Stornorechnung Nr. ST2026-0003 vom 05.11.2026");
    expect(cancellationStamp(c)).toBe("STORNIERT durch Stornorechnung Nr. ST2026-0003 vom 05.11.2026");
    const original: InvoicePdfData = {
      ...storno("copayment"),
      invoice: { id: "00000000-0000-4000-8000-000000000001", number: "ZZ2026-0001", kind: "copayment", status: "cancelled", issuedAt: "2026-11-01", dueAt: null, totalCents: 1000, paidCents: 1000, createdAt: null, notes: null },
      lines: [{ description: "Zuzahlung je Verordnung (Verordnungsblattgebühr)", quantity: "1", factor: "1", unitPriceCents: 1000, vatRate: 0, totalCents: 1000 }],
      cancels: null,
      cancellation: c,
    };
    const all = (await drawnTexts(original)).texts.join(" ");
    expect(all).toMatch(/STORNIERT durch Storno Nr\. ST2026-0003 vom 05\.11\.2026/);
    expect(all).not.toMatch(/Stornorechnung/);
  });

  it("3. Patientenportal: Bezeichnung über invoiceDocLabel mit Originalart", () => {
    expect(invoiceDocLabel("credit_note", "copayment")).toBe("Storno Zuzahlungsquittung");
    expect(invoiceDocLabel("credit_note", null)).toBe("Stornorechnung");
    expect(invoiceDocLabel("receipt", null)).toBe("Quittung");
  });

  it("4. Zahlungsbeleg: Titel und USt-Hinweis zur Storno Zuzahlungsquittung", () => {
    const d = (cancelsKind?: string | null): Pick<PaymentReceiptSnapshot, "payment" | "invoice" | "organization"> => ({
      invoice: { id: "i", number: "ST2026-0003", kind: "credit_note", issuedAt: "2026-11-05", totalCents: -1000, ...(cancelsKind !== undefined ? { cancelsKind } : {}) },
      payment: { id: "p", paidAt: "2026-11-05T10:00:00Z", method: "cash", amountCents: -1000, voucherCode: null },
      organization: { ...ORG, smallBusiness: false } as never,
    });
    expect(paymentReceiptTitle(d("copayment"))).toBe("Beleg über Auszahlung (Erstattung) zu Storno Zuzahlungsquittung Nr. ST2026-0003 vom 05.11.2026");
    expect(paymentReceiptVatNote(d("copayment"))).toMatch(/in der Storno Zuzahlungsquittung Nr\. ST2026-0003 ausgewiesen/);
    // ältere Belege ohne festgeschriebene Originalart bzw. normale Stornos: unverändert
    expect(paymentReceiptTitle(d())).toBe("Beleg über Auszahlung (Erstattung) zu Stornorechnung Nr. ST2026-0003 vom 05.11.2026");
    expect(paymentReceiptTitle(d("invoice"))).toBe("Beleg über Auszahlung (Erstattung) zu Stornorechnung Nr. ST2026-0003 vom 05.11.2026");
    // Begleit-E-Mail: festgeschriebene Originalart, sonst nachgeladene (ältere Zahlungsbelege)
    const mail = paymentReceiptEmail(d("copayment"), "ZB2026-0009");
    expect(mail.subject).toBe("Zahlungsbeleg ZB2026-0009 zu Storno Zuzahlungsquittung ST2026-0003 – Praxis Fußwohl");
    expect(mail.body).toMatch(/über Ihre Erstattung von 10,00\s€ zu Storno Zuzahlungsquittung ST2026-0003 vom 05\.11\.2026/);
    expect(paymentReceiptEmail(d(), "ZB2026-0009", "copayment").subject).toMatch(/zu Storno Zuzahlungsquittung ST2026-0003/);
    expect(paymentReceiptEmail(d(), "ZB2026-0009", null).subject).toMatch(/zu Stornorechnung ST2026-0003/);
  });

  it("5. lexoffice-Bemerkung", () => {
    expect(accountingRemark("credit_note", "ST2026-0003", "copayment")).toBe("Storno Zuzahlungsquittung ST2026-0003");
    expect(accountingRemark("credit_note", "ST2026-0004", "collective", true)).toBe("Stornorechnung ST2026-0004 (abzgl. angerechneter Quittungen)");
    expect(accountingRemark("credit_note", "ST2026-0005", null)).toBe("Stornorechnung ST2026-0005");
    expect(accountingRemark("copayment", "ZZ2026-0001", null)).toBe("Zuzahlungsquittung ZZ2026-0001");
    // bisherige Bemerkung für alle übrigen Belegarten unverändert
    expect(accountingRemark("receipt", "Q2026-0001", null)).toBe("Rechnung Q2026-0001");
    expect(accountingRemark("collective", "S2026-0001", null, true)).toBe("Rechnung S2026-0001 (abzgl. angerechneter Quittungen)");
  });
});
