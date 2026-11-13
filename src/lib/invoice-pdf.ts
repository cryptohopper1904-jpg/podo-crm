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
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { invoicePaymentQr, isValidIban } from "./epc-qr";
import { dateDe, dateTimeDe, money } from "./format";
import { computeTotals } from "./invoice-math";
import { NOTE_DEPOSIT, NOTE_NO_SHOW, NOTE_SMALL_BUSINESS, NOTE_VAT_EXEMPT, PAYMENT_METHOD_LABEL } from "./invoice-labels";
import {
  creditedReceiptsBlock,
  creditedReceiptsNote,
  serviceYear,
  formatIban,
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
import { shortUrl, type InvoiceBookingLink } from "./practice-documents";

export type PdfImage = { bytes: Uint8Array; mime: string };

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
  lines: { description: string; quantity: string; factor: string; unitPriceCents: number; vatRate: number; totalCents: number }[];
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

const A4: [number, number] = [595.28, 841.89];
const ML = 50;
const MR = 50;
const TOP = 805;
const FOOTER_TOP = 125;
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);
const LIGHT = rgb(0.5, 0.5, 0.5);
const RULE = rgb(0.6, 0.6, 0.6);
const HEAD_FILL = rgb(0.9, 0.9, 0.9);

async function embedImage(doc: PDFDocument, img: PdfImage | null | undefined): Promise<PDFImage | null> {
  if (!img?.bytes?.length) return null;
  try {
    return img.mime === "image/jpeg" ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
  } catch {
    // defekte Datei: Beleg trotzdem erzeugen (ohne Logo)
    return null;
  }
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  const { invoice: inv, lines, organization: o, patient: p, billingContact: b } = data;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const charset = new Set(regular.getCharacterSet());
  const safe = (s: string) =>
    [...s.normalize("NFC")]
      .map((c) => {
        if (c === "\t") return " ";
        const cp = c.codePointAt(0)!;
        if (charset.has(cp)) return c;
        if (c === " " || c === " ") return " ";
        return "?";
      })
      .join("");

  doc.setTitle(safe(invoiceTitle(inv)));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");

  const receiptLike = isReceiptLike(inv.kind);
  const fullLogo = await embedImage(doc, data.logos?.full);
  const compactLogo = await embedImage(doc, data.logos?.compact);

  const width = A4[0] - ML - MR;
  const RIGHT = ML + width;
  let page: PDFPage = doc.addPage(A4);
  let y = TOP;

  type TextOpts = { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; align?: "left" | "right" | "center" };
  const text = (t: string, x: number, yy: number, opts: TextOpts = {}) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const s = safe(t);
    const w = font.widthOfTextAtSize(s, size);
    const xx = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    page.drawText(s, { x: xx, y: yy, size, font, color: opts.color ?? BLACK });
    return w;
  };
  /** Einzeilig auf maxW kürzen (mit „…“) */
  const clip = (t: string, maxW: number, size = 10, font = regular): string => {
    const s = safe(t);
    if (font.widthOfTextAtSize(s, size) <= maxW) return s;
    let out = s;
    while (out.length > 1 && font.widthOfTextAtSize(out + "…", size) > maxW) out = out.slice(0, -1);
    return out.trimEnd() + "…";
  };
  const wrap = (t: string, maxW: number, size = 10, font = regular): string[] => {
    const out: string[] = [];
    for (const para of safe(t).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const cand = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(cand, size) <= maxW) {
          line = cand;
          continue;
        }
        if (line) out.push(line);
        // sehr lange Wörter hart umbrechen
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > maxW && rest.length > 1) {
          let n = rest.length - 1;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxW) n--;
          out.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
      out.push(line);
    }
    return out;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, thickness = 0.6, color = RULE) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  const box = (x: number, yTop: number, w: number, h: number, fill?: ReturnType<typeof rgb>) =>
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: RULE, borderWidth: 0.6, ...(fill ? { color: fill } : {}) });
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
  const drawLogo = (img: PDFImage, maxW: number, maxH: number, at: "center" | "right") => {
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = at === "center" ? (A4[0] - w) / 2 : RIGHT - w;
    page.drawImage(img, { x, y: y - h, width: w, height: h });
    return h;
  };
  /** QR-Code als Vektorgrafik (scharf in jeder Druckgröße), Fehlerkorrektur M (EPC-Vorgabe) */
  const drawQr = (payload: string, x: number, yTop: number, size: number) => {
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const quiet = 2;
    const cell = size / (n + quiet * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.modules.get(r, c)) page.drawRectangle({ x: x + (c + quiet) * cell, y: yTop - (r + quiet + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: BLACK });
      }
    }
  };

  // ── Kopf: Logo bzw. Praxisname ──
  if (receiptLike && (compactLogo || fullLogo)) {
    // Quittung: dezentes Zeichen oben rechts, Praxisname links
    const img = (compactLogo ?? fullLogo)!;
    const h = drawLogo(img, compactLogo ? 60 : 140, compactLogo ? 44 : 40, "right");
    text(o.name, ML, y - 16, { size: 14, font: bold });
    y -= Math.max(h, 24) + 22;
  } else if (fullLogo || compactLogo) {
    const h = fullLogo ? drawLogo(fullLogo, 230, 78, "center") : drawLogo(compactLogo!, 70, 56, "center");
    y -= h + 26;
  } else {
    text(o.name, A4[0] / 2, y - 14, { size: 16, font: bold, align: "center" });
    y -= 42;
  }

  // ── Empfänger (links) und Kasten mit Belegdaten (rechts) ──
  const recipient = invoiceRecipient(p, b);
  const boxX = ML + width * 0.58;
  const boxW = RIGHT - boxX;
  const sl = senderLine(o).replaceAll(" · ", " - ");
  const slSize = 6.5;
  const slMax = boxX - ML - 16;
  let slText = safe(sl);
  while (regular.widthOfTextAtSize(slText, slSize) > slMax && slText.length > 10) slText = slText.slice(0, -2);
  const slW = text(slText, ML, y - 8, { size: slSize, color: GRAY });
  line(ML, y - 9.5, ML + slW, y - 9.5, 0.3, GRAY);
  let ly = y - 24;
  const recLines = [recipient.name, recipient.care ? `für ${recipient.care}` : null, recipient.street, recipient.city || null].filter((v): v is string => !!v);
  for (const l of recLines) {
    for (const wl of wrap(l, slMax, 11)) {
      text(wl, ML, ly, { size: 11 });
      ly -= 14;
    }
  }

  const meta: [string, string][] = [[receiptLike ? "Quittungsnummer:" : "Rechnungsnummer:", inv.number ?? ""], [receiptLike ? "Datum:" : "Rechnungsdatum:", dateDe(inv.issuedAt)]];
  if (p) meta.push(["Patientennummer:", String(p.number)]);
  if (showsDueDate(inv)) meta.push(dueImmediately(inv) ? ["Zahlbar:", "sofort"] : ["Zahlbar bis:", dateDe(inv.dueAt)]);
  const contact: string[] = [];
  if (o.phone) contact.push(`Tel. ${o.phone}${o.whatsapp ? " (auch WhatsApp)" : ""}`);
  if (o.email) contact.push(o.email);
  const rowH = 13;
  const boxH = 8 + meta.length * rowH + (contact.length ? 10 + rowH + contact.length * rowH : 0) + 2;
  box(boxX, y, boxW, boxH);
  let by = y - 13;
  const labelW = 82;
  for (const [l, v] of meta) {
    text(l, boxX + 6, by, { size: 8.5 });
    text(v, boxX + 6 + labelW, by, { size: 9.5, font: l.startsWith("Rechnungsnummer") || l.startsWith("Quittungsnummer") ? bold : regular });
    by -= rowH;
  }
  if (contact.length) {
    by -= 10;
    const tw = text("Terminvereinbarung", boxX + 6, by, { size: 8.5 });
    line(boxX + 6, by - 1.5, boxX + 6 + tw, by - 1.5, 0.4, BLACK);
    by -= rowH;
    for (const c of contact) {
      for (const wlLine of wrap(c, boxW - 12, 8.5).slice(0, 2)) {
        text(wlLine, boxX + 6, by, { size: 8.5 });
        by -= rowH;
      }
    }
  }
  y = Math.min(ly, y - boxH) - 26;

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
  if (hasExemptNote(o, inv, lines)) notes.push({ t: NOTE_VAT_EXEMPT });
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
    const qrSize = 78;
    const blockH = qrSize + 6;
    y -= 10;
    ensure(blockH + 4);
    const colWidth = width / 2;
    blocks.forEach((bl, i) => {
      const x = ML + i * colWidth;
      drawQr(bl.payload, x, y, qrSize);
      const tx = x + qrSize + 8;
      const maxW = colWidth - qrSize - 14;
      let ty = y - 18;
      for (const tl of wrap(bl.title, maxW, 9, bold)) {
        text(tl, tx, ty, { size: 9, font: bold });
        ty -= 11.5;
      }
      for (const s of bl.sub) {
        for (const sl2 of wrap(s, maxW, 8.5)) {
          text(sl2, tx, ty, { size: 8.5, color: GRAY });
          ty -= 11;
        }
      }
    });
    y -= blockH;
  }

  // ── Fußzeile (jede Seite) ──
  const pages = doc.getPages();
  const left = [o.name, o.legalName && o.legalName !== o.name ? o.legalName : null, o.street, [o.zip, o.city].filter(Boolean).join(" ") || null].filter((v): v is string => !!v);
  const right: [string, string][] = [];
  if (o.iban) right.push(["IBAN:", formatIban(o.iban)]);
  if (o.bic) right.push(["BIC:", o.bic.replace(/\s/g, "").toUpperCase()]);
  if (o.bankName) right.push(["Bank:", o.bankName]);
  if (o.iban && (o.accountHolder || o.legalName)) right.push(["Kontoinhaber:", (o.accountHolder || o.legalName)!]);
  if (o.taxNumber) right.push(["Steuernummer:", o.taxNumber]);
  if (o.vatId) right.push(["USt-IdNr.:", o.vatId]);
  const center = [o.phone, o.website ? shortUrl(o.website) : o.email].filter((v): v is string => !!v);
  pages.forEach((pg, i) => {
    page = pg;
    const top = FOOTER_TOP - 14;
    const rx = ML + width * 0.6;
    // Spaltenbreiten begrenzen: lange Namen/Banken werden gekürzt statt über den Rand zu laufen
    left.slice(0, 5).forEach((l, li) => text(clip(l, rx - ML - 12, 7), ML, top - li * 9, { size: 7, color: LIGHT }));
    right.slice(0, 6).forEach(([k, v], li) => {
      text(k, rx, top - li * 9, { size: 7, color: LIGHT });
      text(clip(v, RIGHT - rx - 52, 7), rx + 52, top - li * 9, { size: 7, color: LIGHT });
    });
    const cy = top - Math.max(Math.min(left.length, 5), Math.min(right.length, 6), 3) * 9 - 6;
    center.forEach((c, ci) => text(c, A4[0] / 2, cy - ci * 11, { size: 9, color: GRAY, align: "center" }));
    if (o.qualification) {
      wrap(o.qualification, width, 7, italic)
        .slice(0, 2)
        .forEach((q, qi) => text(q, A4[0] / 2, cy - center.length * 11 - 3 - qi * 9, { size: 7, font: italic, color: LIGHT, align: "center" }));
    }
    if (pages.length > 1) text(`Seite ${i + 1} von ${pages.length}`, RIGHT, 18, { size: 7, color: LIGHT, align: "right" });
  });

  return doc.save();
}

export function invoicePdfFilename(inv: { number: string | null; id: string }) {
  return `${(inv.number ?? inv.id).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
