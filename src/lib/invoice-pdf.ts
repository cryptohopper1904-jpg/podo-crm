/**
 * PDF-Rechnung (pdf-lib, reine Funktion ohne Server-Importe).
 * Layout entspricht der Druckansicht in src/app/(app)/rechnungen/[id]/page.tsx:
 * Absenderzeile, Empfänger (inkl. Pflegeheim „für …“), Praxis-Kopf, Kopfdaten, Positionen,
 * USt-Ausweis je Satz, Zahlungen, Hinweise (§ 19 / § 4 Nr. 14 / § 615), Überweisungshinweis, Fußzeile mit IBAN.
 *
 * Schrift: Helvetica (Standardschrift, WinAnsi). Nicht darstellbare Zeichen werden ersetzt.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { dateDe, dateTimeDe, money } from "./format";
import { computeTotals } from "./invoice-math";
import { NOTE_NO_SHOW, NOTE_SMALL_BUSINESS, NOTE_VAT_EXEMPT, PAYMENT_METHOD_LABEL } from "./invoice-labels";
import { formatIban, hasExemptNote, invoiceRecipient, invoiceTitle, publicNotes, qtyDe, senderLine, showsDueDate } from "./invoice-view";

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
  };
  lines: { description: string; quantity: string; factor: string; unitPriceCents: number; vatRate: number; totalCents: number }[];
  payments: { paidAt: Date | string; method: string; amountCents: number; voucherCode?: string | null }[];
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
  };
  patient: { number: number; salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string; street?: string | null; zip?: string | null; city?: string | null } | null;
  billingContact: { name: string; street: string | null; zip: string | null; city: string | null } | null;
  cancels?: { number: string | null } | null;
};

const A4: [number, number] = [595.28, 841.89];
const ML = 45;
const MR = 45;
const TOP = 800;
const FOOTER_TOP = 100;
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.73, 0.73, 0.73);

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Uint8Array> {
  const { invoice: inv, lines, organization: o, patient: p, billingContact: b } = data;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(regular.getCharacterSet());
  const safe = (s: string) =>
    [...s.normalize("NFC")]
      .map((c) => {
        if (c === "\t") return " ";
        const cp = c.codePointAt(0)!;
        if (charset.has(cp)) return c;
        if (c === " " || c === " ") return " ";
        return "?";
      })
      .join("");

  const title = invoiceTitle(inv);
  doc.setTitle(safe(title));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoCRM");
  doc.setProducer("PodoCRM (pdf-lib)");

  const width = A4[0] - ML - MR;
  let page: PDFPage = doc.addPage(A4);
  let y = TOP;

  type TextOpts = { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; align?: "left" | "right" };
  const text = (t: string, x: number, yy: number, opts: TextOpts = {}) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const s = safe(t);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: opts.align === "right" ? x - w : x, y: yy, size, font, color: opts.color ?? BLACK });
    return w;
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
  const hr = (yy: number, thickness = 0.5, color = RULE) =>
    page.drawLine({ start: { x: ML, y: yy }, end: { x: A4[0] - MR, y: yy }, thickness, color });
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

  // ── Kopf ──
  const recipient = invoiceRecipient(p, b);
  const sl = senderLine(o);
  const slW = text(sl, ML, y, { size: 7, color: GRAY });
  page.drawLine({ start: { x: ML, y: y - 1.5 }, end: { x: ML + slW, y: y - 1.5 }, thickness: 0.4, color: GRAY });
  let ly = y - 18;
  text(recipient.name, ML, ly, { font: bold });
  ly -= 13;
  if (recipient.care) {
    text(`für ${recipient.care}`, ML, ly);
    ly -= 13;
  }
  if (recipient.street) {
    text(recipient.street, ML, ly);
    ly -= 13;
  }
  if (recipient.city) {
    text(recipient.city, ML, ly);
    ly -= 13;
  }

  const rx = A4[0] - MR;
  let ry = y + 2;
  text(o.name, rx, ry, { size: 13, font: bold, align: "right" });
  ry -= 15;
  const rightLines = [
    o.legalName && o.legalName !== o.name ? o.legalName : null,
    o.street,
    [o.zip, o.city].filter(Boolean).join(" ") || null,
    o.phone ? `Tel. ${o.phone}` : null,
    o.email,
  ].filter((v): v is string => !!v);
  for (const l of rightLines) {
    text(l, rx, ry, { size: 9.5, align: "right" });
    ry -= 12;
  }
  y = Math.min(ly, ry) - 22;

  // ── Kopfdaten ──
  const meta: [string, string, boolean][] = [
    [inv.kind === "receipt" ? "Quittungsnummer" : "Rechnungsnummer", inv.number ?? "", true],
    ["Datum", dateDe(inv.issuedAt), false],
  ];
  if (p) meta.push(["Kundennummer", String(p.number), false]);
  if (showsDueDate(inv)) meta.push(["Zahlbar bis", dateDe(inv.dueAt), true]);
  const colW = width / 4;
  meta.forEach(([label, value, strong], i) => {
    text(label, ML + i * colW, y, { size: 7.5, color: GRAY });
    text(value, ML + i * colW, y - 13, { size: 10, font: strong ? bold : regular });
  });
  y -= 46;

  // ── Titel ──
  text(title, ML, y, { size: 17, font: bold });
  y -= 16;
  if (data.cancels?.number) {
    text(`Storno der Rechnung ${data.cancels.number}`, ML, y, { size: 9.5, color: GRAY });
    y -= 13;
  }
  text("Leistungsdatum entspricht dem Rechnungsdatum, sofern nicht anders angegeben.", ML, y, { size: 9, color: GRAY });
  y -= 22;

  // ── Positionen ──
  const cols = { pos: ML, desc: ML + 28, qty: ML + width - 270, factor: ML + width - 225, unit: ML + width - 150, vat: ML + width - 100, total: ML + width };
  const descW = cols.qty - 45 - cols.desc - 8;
  const tableHeader = () => {
    const s = { size: 7.5, font: bold, color: GRAY };
    text("Pos.", cols.pos, y, s);
    text("Leistung", cols.desc, y, s);
    text("Menge", cols.qty, y, { ...s, align: "right" });
    text("Faktor", cols.factor, y, { ...s, align: "right" });
    text("Einzelpreis", cols.unit, y, { ...s, align: "right" });
    text("USt", cols.vat, y, { ...s, align: "right" });
    text("Gesamt", cols.total, y, { ...s, align: "right" });
    y -= 5;
    hr(y, 1.2, rgb(0.45, 0.45, 0.45));
    y -= 13;
  };
  tableHeader();
  lines.forEach((l, i) => {
    const d = wrap(l.description, descW, 9.5);
    const h = d.length * 12 + 6;
    if (ensure(h + 10)) tableHeader();
    text(String(i + 1), cols.pos, y, { size: 9.5 });
    d.forEach((dl, k) => text(dl, cols.desc, y - k * 12, { size: 9.5 }));
    text(qtyDe(l.quantity), cols.qty, y, { size: 9.5, align: "right" });
    text(qtyDe(l.factor), cols.factor, y, { size: 9.5, align: "right" });
    text(money(l.unitPriceCents), cols.unit, y, { size: 9.5, align: "right" });
    text(`${l.vatRate} %`, cols.vat, y, { size: 9.5, align: "right" });
    text(money(l.totalCents), cols.total, y, { size: 9.5, align: "right" });
    y -= (d.length - 1) * 12 + 5;
    hr(y);
    y -= 13;
  });

  // ── Summen ──
  const totals = computeTotals(lines);
  const open = inv.totalCents - inv.paidCents;
  const sumRows: { l: string; v: string; strong?: boolean; big?: boolean; rule?: boolean }[] = [];
  for (const g of totals.groups) {
    sumRows.push({ l: `Netto ${g.rate} %`, v: money(g.netCents) });
    if (g.rate) sumRows.push({ l: `USt ${g.rate} %`, v: money(g.vatCents) });
  }
  sumRows.push({ l: "Gesamtbetrag", v: money(inv.totalCents), strong: true, big: true, rule: true });
  if (inv.paidCents !== 0) sumRows.push({ l: inv.kind === "credit_note" ? "erstattet/verrechnet" : "bezahlt", v: money(inv.paidCents) });
  if (inv.status !== "cancelled" && open !== 0) sumRows.push({ l: open < 0 ? "zu erstatten" : "offen", v: money(Math.abs(open)), strong: true });
  ensure(sumRows.length * 14 + 10);
  y -= 4;
  const sx = ML + width - 230;
  for (const r of sumRows) {
    if (r.rule) {
      page.drawLine({ start: { x: sx, y: y + 10 }, end: { x: ML + width, y: y + 10 }, thickness: 1, color: rgb(0.45, 0.45, 0.45) });
      y -= 3;
    }
    text(r.l, sx, y, { size: 10, font: r.strong ? bold : regular });
    text(r.v, ML + width, y, { size: r.big ? 12 : 10, font: r.strong ? bold : regular, align: "right" });
    y -= r.big ? 16 : 14;
  }

  // ── Zahlungen ──
  if (data.payments.length) {
    y -= 8;
    ensure(20 + data.payments.length * 13);
    text("ZAHLUNGEN", ML, y, { size: 7.5, font: bold, color: GRAY });
    y -= 13;
    for (const pay of data.payments) {
      ensure(13);
      text(`${dateTimeDe(pay.paidAt)} · ${PAYMENT_METHOD_LABEL[pay.method] ?? pay.method}${pay.voucherCode ? ` ${pay.voucherCode}` : ""}`, ML, y, { size: 9.5 });
      text(money(pay.amountCents), ML + width, y, { size: 9.5, align: "right" });
      y -= 13;
    }
    if (inv.kind === "receipt" && inv.status === "paid") {
      text("Betrag dankend erhalten.", ML, y - 2, { size: 10, font: bold });
      y -= 15;
    }
  }

  // ── Hinweise ──
  const notes: string[] = [];
  if (o.smallBusiness) notes.push(NOTE_SMALL_BUSINESS);
  if (hasExemptNote(o, inv, lines)) notes.push(NOTE_VAT_EXEMPT);
  if (inv.kind === "no_show_fee") notes.push(NOTE_NO_SHOW);
  const pub = publicNotes(inv.notes);
  if (pub) notes.push(pub);
  if (showsDueDate(inv) && o.iban) {
    notes.push(`Bitte überweisen Sie den Betrag bis zum ${dateDe(inv.dueAt)} unter Angabe der Rechnungsnummer ${inv.number} auf das unten genannte Konto.`);
  }
  if (notes.length) y -= 10;
  for (const n of notes) {
    const wl = wrap(n, width, 9);
    ensure(wl.length * 11.5 + 4);
    for (const l of wl) {
      text(l, ML, y, { size: 9 });
      y -= 11.5;
    }
    y -= 4;
  }

  // ── Fußzeile (jede Seite) ──
  const pages = doc.getPages();
  const footer = [
    [o.legalName ?? o.name, o.street, [o.zip, o.city].filter(Boolean).join(" ")],
    [o.phone ? `Tel. ${o.phone}` : null, o.email],
    [o.taxNumber ? `Steuernummer: ${o.taxNumber}` : null, o.vatId ? `USt-IdNr.: ${o.vatId}` : null, o.iban ? `IBAN: ${formatIban(o.iban)}` : null],
  ].map((c) => c.filter((v): v is string => !!v));
  pages.forEach((pg, i) => {
    page = pg;
    hr(FOOTER_TOP - 22);
    footer.forEach((col, ci) => {
      col.forEach((l, li) => text(l, ML + ci * (width / 3), FOOTER_TOP - 34 - li * 10, { size: 7.5, color: GRAY, font: ci === 0 && li === 0 ? bold : regular }));
    });
    if (pages.length > 1) text(`Seite ${i + 1} von ${pages.length}`, ML + width, 30, { size: 7.5, color: GRAY, align: "right" });
  });

  return doc.save();
}

export function invoicePdfFilename(inv: { number: string | null; id: string }) {
  return `${(inv.number ?? inv.id).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
