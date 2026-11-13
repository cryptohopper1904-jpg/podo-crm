/**
 * PDF-Rechnung/Quittung (pdf-lib, reine Funktion ohne Server-Importe).
 *
 * Layout nach dem Vorbild der Pilotpraxis:
 *  - Logo zentriert oben (vollständiges Logo; Quittungen: Zeichen dezent oben rechts), ohne Logo der Praxisname
 *  - kleine Absenderzeile über der Empfängeranschrift, rechts ein Kasten mit Rechnungsnummer, -datum,
 *    Patientennummer, ggf. „Zahlbar bis“ und dem Block „Terminvereinbarung“ (Telefon/WhatsApp, E-Mail)
 *  - Überschrift „Rechnung zur Behandlung am …“, Tabelle Pos | Anzahl | Leistung/Heilmittel | Faktor | Einzelpreis | (USt) | Summe
 *  - Summen/Zahlungen, Pflichthinweise (§ 19 / § 4 Nr. 14 / § 615), Zahlungshinweis nach Zahlart und Stand
 *  - GiroCode (EPC-QR) nur bei offenem Betrag per Überweisung, QR-Code „Nächsten Termin online buchen“
 *  - Fußzeile je Seite: Praxis/Anschrift links, Bankverbindung/Steuernummer rechts, Telefon/Website mittig,
 *    darunter die Berufsbezeichnung
 *
 * Schrift: Helvetica (Standardschrift, WinAnsi). Nicht darstellbare Zeichen werden ersetzt.
 */
import { PDFDocument, type PDFPage } from "pdf-lib";
import { invoicePaymentQr, isValidIban } from "./epc-qr";
import { dateDe, dateTimeDe, money } from "./format";
import { computeTotals } from "./invoice-math";
import { NOTE_DEPOSIT, NOTE_NO_SHOW, NOTE_SMALL_BUSINESS, PAYMENT_METHOD_LABEL, vatExemptNote } from "./invoice-labels";
import {
  creditedReceiptsBlock,
  creditedReceiptsNote,
  serviceYear,
  hasExemptNote,
  invoiceHeading,
  invoiceRecipient,
  invoiceTitle,
  isReceiptLike,
  dueImmediately,
  paymentNoteLines,
  paymentSummary,
  publicNotes,
  qtyDe,
  senderLine,
  showsDueDate,
  type CreditedPartial,
} from "./invoice-view";
import { type InvoiceBookingLink } from "./practice-documents";
import {
  A4,
  CONTENT_WIDTH,
  drawAddressBlock,
  drawLogoHead,
  drawFooters,
  drawQrBlocks,
  embedFonts,
  embedImage,
  FOOTER_TOP,
  GRAY,
  HEAD_FILL,
  makeSafe,
  makeWriter,
  ML,
  RIGHT,
  TOP,
  type PdfImage,
} from "./pdf-letter";

export type { PdfImage } from "./pdf-letter";

