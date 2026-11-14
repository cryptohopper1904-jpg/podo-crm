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
import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import { invoicePaymentQr, isValidIban } from "./epc-qr";
import { dateDe, dateTimeDe, money } from "./format";
import { computeTotals } from "./invoice-math";
import { INVOICE_KIND_LABEL, NOTE_DEPOSIT, NOTE_NO_SHOW, NOTE_SMALL_BUSINESS, PAYMENT_METHOD_LABEL, vatExemptNote } from "./invoice-labels";
import {
  creditedReceiptsBlock,
  creditedReceiptsNote,
  serviceYear,
  hasExemptNote,
  invoiceAsIssued,
  invoiceHeading,
  invoiceService,
  invoiceRecipient,
  openSumRow,
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
import { TSE_TEST_NOTICE, tseLines, type FiscalInfo } from "./tse-receipt";
import {
  A4,
  CONT_TOP,
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
  PAGE_BODY,
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
    /** Leistungsangabe festgeschrieben (false = Altbeleg, Darstellung wie früher) */
    serviceDateFixed?: boolean | null;
    totalCents: number;
    paidCents: number;
    notes: string | null;
    paymentLinkUrl?: string | null;
    /**
     * Anlagezeitpunkt (invoices.created_at): trennt beim Ausstellen erfasste von späteren Zahlungen (invoiceAsIssued).
     * Pflicht – null nur für reine Darstellungsdaten ohne DB-Bezug (dann gelten alle Zahlungen als beim Ausstellen).
     */
    createdAt: Date | string | null;
    /** invoices.source („crm“ bzw. Altbestand, z. B. Excel-Import) */
    source?: string | null;
  };
  lines: { description: string; quantity: string; factor: string; unitPriceCents: number; vatRate: number; totalCents: number; inTreatment?: boolean | null }[];
  payments: {
    paidAt: Date | string;
    method: string;
    amountCents: number;
    voucherCode?: string | null;
    externalRef?: string | null;
    /** TSE-Signatur des Kassenvorgangs (fiscal_transactions) – Pflichtangaben nach § 6 KassenSichV auf dem Beleg */
    fiscal?: FiscalInfo | null;
  }[];
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
  cancels?: { number: string | null; kind?: string; issuedAt?: string | null } | null;
  /** Leistungsdaten (YYYY-MM-DD) aus verknüpften Terminen/Doku-Einträgen (Storno: die der stornierten Rechnung) */
  serviceDates?: string[];
  /** Positionen mit Termin-/Doku-Bezug („… zur Behandlung am …“) */
  serviceLinked?: boolean;
  /** Praxis-Logos (PNG/JPEG); ohne Logo erscheint der Praxisname */
  logos?: { full?: PdfImage | null; compact?: PdfImage | null };
  /** Buchungshinweis mit QR-Code (Einstellungen → Praxisdaten → Belege) */
  booking?: InvoiceBookingLink | null;
  /**
   * Neudruck einer stornierten Rechnung: Beleg wie ausgestellt mit deutlichem Vermerk „STORNIERT durch Stornorechnung
   * Nr. … vom …“, ohne GiroCode (nichts mehr zu überweisen).
   */
  cancellation?: { number: string | null; issuedAt: string | null } | null;
  /**
   * Kein archiviertes Original vorhanden (Altbeleg vor dem Beleg-Archiv): der Beleg wird aus den gespeicherten Daten
   * neu erzeugt und als „Reproduktion“ gekennzeichnet (Fußnote).
   */
  reproduction?: { generatedAt: Date | string } | null;
};

const STAMP_RED = rgb(0.75, 0.05, 0.05);

/** Vermerk auf dem Neudruck einer stornierten Rechnung */
export function cancellationStamp(c: { number: string | null; issuedAt: string | null }): string {
  return `STORNIERT durch Stornorechnung Nr. ${c.number ?? "–"} vom ${dateDe(c.issuedAt)}`;
}
export const CANCELLATION_SUB = "Neudruck des ausgestellten Belegs – dieser Beleg ist ungültig und nicht mehr zu bezahlen.";

/** Fußnote eines aus gespeicherten Daten neu erzeugten Altbelegs */
export function reproductionNote(at: Date | string): string {
  return `Reproduktion: Dieser Beleg wurde am ${dateTimeDe(at)} aus den gespeicherten Belegdaten mit den heutigen Stammdaten neu erzeugt; ein archiviertes Original liegt nicht vor. Maßgeblich ist der ursprünglich versandte Beleg.`;
}

