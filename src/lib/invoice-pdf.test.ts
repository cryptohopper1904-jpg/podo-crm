import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";

const data = (patch: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  invoice: { id: "00000000-0000-4000-8000-000000000001", number: "R2026-0042", kind: "invoice", status: "issued", issuedAt: "2026-11-02", dueAt: "2026-11-16", totalCents: 9450, paidCents: 0, createdAt: null, notes: "Behandlungszeitraum November\n[intern] USt-Wächter bestätigt" },
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

  it("mit Logos, GiroCode, Buchungs-QR und Fußzeilenangaben (auch mehrseitig); defektes Logo bricht nichts", async () => {
    const png = readFileSync(path.join(__dirname, "../../docs/kunden/kiehne/logo-kiehne.png"));
    const full = await renderInvoicePdf(
      data({
        organization: { ...data().organization, bic: "BYLADEM1001", bankName: "Beispielbank", accountHolder: "Erika Musterfrau", website: "https://www.example.org", qualification: "staatlich anerkannte Podologin", whatsapp: true },
        logos: { full: { bytes: png, mime: "image/png" }, compact: { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" } },
        booking: { label: "Nächsten Termin online buchen:", url: "https://app.example.org/buchen/x", display: "app.example.org/buchen/x" },
        serviceDates: ["2026-11-02"],
      }),
    );
    expect((await PDFDocument.load(full)).getPageCount()).toBe(1);
    // Sammelrechnung mit angerechneten Quittungen: Abzugszeilen und Block „Bereits bezahlt (Quittungen)“
    const credited = Array.from({ length: 12 }, (_, i) => ({ kind: "receipt", number: `Q2026-${String(i + 1).padStart(4, "0")}`, issuedAt: `2026-${String(i + 1).padStart(2, "0")}-05`, totalCents: 4500, netCents: 4500, vatCents: 0 }));
    const sr = await renderInvoicePdf(
      data({
        invoice: { ...data().invoice, kind: "collective", status: "paid", totalCents: 54000, paidCents: 54000 },
        lines: credited.map((c) => ({ description: `${c.issuedAt}: Podologische Komplexbehandlung`, quantity: "1", factor: "1", unitPriceCents: 4500, vatRate: 0, totalCents: 4500 })),
        credited,
      }),
    );
    expect((await PDFDocument.load(sr)).getPageCount()).toBeGreaterThanOrEqual(1);
    for (const kind of ["receipt", "deposit", "credit_note", "no_show_fee"]) {
      const bytes = await renderInvoicePdf(data({ invoice: { ...data().invoice, kind, status: "paid", paidCents: 9450 }, payments: [{ paidAt: "2026-11-02T10:00:00Z", method: "cash", amountCents: 9450 }], logos: { compact: { bytes: png, mime: "image/png" } } }));
      expect((await PDFDocument.load(bytes)).getPageCount(), kind).toBe(1);
    }
  });
});

describe("PDF im Stand der Ausstellung", () => {
  it("spätere Zahlung (bar) und Zahlungslink ändern das PDF nicht; Zahlung beim Ausstellen bleibt", async () => {
    const created = "2026-11-02T09:00:00.000Z";
    const issued = data({ invoice: { ...data().invoice, createdAt: created }, payments: [] });
    const paidLater = data({
      invoice: { ...data().invoice, createdAt: created, status: "paid", paidCents: 9450, paymentLinkUrl: "https://pay.example/x" },
      payments: [{ paidAt: "2026-11-10T15:30:00Z", method: "cash", amountCents: 9450 }],
    });
    // Erzeugungs-/Änderungsdatum und Datei-ID des PDFs ausgenommen – der Inhalt muss byte-gleich sein
    const strip = (b: Uint8Array) => Buffer.from(b).toString("latin1").replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, "").replace(/\/ID \[[^\]]*\]/g, "");
    expect(strip(await renderInvoicePdf(paidLater))).toBe(strip(await renderInvoicePdf(issued)));
  });
});
