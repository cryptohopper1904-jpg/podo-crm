/**
 * DIN-A4-Paginierung der Briefe (Rechnung/Quittung/Sammelrechnung, Mahnung).
 * Gezeichnete Texte werden über PDFPage.drawText mitgeschnitten (Seite, Position, Text). Die Snapshots
 * „Belegtext“ halten den Inhalt fest (GoBD: Layout/Umbruch darf sich ändern, Texte und Beträge nicht).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { renderDunningPdf, type DunningPdfData } from "./dunning-pdf";

type Drawn = { page: number; x: number; y: number; size: number; text: string };
let drawn: Drawn[] = [];

beforeEach(() => {
  drawn = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
    drawn.push({ page: this.doc.getPages().indexOf(this), x: options?.x ?? 0, y: options?.y ?? 0, size: Number(options?.size ?? 0), text });
    return orig.call(this, text, options);
  });
});
afterEach(() => vi.restoreAllMocks());

const FOOTER_TOP = 125;
/** Praxisname im Kopf der Folgeseiten */
const RUNNING_HEAD_NAME = "Praxis Fußwohl";
const PAGE_MARK = /Seite \d+ von \d+$/;
/** Belegtext ohne Fuß-/Kopfzeilen und Seitenangaben, in Zeichenreihenfolge */
const bodyTexts = (d: Drawn[]) => {
  const seen = new Set<string>();
  return d
    .filter((t) => t.y >= FOOTER_TOP && !PAGE_MARK.test(t.text) && !(t.page > 0 && t.y >= 805 && t.text === RUNNING_HEAD_NAME))
    .map((t) => t.text)
    .filter((t) => {
      // auf Folgeseiten wiederholte Tabellenköpfe zählen nicht zum Belegtext
      if (!TABLE_HEAD.has(t)) return true;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
};
const TABLE_HEAD = new Set(["Pos", "Anzahl", "Leistung / Heilmittel", "Faktor", "Einzelpreis", "USt", "Summe", "Nummer", "Datum", "Betrag", "darin USt"]);
/** Fußzeilentexte (je Seite gleich) ohne Seitenangabe */
const footerTexts = (d: Drawn[]) => [...new Set(d.filter((t) => t.y < FOOTER_TOP && !PAGE_MARK.test(t.text)).map((t) => t.text))].sort();
const pagesOf = (d: Drawn[], text: string | RegExp) => [...new Set(d.filter((t) => (typeof text === "string" ? t.text === text : text.test(t.text))).map((t) => t.page))];

const ORG: InvoicePdfData["organization"] = {
  name: "Praxis Fußwohl",
  legalName: "Fußwohl Podologie GmbH",
  street: "Musterweg 1",
  zip: "14467",
  city: "Potsdam",
  phone: "0331 123456",
  email: "info@example.org",
  taxNumber: "046/123/45678",
  vatId: null,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Beispielbank",
  smallBusiness: false,
  website: "https://www.example.org",
  qualification: "staatlich anerkannte Podologin",
};

const line = (i: number, vatRate = 0) => ({
  description: `${String((i % 28) + 1).padStart(2, "0")}.10.2026: Podologische Komplexbehandlung${i % 4 === 0 ? " inkl. Nagelkorrekturspange nach Ross Fraser, Nachkontrolle und Pflegeberatung" : ""}`,
  quantity: "1",
  factor: "1",
  unitPriceCents: 4500 + (i % 3) * 500,
  vatRate,
  totalCents: 4500 + (i % 3) * 500,
});

const invoice = (n: number, patch: Partial<InvoicePdfData> = {}): InvoicePdfData => {
  const lines = Array.from({ length: n }, (_, i) => line(i, i % 5 === 0 ? 19 : 0));
  const total = lines.reduce((s, l) => s + l.totalCents, 0);
  return {
    invoice: { id: "00000000-0000-4000-8000-000000000001", number: "R2026-0042", kind: "invoice", status: "issued", issuedAt: "2026-11-02", dueAt: "2026-11-16", totalCents: total, paidCents: 0, notes: "Behandlungszeitraum Oktober" },
    lines,
    payments: [],
    organization: ORG,
    patient: { number: 17, salutation: "Frau", firstName: "Erika", lastName: "Mustermann", street: "Beispielstraße 5", zip: "14469", city: "Potsdam" },
    billingContact: null,
    serviceDates: ["2026-10-01"],
    booking: { label: "Nächsten Termin online buchen:", url: "https://app.example.org/buchen/x", display: "app.example.org/buchen/x" },
    ...patch,
  };
};

const collectiveWithReceipts = (n: number): InvoicePdfData => {
  const credited = Array.from({ length: n }, (_, i) => ({ kind: "receipt", number: `Q2026-${String(i + 1).padStart(4, "0")}`, issuedAt: `2026-${String((i % 12) + 1).padStart(2, "0")}-05`, totalCents: 4500, netCents: 4500, vatCents: 0 }));
  const lines = credited.map((c) => ({ description: `${c.issuedAt}: Podologische Komplexbehandlung`, quantity: "1", factor: "1", unitPriceCents: 4500, vatRate: 0, totalCents: 4500 }));
  const total = n * 4500;
  const base = invoice(0);
  return {
    ...base,
    invoice: { ...base.invoice, number: "SR2026-0007", kind: "collective", status: "paid", totalCents: total, paidCents: total },
    lines,
    credited,
    billingContact: { name: "Seniorenresidenz Am See", street: "Seeweg 2", zip: "14469", city: "Potsdam" },
  };
};

const dunning = (body: string): DunningPdfData => ({
  dunning: { id: "d1", stage: "dunning1", letterDate: "2026-11-30", payBy: "2026-12-10", openCents: 4500, feesTotalCents: 250, body, fees: [{ stage: "reminder", feeCents: 0 }, { stage: "dunning1", feeCents: 250 }] },
  invoice: { number: "R2026-0042", issuedAt: "2026-10-20", dueAt: "2026-11-03", totalCents: 6500 },
  organization: ORG,
  patient: { number: 17, salutation: "Frau", firstName: "Erika", lastName: "Muster", street: "Beispielstraße 5", zip: "14469", city: "Potsdam" },
  billingContact: null,
});
const LONG_BODY = Array.from(
  { length: 14 },
  (_, i) => `Absatz ${i + 1}: Leider konnten wir bis heute keinen Zahlungseingang zu der oben genannten Rechnung feststellen. Bitte prüfen Sie Ihre Unterlagen und überweisen Sie den offenen Betrag fristgerecht.`,
).join("\n\n");

/** Seitenzahl; jede Seite muss DIN A4 sein (595,28 × 841,89 pt) */
async function pages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  for (const pg of doc.getPages()) {
    const { width, height } = pg.getSize();
    expect(width).toBeCloseTo(595.28, 2);
    expect(height).toBeCloseTo(841.89, 2);
  }
  return doc.getPageCount();
}

/** Seitenangaben: unten rechts auf jeder Seite, auf Folgeseiten zusätzlich im Kopf; bei einer Seite keine. */
function expectPageNumbers(count: number, head: string) {
  if (count === 1) {
    expect(drawn.some((t) => PAGE_MARK.test(t.text))).toBe(false);
    return;
  }
  for (let i = 0; i < count; i++) {
    const marks = drawn.filter((t) => t.page === i && PAGE_MARK.test(t.text)).map((t) => t.text);
    expect(marks).toContain(`Seite ${i + 1} von ${count}`);
    if (i > 0) expect(marks).toContain(`${head} – Seite ${i + 1} von ${count}`);
  }
}

/** Nichts ragt in die Fußzeile oder über den oberen Rand; Fußzeile auf jeder Seite */
function expectInsideBody(count: number) {
  for (const t of drawn) expect(t.y, t.text).toBeLessThan(841.89 - 20);
  for (const t of drawn.filter((d) => !PAGE_MARK.test(d.text) && d.y >= FOOTER_TOP)) expect(t.y - t.size * 0.25, t.text).toBeGreaterThanOrEqual(FOOTER_TOP);
  for (let i = 0; i < count; i++) expect(drawn.some((t) => t.page === i && t.text === "staatlich anerkannte Podologin"), `Fußzeile Seite ${i + 1}`).toBe(true);
}

describe("Rechnung: DIN A4 und Seitenumbruch", () => {
  it("1 Position → 1 Seite A4, keine Seitenangabe", async () => {
    const n = await pages(await renderInvoicePdf(invoice(1)));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(footerTexts(drawn)).toMatchSnapshot("Fußzeile");
    expect(n).toBe(1);
    expectPageNumbers(n, "Rechnung Nr. R2026-0042");
    expectInsideBody(n);
  });

  it("40 Positionen → mehrere Seiten, Seitenangaben, Tabellenkopf je Seite, Summenblock zusammen", async () => {
    const n = await pages(await renderInvoicePdf(invoice(40)));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(footerTexts(drawn)).toMatchSnapshot("Fußzeile");
    expect(n).toBeGreaterThan(1);
    expectPageNumbers(n, "Rechnung Nr. R2026-0042");
    expectInsideBody(n);
    // Tabellenkopf auf jeder Seite mit Positionen
    for (const pg of pagesOf(drawn, /^\d{2}\.10\.2026: /)) expect(pagesOf(drawn, "Leistung / Heilmittel")).toContain(pg);
    // Summenblock (Netto/USt/Gesamt) vollständig auf einer Seite
    expect(new Set([...pagesOf(drawn, /^(Netto|USt) \d+ %$/), ...pagesOf(drawn, "Gesamt")]).size).toBe(1);
  });

  it("Sammelrechnung mit 15 angerechneten Quittungen: Block „Bereits bezahlt“ mit Summe zusammen", async () => {
    const n = await pages(await renderInvoicePdf(collectiveWithReceipts(15)));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expectPageNumbers(n, "Sammelrechnung Nr. SR2026-0007");
    expectInsideBody(n);
    const block = new Set([...pagesOf(drawn, "Bereits bezahlt (Quittungen)"), ...pagesOf(drawn, /^Q2026-\d{4}$/), ...pagesOf(drawn, "Summe (15 Quittungen)"), ...pagesOf(drawn, "Offener Restbetrag")]);
    expect(block.size).toBe(1);
  });

  it("75 Positionen → 4 Seiten, Seitenangaben 1–4", async () => {
    const n = await pages(await renderInvoicePdf(invoice(75)));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBe(4);
    expectPageNumbers(n, "Rechnung Nr. R2026-0042");
    expectInsideBody(n);
  });
});

describe("Mahnung: DIN A4 und Seitenumbruch", () => {
  it("kurzer Text → 1 Seite ohne Seitenangabe", async () => {
    const n = await pages(await renderDunningPdf(dunning("Sehr geehrte Frau Muster,\n\nbitte zahlen Sie den offenen Betrag.")));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBe(1);
    expectPageNumbers(n, "1. Mahnung zur Rechnung R2026-0042");
    expectInsideBody(n);
  });

  it("langer Text → mehrere Seiten, Aufstellung zusammen, Seitenangaben", async () => {
    const n = await pages(await renderDunningPdf(dunning(LONG_BODY)));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBeGreaterThan(1);
    expectPageNumbers(n, "1. Mahnung zur Rechnung R2026-0042");
    expectInsideBody(n);
    expect(new Set([...pagesOf(drawn, /^Rechnungsbetrag /), ...pagesOf(drawn, "zu zahlen")]).size).toBe(1);
  });
});