export async function renderInvoicePdf(input: InvoicePdfData): Promise<Uint8Array> {
  // Beleg im Stand der Ausstellung: spätere Zahlungen/Zahlungslinks ändern das PDF nicht (GoBD, § 14 UStG)
  // Neudruck einer stornierten Rechnung: Stand wie ausgestellt (Zahlungsaufforderung usw.), der Vermerk macht ihn ungültig
  const asIssuedBase = input.cancellation && input.invoice.status === "cancelled" ? { ...input.invoice, status: "issued" } : input.invoice;
  const issued = invoiceAsIssued(asIssuedBase, input.payments);
  const data: InvoicePdfData = { ...input, invoice: issued.invoice, payments: issued.payments };
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
  // Folgeseiten beginnen unter der Kopfzeile (Praxisname, Beleg, „Seite X von Y“ – drawFooters)
  const newPage = () => {
    page = doc.addPage(A4);
    y = CONT_TOP;
  };
  const ensure = (h: number) => {
    if (y - h < FOOTER_TOP) {
      newPage();
      return true;
    }
    return false;
  };
  /**
   * Block der Höhe h zusammenhalten (ggf. komplett auf die nächste Seite), sofern er auf eine Seite passt.
   * Höhere Blöcke beginnen sofort und werden zeilenweise umbrochen (jede Zeile prüft selbst mit ensure).
   */
  const keep = (h: number) => (h <= PAGE_BODY ? ensure(h) : false);

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

  // ── Stornovermerk (Neudruck einer stornierten Rechnung) ──
  if (data.cancellation) {
    const stamp = wrap(cancellationStamp(data.cancellation), width - 16, 12, bold);
    const sub = wrap(CANCELLATION_SUB, width - 16, 9);
    const h = stamp.length * 15 + sub.length * 11 + 12;
    page.drawRectangle({ x: ML, y: y - h, width, height: h, borderColor: STAMP_RED, borderWidth: 2 });
    let sy = y - 16;
    for (const l of stamp) {
      text(l, ML + 8, sy, { size: 12, font: bold, color: STAMP_RED });
      sy -= 15;
    }
    for (const l of sub) {
      text(l, ML + 8, sy, { size: 9, color: STAMP_RED });
      sy -= 11;
    }
    y -= h + 12;
  }

  // ── Überschrift ──
  const { heading, serviceDateNote } = invoiceHeading(inv, invoiceService(data), dateDe);
  for (const hl of wrap(heading, width, 12.5, bold)) {
    text(hl, ML, y, { size: 12.5, font: bold });
    y -= 16;
  }
  for (const nl of serviceDateNote ? wrap(serviceDateNote, width, 8.5) : []) {
    text(nl, ML, y, { size: 8.5, color: GRAY });
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
  const ROW_LINE = 10.5;
  const ROW_PAD = 3.5;
  const HEAD_H = 14;
  const rowHeight = (n: number) => n * ROW_LINE + ROW_PAD;
  const rowLinesOf = (l: { description: string }) => wrap(l.description, descW - 8, 8.5);
  // Tabellenkopf nicht allein am Seitenende: Kopf und erste Zeile (höchstens 3 Textzeilen davon) zusammen
  ensure(HEAD_H + (lines[0] ? rowHeight(Math.min(rowLinesOf(lines[0]).length, 3)) : 0));
  tableHeader();
  lines.forEach((l, i) => {
    const d = rowLinesOf(l);
    // Zeilen werden nicht getrennt, sofern sie auf eine Seite passen; auf jeder Folgeseite wiederholter Tabellenkopf.
    // Höhere Positionen beginnen sofort und brechen innerhalb der Beschreibung um (kein Text geht verloren).
    if (rowHeight(d.length) <= PAGE_BODY - HEAD_H) {
      if (ensure(rowHeight(d.length))) tableHeader();
    } else if (ensure(rowHeight(1))) tableHeader();
    let rest = d;
    let first = true;
    while (rest.length) {
      // kleiner Puffer gegen Rundungsfehler, wenn der Platz genau aufgeht
      const fit = Math.max(1, Math.floor((y - FOOTER_TOP - ROW_PAD) / ROW_LINE + 1e-6));
      const part = rest.slice(0, fit);
      rest = rest.slice(fit);
      // Fortsetzung (immer oben auf einer neuen Seite) mindestens zweizeilig: Pos-Nummer und „(Forts.)“
      const h = rowHeight(first ? part.length : Math.max(part.length, 2));
      box(ML, y, width, h);
      rowLines(y, h);
      const ty = y - 9.5;
      if (first) {
        text(String(i + 1), cx.pos + colW.pos / 2, ty, { size: 8.5, align: "center" });
        text(qtyDe(l.quantity), cx.qty + colW.qty / 2, ty, { size: 8.5, align: "center" });
      } else {
        // fortgesetzte Position auf der Folgeseite: Pos-Nummer, darunter „(Forts.)“ in 7 pt (passt in die Pos-Spalte)
        text(String(i + 1), cx.pos + colW.pos / 2, ty, { size: 8.5, align: "center" });
        text("(Forts.)", cx.pos + colW.pos / 2, ty - 9, { size: 7, align: "center" });
      }
      part.forEach((dl, k) => (d.length > 1 ? text(dl, cx.desc + 4, ty - k * ROW_LINE, { size: 8.5 }) : text(dl, cx.desc + descW / 2, ty, { size: 8.5, align: "center" })));
      if (first) {
        text(Number(l.factor).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), cx.factor + colW.factor - 4, ty, { size: 8.5, align: "right" });
        text(money(l.unitPriceCents), cx.unit + colW.unit - 4, ty, { size: 8.5, align: "right" });
        if (showVat) text(`${l.vatRate} %`, cx.vat + colW.vat - 4, ty, { size: 8.5, align: "right" });
        text(money(l.totalCents), RIGHT - 4, ty, { size: 8.5, align: "right" });
      }
      y -= h;
      first = false;
      if (rest.length) {
        newPage();
        tableHeader();
      }
    }
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
  const openRow = openSumRow(inv);
  if (openRow) sumRows.push({ l: openRow.label, v: money(openRow.cents), strong: true });
  // Summenblock mit USt-Ausweis und Anrechnungen nicht trennen
  keep(sumRows.length * 14 + 4);
  const sumLabelX = cx.unit;
  for (const r of sumRows) {
    const h = 14;
    ensure(h);
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
    const colHead = () => {
      text("Nummer", colNo, y, { size: 8 });
      text("Datum", colDate, y, { size: 8 });
      text("Betrag", colAmount, y, { size: 8, align: "right" });
      text("darin USt", colVat, y, { size: 8, align: "right" });
      y -= 11;
    };
    // ganzer Block (Überschrift, Quittungen, Summe, Restbetrag) auf einer Seite, sofern er passt
    keep(12 + 11 + rb.rows.length * 12 + 24 + 8);
    ensure(12 + 11 + 12);
    text("Bereits bezahlt (Quittungen)", ML, y, { size: 8.5, font: bold });
    y -= 12;
    colHead();
    for (const [ri, r] of rb.rows.entries()) {
      // nur bei sehr vielen Quittungen: Umbruch mit wiederholtem Spaltenkopf, Summe nicht allein
      if (ensure(ri === rb.rows.length - 1 ? 12 + 24 + 8 : 12)) colHead();
      text(r.number, colNo, y, { size: 8.5 });
      text(dateDe(r.issuedAt), colDate, y, { size: 8.5 });
      text(money(r.totalCents), colAmount, y, { size: 8.5, align: "right" });
      text(money(r.vatCents), colVat, y, { size: 8.5, align: "right" });
      y -= 12;
    }
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
    keep(12 + data.payments.length * 12 + 8);
    ensure(24);
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

  // ── TSE-Angaben der Kassenvorgänge (§ 6 KassenSichV) ──
  const signed = data.payments.filter((pay) => pay.fiscal);
  for (const pay of signed) {
    const f = pay.fiscal!;
    const rows = tseLines(f);
    const sigLines = wrap(rows.at(-1)![1], width - 110, 7);
    const h = 12 + (rows.length - 1) * 10 + sigLines.length * 9 + (f.isTest ? 12 : 0) + 6;
    keep(h);
    ensure(24);
    text(signed.length > 1 ? `TSE-Angaben (${PAYMENT_METHOD_LABEL[pay.method] ?? pay.method}, ${money(pay.amountCents)})` : "TSE-Angaben", ML, y, { size: 8.5, font: bold });
    y -= 12;
    if (f.isTest) {
      text(TSE_TEST_NOTICE, ML, y, { size: 8, font: bold, color: STAMP_RED });
      y -= 12;
    }
    for (const [k, v] of rows.slice(0, -1)) {
      ensure(10);
      text(k, ML, y, { size: 7.5, color: GRAY });
      text(v, ML + 110, y, { size: 7.5 });
      y -= 10;
    }
    ensure(9);
    text(rows.at(-1)![0], ML, y, { size: 7.5, color: GRAY });
    for (const l of sigLines) {
      ensure(9);
      text(l, ML + 110, y, { size: 7 });
      y -= 9;
    }
    y -= 6;
  }

  // ── Hinweise ──
  const giro = !data.cancellation && isValidIban(o.iban) ? invoicePaymentQr(inv, o) : null;
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
  if (data.reproduction) notes.push({ t: reproductionNote(data.reproduction.generatedAt), strong: true });
  // Hinweise (Steuer-/Zahlungshinweise) als Ganzes halten; passt das nicht auf eine Seite, jeden Absatz für sich
  const lastBeforeFootnote = notes.length - (data.reproduction ? 2 : 1);
  const thanks = (i: number) => i === lastBeforeFootnote && notes[i].t.startsWith("Vielen Dank");
  keep(notes.reduce((h, n, i) => h + wrap(n.t, width, 10).length * 13 + 1 + (thanks(i) ? 10 : 0), 0) + 1);
  for (const [i, n] of notes.entries()) {
    const wl = wrap(n.t, width, 10);
    if (thanks(i)) y -= 10;
    keep(wl.length * 13 + 2);
    for (const l of wl) {
      // nur bei Absätzen über eine Seite wirksam: zeilenweise umbrechen statt in die Fußzeile zu schreiben
      ensure(13);
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
  const kindLabel = INVOICE_KIND_LABEL[inv.kind] ?? "Rechnung";
  drawFooters(doc, fonts, safe, o, inv.number ? `${kindLabel} Nr. ${inv.number}${data.cancellation ? " (STORNIERT)" : ""}` : `${kindLabel} – Entwurf`);

  return doc.save();
}

export function invoicePdfFilename(inv: { number: string | null; id: string }) {
  return `${(inv.number ?? inv.id).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