export type InvoicePdfData = {
  invoice: {
    id: string;
    number: string | null;
    kind: string;
    status: string;
    issuedAt: string | null;
    dueAt: string | null;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    paymentLinkUrl?: string | null;
  };
  lines: { description: string; quantity: string; factor: string; unitPriceCents: number; vatRate: number; totalCents: number; inTreatment?: boolean | null }[];
  payments: { paidAt: Date | string; method: string; amountCents: number; voucherCode?: string | null }[];
  /** auf diese Rechnung angerechnete Anzahlungen und Quittungen (Teilrechnungen) */
  credited?: CreditedPartial[];
  organization: {
    name: string;
    legalName: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
    phone: string | null;
    email: string | null;
    taxNumber: string | null;
    vatId: string | null;
    iban: string | null;
    smallBusiness: boolean;
    bic?: string | null;
    bankName?: string | null;
    accountHolder?: string | null;
    website?: string | null;
    /** Berufsbezeichnung/Qualifikation für die Fußzeile */
    qualification?: string | null;
    /** Telefon auch per WhatsApp erreichbar */
    whatsapp?: boolean;
  };
  patient: { number: number; salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string; street?: string | null; zip?: string | null; city?: string | null } | null;
  billingContact: { name: string; street: string | null; zip: string | null; city: string | null } | null;
  cancels?: { number: string | null } | null;
  /** Leistungsdaten (YYYY-MM-DD) aus verknüpften Terminen/Doku-Einträgen */
  serviceDates?: string[];
  /** Praxis-Logos (PNG/JPEG); ohne Logo erscheint der Praxisname */
  logos?: { full?: PdfImage | null; compact?: PdfImage | null };
  /** Buchungshinweis mit QR-Code (Einstellungen → Praxisdaten → Belege) */
  booking?: InvoiceBookingLink | null;
};

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  const { invoice: inv, lines, organization: o, patient: p, billingContact: b } = data;
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const { regular, bold } = fonts;
  const safe = makeSafe(regular);

  doc.setTitle(safe(invoiceTitle(inv)));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");

  const receiptLike = isReceiptLike(inv.kind);
  const fullLogo = await embedImage(doc, data.logos?.full);
  const compactLogo = await embedImage(doc, data.logos?.compact);

  const width = CONTENT_WIDTH;
  let page: PDFPage = doc.addPage(A4);
  let y = TOP;
  const writer = makeWriter(() => page, fonts, safe);
  const { text, wrap, line, box } = writer;
  const newPage = () => {
    page = doc.addPage(A4);
    y = TOP;
  };
  const ensure = (h: number) => {
    if (y - h < FOOTER_TOP) {
      newPage();
      return true;
    }
    return false;
  };

  // ── Kopf: Logo bzw. Praxisname ──
  y = drawLogoHead(writer, fonts, y, { full: fullLogo, compact: compactLogo, receiptLike, orgName: o.name });

  // ── Empfänger (links) und Kasten mit Belegdaten (rechts) ──
  const recipient = invoiceRecipient(p, b);
  const recLines = [recipient.name, recipient.care ? `für ${recipient.care}` : null, recipient.street, recipient.city || null].filter((v): v is string => !!v);
  const meta: [string, string][] = [[receiptLike ? "Quittungsnummer:" : "Rechnungsnummer:", inv.number ?? ""], [receiptLike ? "Datum:" : "Rechnungsdatum:", dateDe(inv.issuedAt)]];
  if (p) meta.push(["Patientennummer:", String(p.number)]);
  if (showsDueDate(inv)) meta.push(dueImmediately(inv) ? ["Zahlbar:", "sofort"] : ["Zahlbar bis:", dateDe(inv.dueAt)]);
  y = drawAddressBlock(writer, fonts, safe, y, {
    senderLine: senderLine(o),
    recipientLines: recLines,
    meta,
    boldMeta: (l) => l.startsWith("Rechnungsnummer") || l.startsWith("Quittungsnummer"),
    org: o,
  });

  // ── Überschrift ──
  const { heading, serviceDateNote } = invoiceHeading(inv, data.serviceDates ?? [], dateDe, data.cancels?.number);
  for (const hl of wrap(heading, width, 12.5, bold)) {
    text(hl, ML, y, { size: 12.5, font: bold });
    y -= 16;
  }
  if (serviceDateNote) {
    text(serviceDateNote, ML, y, { size: 8.5, color: GRAY });
    y -= 12;
  }
  y -= 6;

  // ── Positionen ──
  const showVat = lines.some((l) => l.vatRate !== 0);
  const colW = { pos: 26, qty: 40, factor: 40, unit: 62, vat: showVat ? 34 : 0, total: 62 };
  const descW = width - colW.pos - colW.qty - colW.factor - colW.unit - colW.vat - colW.total;
  const cx = {
    pos: ML,
    qty: ML + colW.pos,
    desc: ML + colW.pos + colW.qty,
    factor: ML + colW.pos + colW.qty + descW,
    unit: ML + colW.pos + colW.qty + descW + colW.factor,
    vat: ML + colW.pos + colW.qty + descW + colW.factor + colW.unit,
    total: RIGHT - colW.total,
  };
  const colEdges = [cx.pos, cx.qty, cx.desc, cx.factor, cx.unit, ...(showVat ? [cx.vat] : []), cx.total, RIGHT];
  const rowLines = (yTop: number, h: number) => colEdges.forEach((x) => line(x, yTop, x, yTop - h));
  const tableHeader = () => {
    const h = 14;
    box(ML, y, width, h, HEAD_FILL);
    rowLines(y, h);
    const ty = y - 10;
    const s = { size: 8, font: bold };
    text("Pos", cx.pos + colW.pos / 2, ty, { ...s, align: "center" });
    text("Anzahl", cx.qty + colW.qty / 2, ty, { ...s, align: "center" });
    text("Leistung / Heilmittel", cx.desc + descW / 2, ty, { ...s, align: "center" });
    text("Faktor", cx.factor + colW.factor / 2, ty, { ...s, align: "center" });
    text("Einzelpreis", cx.unit + colW.unit / 2, ty, { ...s, align: "center" });
    if (showVat) text("USt", cx.vat + colW.vat / 2, ty, { ...s, align: "center" });
    text("Summe", cx.total + colW.total / 2, ty, { ...s, align: "center" });
    y -= h;
  };
  tableHeader();
  lines.forEach((l, i) => {
    const d = wrap(l.description, descW - 8, 8.5);
    const h = d.length * 10.5 + 3.5;
    if (ensure(h + 18)) tableHeader();
    box(ML, y, width, h);
    rowLines(y, h);
    const ty = y - 9.5;
    text(String(i + 1), cx.pos + colW.pos / 2, ty, { size: 8.5, align: "center" });
    text(qtyDe(l.quantity), cx.qty + colW.qty / 2, ty, { size: 8.5, align: "center" });
    d.forEach((dl, k) => (d.length > 1 ? text(dl, cx.desc + 4, ty - k * 10.5, { size: 8.5 }) : text(dl, cx.desc + descW / 2, ty, { size: 8.5, align: "center" })));
    text(Number(l.factor).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), cx.factor + colW.factor - 4, ty, { size: 8.5, align: "right" });
    text(money(l.unitPriceCents), cx.unit + colW.unit - 4, ty, { size: 8.5, align: "right" });
    if (showVat) text(`${l.vatRate} %`, cx.vat + colW.vat - 4, ty, { size: 8.5, align: "right" });
    text(money(l.totalCents), RIGHT - 4, ty, { size: 8.5, align: "right" });
    y -= h;
  });

  // ── Summen ──
  const totals = computeTotals(lines);
  const open = inv.totalCents - inv.paidCents;
  const sumRows: { l: string; v: string; strong?: boolean }[] = [];
  if (showVat) {
    for (const g of totals.groups) {
      sumRows.push({ l: `Netto ${g.rate} %`, v: money(g.netCents) });
      if (g.rate) sumRows.push({ l: `USt ${g.rate} %`, v: money(g.vatCents) });
    }
  }
  sumRows.push({ l: "Gesamt", v: money(inv.totalCents), strong: true });
  for (const r of paymentSummary(inv, data.credited ?? [], dateDe, totals.groups)) sumRows.push({ l: r.label, v: money(r.cents) });
  if (inv.status !== "cancelled" && open !== 0 && (inv.paidCents !== 0 || open < 0)) sumRows.push({ l: open < 0 ? "zu erstatten" : "offen", v: money(Math.abs(open)), strong: true });
  ensure(sumRows.length * 14 + 4);
  const sumLabelX = cx.unit;
  for (const r of sumRows) {
    const h = 14;
    if (r.strong) {
      box(sumLabelX, y, RIGHT - sumLabelX, h);
      line(cx.total, y, cx.total, y - h);
    }
    text(r.l, cx.total - 5, y - 10, { size: 8.5, font: r.strong ? bold : regular, align: "right" });
    text(r.v, RIGHT - 4, y - 10, { size: 8.5, font: r.strong ? bold : regular, align: "right" });
    y -= h;
  }
  y -= 18;

  // ── Bereits bezahlt (Quittungen): alle angerechneten normalen Quittungen der Sammelrechnung ──
  const rb = creditedReceiptsBlock(data.credited ?? []);
  if (rb.rows.length) {
    const colNo = ML;
    const colDate = ML + 120;
    const colAmount = ML + 300;
    const colVat = ML + 390;
    ensure(34 + 12);
    text("Bereits bezahlt (Quittungen)", ML, y, { size: 8.5, font: bold });
    y -= 12;
    text("Nummer", colNo, y, { size: 8 });
    text("Datum", colDate, y, { size: 8 });
    text("Betrag", colAmount, y, { size: 8, align: "right" });
    text("darin USt", colVat, y, { size: 8, align: "right" });
    y -= 11;
    for (const r of rb.rows) {
      ensure(12);
      text(r.number, colNo, y, { size: 8.5 });
      text(dateDe(r.issuedAt), colDate, y, { size: 8.5 });
      text(money(r.totalCents), colAmount, y, { size: 8.5, align: "right" });
      text(money(r.vatCents), colVat, y, { size: 8.5, align: "right" });
      y -= 12;
    }
    ensure(26);
    text(`Summe (${rb.rows.length} Quittung${rb.rows.length === 1 ? "" : "en"})`, colNo, y, { size: 8.5, font: bold });
    text(money(rb.totalCents), colAmount, y, { size: 8.5, font: bold, align: "right" });
    text(money(rb.vatCents), colVat, y, { size: 8.5, font: bold, align: "right" });
    y -= 12;
    text("Offener Restbetrag", colNo, y, { size: 8.5, font: bold });
    text(money(inv.status === "cancelled" ? 0 : open), colAmount, y, { size: 8.5, font: bold, align: "right" });
    y -= 20;
  }

  // ── Zahlungen ──
  if (data.payments.length) {
    ensure(20 + data.payments.length * 12);
    text("Zahlungen", ML, y, { size: 8.5, font: bold });
    y -= 12;
    for (const pay of data.payments) {
      ensure(12);
      text(`${dateTimeDe(pay.paidAt)} · ${PAYMENT_METHOD_LABEL[pay.method] ?? pay.method}${pay.voucherCode ? ` ${pay.voucherCode}` : ""}`, ML, y, { size: 8.5 });
      text(money(pay.amountCents), ML + 300, y, { size: 8.5, align: "right" });
      y -= 12;
    }
    y -= 8;
  }

  // ── Hinweise ──
  const giro = isValidIban(o.iban) ? invoicePaymentQr(inv, o) : null;
  const notes: { t: string; strong?: boolean }[] = [];
  if (o.smallBusiness) notes.push({ t: NOTE_SMALL_BUSINESS });
  if (hasExemptNote(o, inv, lines)) notes.push({ t: vatExemptNote(lines) });
  if (inv.kind === "no_show_fee") notes.push({ t: NOTE_NO_SHOW });
  if (inv.kind === "deposit") notes.push({ t: NOTE_DEPOSIT });
  if (rb.rows.length) notes.push({ t: creditedReceiptsNote(serviceYear(data.serviceDates ?? [], inv.issuedAt)) });
  const pub = publicNotes(inv.notes);
  if (pub) notes.push({ t: pub });
  for (const n of paymentNoteLines(inv, data.payments, o, { dateDe, money }, { giroCode: !!giro })) notes.push({ t: n });
  if (inv.kind !== "credit_note" && inv.status !== "cancelled") notes.push({ t: "Vielen Dank für Ihr Vertrauen" });
  for (const [i, n] of notes.entries()) {
    const wl = wrap(n.t, width, 10);
    if (i === notes.length - 1 && n.t.startsWith("Vielen Dank")) y -= 10;
    ensure(wl.length * 13 + 2);
    for (const l of wl) {
      text(l, ML, y, { size: 10, font: n.strong ? bold : regular });
      y -= 13;
    }
    y -= 1;
  }

  // ── QR-Codes: GiroCode (Bezahlen) und Terminbuchung ──
  const booking = data.booking && inv.kind !== "credit_note" ? data.booking : null;
  const blocks: { title: string; sub: string[]; payload: string }[] = [];
  if (giro) {
    const holder = (o.accountHolder?.trim() || o.legalName?.trim() || o.name).slice(0, 70);
    blocks.push({ title: "Bezahlen per GiroCode", sub: [`${money(open)} an ${holder}`, `Verwendungszweck: Rechnung ${inv.number}`], payload: giro });
  }
  if (booking) blocks.push({ title: booking.label, sub: [], payload: booking.url });
  if (blocks.length) {
    y -= 10;
    ensure(78 + 6 + 4);
    y = drawQrBlocks(writer, fonts, y, blocks);
  }

  // ── Fußzeile (jede Seite) ──
  drawFooters(doc, fonts, safe, o);

  return doc.save();
}

export function invoicePdfFilename(inv: { number: string | null; id: string }) {
  return `${(inv.number ?? inv.id).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
