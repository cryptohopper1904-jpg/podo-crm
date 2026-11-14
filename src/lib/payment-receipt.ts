/**
 * Beleg über einen Zahlungseingang nach Ausstellung der Rechnung (§ 146a Abs. 2 AO, § 6 KassenSichV) – Datenmodell
 * (payment_receipts.data) und PDF. Reine Funktionen ohne Server-Importe.
 *
 * Inhalt: Praxis (Name, Anschrift, Steuernummer), eigene laufende Belegnummer („ZB…“), Datum/Uhrzeit, Betrag und
 * Zahlart, Verweis auf die Rechnung (Nummer, Datum) – KEIN neuer Umsatzsteuerausweis (die USt steht in der Rechnung;
 * ein zweiter Ausweis wäre nach § 14c UStG gefährlich) –, offener Rest nach dieser Zahlung und die TSE-Angaben
 * (Seriennummer, Transaktionsnummer, Signaturzähler, Beginn/Ende, Signatur). Testmodus und TSE-Ausfall sind deutlich
 * gekennzeichnet. Ein Beleg je Zahlung; die Angaben werden beim Erzeugen festgeschrieben.
 */
import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import { dateDe, dateTimeDe, money } from "./format";
import { INVOICE_DOC_LABEL, PAYMENT_METHOD_LABEL } from "./invoice-labels";
import type { SnapshotOrganization } from "./invoice-snapshot";
import { A4, CONTENT_WIDTH, drawAddressBlock, drawFooters, drawLogoHead, embedFonts, embedImage, FOOTER_TOP, GRAY, makeSafe, makeWriter, ML, TOP, type PdfImage } from "./pdf-letter";
import { dateTimeSecondsDe, TSE_FAILED_NOTICE, TSE_TEST_NOTICE, tseLines, type FiscalInfo } from "./tse-receipt";

export const PAYMENT_RECEIPT_VERSION = 1;

export type PaymentReceiptSnapshot = {
  v: number;
  organization: SnapshotOrganization;
  /** Empfänger:in der Rechnung (Anzeige auf dem Beleg) */
  recipient: { name: string; patientNumber: number | null } | null;
  invoice: { id: string; number: string; kind: string; issuedAt: string | null; totalCents: number };
  payment: { id: string; paidAt: string; method: string; amountCents: number; voucherCode: string | null };
  /** noch offen (positiv) bzw. zu erstatten (negativ) nach dieser Zahlung */
  openAfterCents: number;
  fiscal: (Omit<FiscalInfo, "startedAt" | "finishedAt"> & { startedAt: string; finishedAt: string }) | null;
  /** Kassenvorgang ohne Signatur (TSE-Ausfall, z. B. SumUp-Terminalzahlung bei gestörter TSE) */
  tseFailed: boolean;
};

export type PaymentReceiptPdfData = {
  number: string;
  issuedAt: Date | string;
  data: PaymentReceiptSnapshot;
  logos?: { full?: PdfImage | null; compact?: PdfImage | null };
  /** kein archiviertes Original (Ablage gescheitert): Neuerzeugung aus den festgeschriebenen Angaben, gekennzeichnet */
  reproduction?: { generatedAt: Date | string } | null;
};

export function readPaymentReceiptSnapshot(raw: unknown): PaymentReceiptSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as PaymentReceiptSnapshot;
  if (r.v !== PAYMENT_RECEIPT_VERSION || !r.organization || !r.invoice || !r.payment) return null;
  return r;
}

export const isRefund = (d: Pick<PaymentReceiptSnapshot, "payment">) => d.payment.amountCents < 0;

/** Belegtitel, z. B. „Beleg über Zahlungseingang zu Rechnung Nr. R2026-0042 vom 02.11.2026“ */
export function paymentReceiptTitle(d: Pick<PaymentReceiptSnapshot, "payment" | "invoice">): string {
  const doc = INVOICE_DOC_LABEL[d.invoice.kind] ?? "Rechnung";
  return `${isRefund(d) ? "Beleg über Auszahlung (Erstattung)" : "Beleg über Zahlungseingang"} zu ${doc} Nr. ${d.invoice.number} vom ${dateDe(d.invoice.issuedAt)}`;
}

/** Hinweis zur Umsatzsteuer (kein eigener Ausweis) */
export function paymentReceiptVatNote(d: Pick<PaymentReceiptSnapshot, "invoice" | "organization">): string {
  const doc = INVOICE_DOC_LABEL[d.invoice.kind] ?? "Rechnung";
  return d.organization.smallBusiness
    ? `Dieser Beleg bestätigt nur die Zahlung; er ist keine Rechnung. Leistung und Entgelt siehe ${doc} Nr. ${d.invoice.number}. Keine Umsatzsteuerberechnung gemäß § 19 UStG (Kleinunternehmerregelung).`
    : `Dieser Beleg bestätigt nur die Zahlung; er ist keine Rechnung. Leistung, Entgelt und Umsatzsteuer sind in der ${doc} Nr. ${d.invoice.number} ausgewiesen – hier erfolgt kein gesonderter Steuerausweis.`;
}

/** Stand nach dieser Zahlung (eine Zeile) */
export function paymentReceiptBalance(d: Pick<PaymentReceiptSnapshot, "openAfterCents">): string {
  if (d.openAfterCents === 0) return "Die Rechnung ist damit vollständig beglichen.";
  if (d.openAfterCents > 0) return `Noch offen: ${money(d.openAfterCents)}.`;
  return `Zu erstatten: ${money(-d.openAfterCents)}.`;
}

