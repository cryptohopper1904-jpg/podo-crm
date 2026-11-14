/**
 * DIN-A4-Paginierung der Briefe (Rechnung/Quittung/Sammelrechnung, Mahnung).
 * Gezeichnete Texte werden über PDFPage.drawText mitgeschnitten (Seite, Position, Text). Die Snapshots
 * „Belegtext“ halten den Inhalt fest (GoBD: Layout/Umbruch darf sich ändern, Texte und Beträge nicht).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage } from "pdf-lib";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { renderDunningPdf, type DunningPdfData } from "./dunning-pdf";
import { renderPaymentReceiptPdf } from "./payment-receipt";
import { embedFonts, makeSafe, makeWriter } from "./pdf-letter";

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
    invoice: { id: "00000000-0000-4000-8000-000000000001", number: "R2026-0042", kind: "invoice", status: "issued", issuedAt: "2026-11-02", dueAt: "2026-11-16", totalCents: total, paidCents: 0, createdAt: null, notes: "Behandlungszeitraum Oktober" },
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

describe("Rechnung: Belegtext weiterer Belegarten", () => {
  it("Stornorechnung (credit_note): Belegtext unverändert", async () => {
    const base = invoice(3);
    const n = await pages(
      await renderInvoicePdf({
        ...base,
        invoice: { ...base.invoice, number: "S2026-0003", kind: "credit_note", status: "issued", totalCents: -base.invoice.totalCents },
        lines: base.lines.map((l) => ({ ...l, unitPriceCents: -l.unitPriceCents, totalCents: -l.totalCents })),
        cancels: { number: "R2026-0042", kind: "invoice", issuedAt: "2026-11-02" },
      }),
    );
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBe(1);
  });

  it("Kleinunternehmer (§ 19 UStG): Belegtext unverändert", async () => {
    const base = invoice(3);
    const n = await pages(await renderInvoicePdf({ ...base, organization: { ...ORG, smallBusiness: true }, lines: base.lines.map((l) => ({ ...l, vatRate: 0 })) }));
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBe(1);
  });
});

describe("Belegtext: TSE-Angaben, Storno-Neudruck, Reproduktion, Zahlungsbeleg (Beleg-Archiv/KassenSichV)", () => {
  const FISCAL = {
    vendor: "mock",
    tssSerial: "TEST-TSS-0001",
    txNumber: 4711,
    signatureCounter: 9001,
    signature: "TEST-c2lnbmF0dXJlLWJhc2U2NC1hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=",
    startedAt: "2026-11-02T09:15:01Z",
    finishedAt: "2026-11-02T09:15:03Z",
    processType: "Kassenbeleg-V1",
    isTest: true,
  };

  it("Quittung bar beim Ausstellen: TSE-Angaben (§ 6 KassenSichV) mit Testmodus-Hinweis", async () => {
    const base = invoice(1);
    const total = base.invoice.totalCents;
    const n = await pages(
      await renderInvoicePdf({
        ...base,
        invoice: { ...base.invoice, number: "Q2026-0005", kind: "receipt", status: "paid", dueAt: "2026-11-02", paidCents: total },
        payments: [{ paidAt: "2026-11-02T09:15:03Z", method: "cash", amountCents: total, fiscal: FISCAL }],
      }),
    );
    expect(bodyTexts(drawn)).toMatchSnapshot("Belegtext");
    expect(n).toBe(1);
    expect(drawn.some((t) => t.text === "TSE-Transaktionsnummer")).toBe(true);
    expect(drawn.some((t) => t.text.startsWith("TESTMODUS"))).toBe(true);
    expectInsideBody(n);
  });

  it("Neudruck einer stornierten Rechnung: wie ausgestellt, Stornovermerk, ohne GiroCode", async () => {
    const base = invoice(3);
    const n = await pages(
      await renderInvoicePdf({ ...base, invoice: { ...base.invoice, status: "cancelled" }, cancellation: { number: "GS2026-0002", issuedAt: "2026-11-10" } }),
    );
    const body = bodyTexts(drawn);
    expect(body).toMatchSnapshot("Belegtext");
    expect(body).toContain("STORNIERT durch Stornorechnung Nr. GS2026-0002 vom 10.11.2026");
    expect(body).not.toContain("Bezahlen per GiroCode");
    // Zahlungsaufforderung wie ausgestellt (nicht „storniert“-Text) – der Vermerk macht den Beleg ungültig
    expect(body.join(" ")).toMatch(/Bitte überweisen Sie den Betrag bis zum 16\.11\.2026/);
    expect(n).toBe(1);
    expectInsideBody(n);
  });

  it("Altbeleg ohne Archiv: Reproduktion mit Fußnote", async () => {
    const n = await pages(await renderInvoicePdf({ ...invoice(1), reproduction: { generatedAt: "2026-11-14T10:00:00Z" } }));
    const body = bodyTexts(drawn);
    expect(body).toMatchSnapshot("Belegtext");
    expect(body.join(" ")).toContain("Reproduktion: Dieser Beleg wurde am 14.11.2026, 11:00 aus den gespeicherten Belegdaten neu erzeugt.");
    expect(n).toBe(1);
    expectInsideBody(n);
  });

  it("Zahlungsbeleg (späterer Zahlungseingang): Verweis auf die Rechnung, kein USt-Ausweis, TSE-Angaben", async () => {
    const n = await pages(
      await renderPaymentReceiptPdf({
        number: "ZB2026-0001",
        issuedAt: "2026-11-14T10:00:05Z",
        data: {
          v: 1,
          organization: { ...ORG, bic: ORG.bic ?? null, bankName: ORG.bankName ?? null, accountHolder: null, website: ORG.website ?? null, qualification: ORG.qualification ?? null, whatsapp: false },
          recipient: { name: "Frau Erika Mustermann", patientNumber: 17 },
          invoice: { id: "00000000-0000-4000-8000-000000000001", number: "R2026-0042", kind: "invoice", issuedAt: "2026-11-02", totalCents: 6500 },
          payment: { id: "p1", paidAt: "2026-11-14T10:00:03Z", method: "cash", amountCents: 6500, voucherCode: null },
          openAfterCents: 0,
          fiscal: { ...FISCAL, startedAt: "2026-11-14T10:00:01Z", finishedAt: "2026-11-14T10:00:03Z" },
          tseFailed: false,
        },
      }),
    );
    const body = bodyTexts(drawn);
    expect(body).toMatchSnapshot("Belegtext");
    expect(body).toContain("Beleg über Zahlungseingang zu Rechnung Nr. R2026-0042 vom 02.11.2026");
    expect(body.join(" ")).not.toMatch(/USt \d+ %|Netto/);
    expect(n).toBe(1);
  });
});

describe("Übergroße Blöcke: kein Textverlust", () => {
  const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  const allDrawnWords = () => new Set(drawn.flatMap((t) => t.text.split(/\s+/)));

  it("Position mit 400 Wörtern und Hinweis mit 90 Zeilen: alle Wörter im PDF, nichts in der Fußzeile", async () => {
    const posWords = words("Pw", 400);
    const noteLines = words("Hz", 90).map((w) => `Hinweiszeile ${w}`);
    const base = invoice(2);
    const n = await pages(
      await renderInvoicePdf({
        ...base,
        lines: [{ ...base.lines[0], description: posWords.join(" ") }, base.lines[1]],
        invoice: { ...base.invoice, notes: noteLines.join("\n") },
      }),
    );
    expect(n).toBeGreaterThan(1);
    const seen = allDrawnWords();
    for (const w of [...posWords, ...noteLines.map((l) => l.split(" ")[1])]) expect(seen.has(w), w).toBe(true);
    expectPageNumbers(n, "Rechnung Nr. R2026-0042");
    expectInsideBody(n);
    // Positionswerte nur einmal, Tabellenkopf auf jeder Seite mit Beschreibungsteilen
    for (const pg of pagesOf(drawn, /^Pw\d+/)) expect(pagesOf(drawn, "Leistung / Heilmittel")).toContain(pg);
  });

  it("Entwurf ohne Nummer: Kopfzeile „Rechnung – Entwurf“", async () => {
    const base = invoice(40);
    const n = await pages(await renderInvoicePdf({ ...base, invoice: { ...base.invoice, number: null, status: "draft" } }));
    expect(n).toBeGreaterThan(1);
    expectPageNumbers(n, "Rechnung – Entwurf");
  });

  it("Mahnung: Text über mehrere Seiten vollständig, nichts in der Fußzeile", async () => {
    const body = words("Mw", 1500).join(" ");
    const n = await pages(await renderDunningPdf(dunning(body)));
    expect(n).toBeGreaterThan(1);
    const seen = allDrawnWords();
    for (const w of words("Mw", 1500)) expect(seen.has(w), w).toBe(true);
    expectInsideBody(n);
  });
});

describe("Lange Wörter ohne Leerzeichen", () => {
  const LETTERS = "abcdefghij";
  const longWord = (n: number) => LETTERS.repeat(Math.ceil(n / LETTERS.length)).slice(0, n);
  /** Median der Laufzeit (ms) über mehrere Läufe, robust gegen Ausreißer auf ausgelasteten Rechnern */
  async function medianMs(fn: () => unknown | Promise<unknown>, runs = 5) {
    const ms: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      await fn();
      ms.push(performance.now() - t);
    }
    return ms.sort((a, b) => a - b)[Math.floor(runs / 2)];
  }

  it("300 Zeichen am Stück erscheinen vollständig im PDF", async () => {
    const word = longWord(300);
    const base = invoice(1);
    await pages(await renderInvoicePdf({ ...base, lines: [{ ...base.lines[0], description: word }] }));
    expect(drawn.filter((t) => /^[a-j]+$/.test(t.text)).map((t) => t.text).join("")).toBe(word);
    expectInsideBody(1);
  });

  it("clip: mehrzeilige Werte (\\n, \\r, \\t) werden einzeilig, Fußzeile bricht die PDF-Erzeugung nicht ab", async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedFonts(doc);
    const w = makeWriter(() => doc.addPage(), fonts, makeSafe(fonts.regular));
    expect(w.clip("Bank\nZweite Zeile\r\nDritte\tZeile", 1000, 7)).toBe("Bank Zweite Zeile Dritte Zeile");
    expect(w.clip("Sehr lange Bank\nmit Zeilenumbruch und noch mehr Text dahinter", 60, 7).endsWith("…")).toBe(true);
    const base = invoice(40);
    const n = await pages(await renderInvoicePdf({ ...base, organization: { ...ORG, bankName: "Beispielbank\nFiliale Potsdam", legalName: "Fußwohl\r\nPodologie GmbH", accountHolder: "Erika\tMusterfrau" } }));
    expect(n).toBeGreaterThan(1);
    expect(drawn.some((t) => t.text === "Beispielbank Filiale Potsdam")).toBe(true);
  });

  it("harter Umbruch ist nicht quadratisch: 10.000 Zeichen am Stück < 200 ms (Median)", async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedFonts(doc);
    const w = makeWriter(() => doc.addPage(), fonts, makeSafe(fonts.regular));
    const word = longWord(10_000);
    let lines: string[] = [];
    const ms = await medianMs(() => (lines = w.wrap(word, 300, 8.5)));
    expect(lines.join("")).toBe(word);
    for (const l of lines) expect(fonts.regular.widthOfTextAtSize(l, 8.5)).toBeLessThanOrEqual(300);
    expect(ms).toBeLessThan(200);
    // clip ebenfalls ohne Schleife über jedes Zeichen
    expect(await medianMs(() => w.clip(word, 200, 7))).toBeLessThan(200);
    expect(w.clip(word, 200, 7).endsWith("…")).toBe(true);
  });

  it("Position mit 6000 und Hinweis mit 3000 Zeichen am Stück: Rechnung in vertretbarer Zeit", async () => {
    const base = invoice(1);
    const data = { ...base, lines: [{ ...base.lines[0], description: longWord(6000) }], invoice: { ...base.invoice, notes: longWord(3000) } };
    const ms = await medianMs(() => renderInvoicePdf(data), 3);
    expect(ms).toBeLessThan(3000);
    // fortgesetzte Position: Pos-Nummer und darunter „(Forts.)“ in 7 pt auf jeder Folgeseite mit Beschreibungsteilen
    const cont = drawn.filter((t) => t.text === "(Forts.)");
    expect(cont.length).toBeGreaterThan(0);
    for (const c of cont) {
      expect(c.size).toBe(7);
      expect(drawn.some((t) => t.page === c.page && t.text === "1" && Math.abs(t.y - (c.y + 9)) < 0.01)).toBe(true);
    }
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
