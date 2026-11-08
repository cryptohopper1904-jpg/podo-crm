import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";

const data = (patch: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  invoice: { id: "00000000-0000-4000-8000-000000000001", number: "R2026-0042", kind: "invoice", status: "issued", issuedAt: "2026-11-02", dueAt: "2026-11-16", totalCents: 9450, paidCents: 0, notes: "Behandlungszeitraum November\n[intern] USt-Wächter bestätigt" },
  lines: [
    { description: "Podologische Komplexbehandlung", quantity: "1", factor: "1", unitPriceCents: 6500, vatRate: 0, totalCents: 6500 },
    { description: "Pflegecreme „Fußwohl“ – 75 ml", quantity: "1", factor: "1", unitPriceCents: 2950, vatRate: 19, totalCents: 2950 },
  ],
  payments: [],
  organization: { name: "Praxis Fußwohl", legalName: "Fußwohl Podologie GmbH", street: "Musterweg 1", zip: "14467", city: "Potsdam", phone: "0331 123456", email: "info@example.org", taxNumber: "046/123/45678", vatId: null, iban: "DE02120300000000202051", smallBusiness: false },
  patient: { number: 17, salutation: "Frau", firstName: "Erika", lastName: "Mustermann", street: "Beispielstraße 5", zip: "14469", city: "Potsdam" },
  billingContact: null,
  ...patch,
});

describe("PDF-Rechnung", () => {
  it("erzeugt ein gültiges PDF mit Kopf %PDF-", async () => {
    const bytes = await renderInvoicePdf(data());
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Rechnung R2026-0042");
  });

  it("bricht bei vielen Positionen auf weitere Seiten um und ersetzt nicht darstellbare Zeichen", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      description: `Mustermann, Erika, 0${(i % 9) + 1}.11.2026: Behandlung ✓ 🦶 ${"sehr lange Beschreibung ".repeat(i % 3)}`,
      quantity: "1",
      factor: "1",
      unitPriceCents: 4000,
      vatRate: 0,
      totalCents: 4000,
    }));
    const bytes = await renderInvoicePdf(
      data({
        lines,
        invoice: { ...data().invoice, kind: "collective", totalCents: 240000 },
        billingContact: { name: "Seniorenresidenz Am See", street: "Seeweg 2", zip: "14469", city: "Potsdam" },
        payments: [{ paidAt: "2026-11-03T10:00:00Z", method: "card", amountCents: 1000 }],
      }),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});