export function paymentReceiptReproductionNote(at: Date | string): string {
  return `Reproduktion: Dieser Zahlungsbeleg wurde am ${dateTimeDe(at)} aus den gespeicherten Angaben neu erzeugt (kein archiviertes Original). Maßgeblich ist der ursprünglich ausgegebene Beleg.`;
}

export function paymentReceiptFilename(number: string) {
  return `${number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}

const RED = rgb(0.75, 0.05, 0.05);

export async function renderPaymentReceiptPdf(input: PaymentReceiptPdfData): Promise<Uint8Array> {
  const { data: d } = input;
  const o = d.organization;
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const { regular, bold } = fonts;
  const safe = makeSafe(regular);
  const title = paymentReceiptTitle(d);
  doc.setTitle(safe(`${input.number} – ${title}`));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");
  const fullLogo = await embedImage(doc, input.logos?.full);
  const compactLogo = await embedImage(doc, input.logos?.compact);

  let page: PDFPage = doc.addPage(A4);
  let y = TOP;
  const writer = makeWriter(() => page, fonts, safe);
  const { text, wrap } = writer;
  const width = CONTENT_WIDTH;
  const ensure = (h: number) => {
    if (y - h < FOOTER_TOP) {
      page = doc.addPage(A4);
      y = TOP - 26;
    }
  };

  y = drawLogoHead(writer, fonts, y, { full: fullLogo, compact: compactLogo, receiptLike: true, orgName: o.name });
  const senderLine = [o.legalName ?? o.name, o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  const recipientLines = d.recipient ? [d.recipient.name] : [];
  const meta: [string, string][] = [
    ["Belegnummer:", input.number],
    ["Datum/Uhrzeit:", dateTimeDe(input.issuedAt)],
  ];
  if (d.recipient?.patientNumber) meta.push(["Patientennummer:", String(d.recipient.patientNumber)]);
  y = drawAddressBlock(writer, fonts, safe, y, { senderLine, recipientLines, meta, boldMeta: (l) => l.startsWith("Belegnummer"), org: o });

  for (const l of wrap(title, width, 12.5, bold)) {
    text(l, ML, y, { size: 12.5, font: bold });
    y -= 16;
  }
  y -= 8;

  const rows: [string, string, boolean?][] = [
    [isRefund(d) ? "Ausgezahlter Betrag" : "Erhaltener Betrag", money(Math.abs(d.payment.amountCents)), true],
    ["Zahlart", `${PAYMENT_METHOD_LABEL[d.payment.method] ?? d.payment.method}${d.payment.voucherCode ? ` ${d.payment.voucherCode}` : ""}`],
    [isRefund(d) ? "Ausgezahlt am" : "Bezahlt am", dateTimeDe(d.payment.paidAt)],
    [`${INVOICE_DOC_LABEL[d.invoice.kind] ?? "Rechnung"}`, `Nr. ${d.invoice.number} vom ${dateDe(d.invoice.issuedAt)} über ${money(d.invoice.totalCents)}`],
  ];
  for (const [k, v, strong] of rows) {
    text(k, ML, y, { size: 10, color: GRAY });
    text(v, ML + 150, y, { size: 10, font: strong ? bold : regular });
    y -= 15;
  }
  y -= 4;
  text(paymentReceiptBalance(d), ML, y, { size: 10 });
  y -= 20;
  for (const l of wrap(paymentReceiptVatNote(d), width, 9)) {
    text(l, ML, y, { size: 9, color: GRAY });
    y -= 12;
  }
  y -= 12;

  // ── TSE ──
  ensure(120);
  text("TSE-Angaben (KassenSichV)", ML, y, { size: 9.5, font: bold });
  y -= 14;
  if (d.tseFailed || !d.fiscal) {
    for (const l of wrap(TSE_FAILED_NOTICE, width, 9.5, bold)) {
      text(l, ML, y, { size: 9.5, font: bold, color: RED });
      y -= 13;
    }
  } else {
    if (d.fiscal.isTest) {
      for (const l of wrap(TSE_TEST_NOTICE, width, 9.5, bold)) {
        text(l, ML, y, { size: 9.5, font: bold, color: RED });
        y -= 13;
      }
    }
    const lines = tseLines(d.fiscal);
    for (const [k, v] of lines.slice(0, -1)) {
      text(k, ML, y, { size: 8.5, color: GRAY });
      text(v, ML + 150, y, { size: 8.5 });
      y -= 11;
    }
    const [sk, sv] = lines.at(-1)!;
    text(sk, ML, y, { size: 8.5, color: GRAY });
    for (const l of wrap(sv, width - 150, 7.5)) {
      ensure(10);
      text(l, ML + 150, y, { size: 7.5 });
      y -= 10;
    }
    y -= 2;
    text(`Erzeugt: ${dateTimeSecondsDe(input.issuedAt)}`, ML, y, { size: 7.5, color: GRAY });
    y -= 14;
  }
  if (input.reproduction) {
    y -= 8;
    for (const l of wrap(paymentReceiptReproductionNote(input.reproduction.generatedAt), width, 9, bold)) {
      ensure(12);
      text(l, ML, y, { size: 9, font: bold });
      y -= 12;
    }
  }

  drawFooters(doc, fonts, safe, o, `Zahlungsbeleg Nr. ${input.number}`);
  return doc.save();
}
