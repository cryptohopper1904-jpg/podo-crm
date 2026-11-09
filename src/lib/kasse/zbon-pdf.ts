/**
 * Z-Bon (Tagesabschluss) als PDF – pdf-lib, reine Funktion ohne Server-Importe.
 * Schrift: Helvetica (WinAnsi); nicht darstellbare Zeichen werden ersetzt.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { CashClosingTotals, CashClosingTse } from "@/db/schema";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import { PAYMENT_METHOD_LABEL } from "@/lib/invoice-labels";
import { DENOMINATIONS, denominationLabel, MOVEMENT_LABEL, tseLabel, type MovementKind } from "./labels";

export type ZBonData = {
  closing: {
    number: number;
    businessDate: string;
    closedAt: Date;
    createdAt: Date;
    openingCents: number;
    cashPaymentsCents: number;
    movementsCents: number;
    expectedCashCents: number;
    countedCashCents: number;
    differenceCents: number;
    denominations: Record<string, number>;
    totals: CashClosingTotals;
    paymentCount: number;
    movementCount: number;
    firstBonNr: number;
    lastBonNr: number;
    tse: CashClosingTse;
    differenceReason: string | null;
    note: string | null;
    hash: string;
  };
  organization: { name: string; legalName: string | null; street: string | null; zip: string | null; city: string | null; taxNumber: string | null; vatId: string | null };
  createdByName: string | null;
  registerId: string;
  /** Meldung an den TSE-/DSFinV-K-Dienst (nach dem Abschluss) */
  registration?: { closingRef: string; tssSerial: string | null } | null;
  chainOk: boolean;
};

const A4: [number, number] = [595.28, 841.89];
const ML = 50;
const MR = 50;

export async function renderZBonPdf(data: ZBonData): Promise<Uint8Array> {
  const { closing: z, organization: o } = data;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(regular.getCharacterSet());
  const safe = (s: string) =>
    [...s.normalize("NFC")]
      .map((c) => {
        const cp = c.codePointAt(0)!;
        if (charset.has(cp)) return c;
        if (c === "→") return "->";
        if (/\s/.test(c)) return " ";
        return "?";
      })
      .join("");
  doc.setTitle(safe(`Z-Bon Nr. ${z.number} – ${dateDe(z.businessDate)}`));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");

  let page: PDFPage = doc.addPage(A4);
  let y = 790;
  const right = A4[0] - MR;
  const text = (t: string, x: number, opts: { size?: number; font?: PDFFont; align?: "left" | "right"; gray?: boolean } = {}) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const s = safe(t);
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: opts.align === "right" ? x - w : x, y, size, font, color: opts.gray ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0) });
  };
  const ensure = (h: number) => {
    if (y - h < 60) {
      page = doc.addPage(A4);
      y = 790;
    }
  };
  const row = (label: string, value: string, opts: { bold?: boolean } = {}) => {
    ensure(16);
    text(label, ML, { font: opts.bold ? bold : regular });
    text(value, right, { align: "right", font: opts.bold ? bold : regular });
    y -= 15;
  };
  const heading = (t: string) => {
    ensure(34);
    y -= 8;
    text(t, ML, { size: 12, font: bold });
    y -= 6;
    page.drawLine({ start: { x: ML, y }, end: { x: right, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    y -= 14;
  };
  const wrapped = (t: string, size = 9) => {
    const maxW = right - ML;
    let lineText = "";
    for (const word of safe(t).split(/\s+/)) {
      const cand = lineText ? `${lineText} ${word}` : word;
      if (regular.widthOfTextAtSize(cand, size) > maxW && lineText) {
        ensure(13);
        text(lineText, ML, { size });
        y -= 12;
        lineText = word;
      } else lineText = cand;
    }
    if (lineText) {
      ensure(13);
      text(lineText, ML, { size });
      y -= 12;
    }
  };

  // Kopf
  text(o.legalName || o.name, ML, { size: 14, font: bold });
  y -= 16;
  const addr = [o.street, [o.zip, o.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (addr) {
    text(addr, ML, { gray: true });
    y -= 13;
  }
  const tax = [o.taxNumber ? `St.-Nr. ${o.taxNumber}` : null, o.vatId ? `USt-IdNr. ${o.vatId}` : null].filter(Boolean).join(" · ");
  if (tax) {
    text(tax, ML, { gray: true });
    y -= 13;
  }
  y -= 12;
  text(`Z-Bon Nr. ${z.number} – Tagesabschluss`, ML, { size: 18, font: bold });
  y -= 24;
  row("Buchungstag", dateDe(z.businessDate));
  row("Abschluss erstellt", dateTimeDe(z.createdAt));
  row("Erfasst bis (Stichzeitpunkt)", dateTimeDe(z.closedAt));
  row("Kasse", data.registerId);
  row("Belegnummern", z.lastBonNr >= z.firstBonNr ? `${z.firstBonNr} – ${z.lastBonNr}` : "keine Kassenvorgänge");
  if (data.createdByName) row("Erstellt von", data.createdByName);

  heading("Einnahmen je Zahlart");
  const methods = Object.entries(z.totals.byMethod);
  if (!methods.length) row("Keine Zahlungen", money(0));
  for (const [m, cents] of methods) row(`${PAYMENT_METHOD_LABEL[m] ?? m}${m === "transfer" || m === "payment_link" ? " (nicht kassenrelevant)" : ""}`, money(cents));
  row("Summe aller Zahlungen", money(methods.reduce((s, [, c]) => s + c, 0)), { bold: true });

  heading("Umsätze je Steuersatz (Bar, Karte, Gutschein)");
  if (!z.totals.byVat.length) row("Keine Umsätze", money(0));
  for (const v of z.totals.byVat) row(`${v.rate} % – netto ${money(v.netCents)}, USt ${money(v.vatCents)}`, `brutto ${money(v.grossCents)}`);

  heading("Kassenbestand");
  row("Anfangsbestand", money(z.openingCents));
  row("+ Bareinnahmen", money(z.cashPaymentsCents));
  for (const [k, c] of Object.entries(z.totals.movements)) row(`${c >= 0 ? "+" : "-"} ${MOVEMENT_LABEL[k as MovementKind] ?? k}`, money(c));
  row("= Soll-Bestand", money(z.expectedCashCents), { bold: true });
  row("Ist-Bestand (gezählt)", money(z.countedCashCents), { bold: true });
  row("Differenz", money(z.differenceCents), { bold: true });
  if (z.differenceReason) wrapped(`Begründung: ${z.differenceReason}`);

  heading("Zählprotokoll");
  for (const d of DENOMINATIONS) {
    const n = z.denominations[String(d)] ?? 0;
    if (n) row(`${n} × ${denominationLabel(d)}`, money(n * d));
  }
  row("Summe gezählt", money(z.countedCashCents), { bold: true });

  heading("TSE / KassenSichV");
  wrapped(tseLabel(z.tse, data.registration));
  if (z.tse.transactionNumber) wrapped(`Letzte TSE-Transaktion: ${z.tse.transactionNumber} (Signaturzähler ${z.tse.signatureCounter ?? "–"})`);

  if (z.note) {
    heading("Notiz");
    wrapped(z.note);
  }
  heading("Prüfsumme");
  wrapped(`SHA-256 (Hash-Kette): ${z.hash}`, 8);
  wrapped(data.chainOk ? "Hash-Kette und Belegzuordnung geprüft: unverändert." : "WARNUNG: Hash-Kette oder Belegzuordnung stimmt nicht – bitte Support kontaktieren.", 8);
  y -= 6;
  wrapped("Dieser Abschluss ist unveränderbar (GoBD). Korrekturen nur als Gegenbuchung im Folgeabschluss.", 8);
  return doc.save();
}
