/**
 * Gemeinsame Bausteine für Briefe als PDF (pdf-lib, ohne Server-Importe): Rechnung/Quittung (invoice-pdf.ts)
 * und Mahnung (dunning-pdf.ts) teilen Seitenmaße, Schrift-Ersetzung, Zeilenumbruch, Logo, QR-Code und Fußzeile.
 */
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { formatIban } from "./invoice-view";
import { shortUrl } from "./practice-documents";

export type PdfImage = { bytes: Uint8Array; mime: string };

export const A4: [number, number] = [595.28, 841.89];
export const ML = 50;
export const MR = 50;
export const TOP = 805;
export const FOOTER_TOP = 125;
/** Folgeseiten: Kopfzeile (Praxisname, Beleg und „Seite X von Y“) bei TOP, Inhalt beginnt darunter. */
export const CONT_TOP = TOP - 26;
/** Nutzbare Höhe einer Folgeseite – Blöcke bis zu dieser Höhe werden nie getrennt. */
export const PAGE_BODY = CONT_TOP - FOOTER_TOP;
export const CONTENT_WIDTH = A4[0] - ML - MR;
export const RIGHT = ML + CONTENT_WIDTH;
export const BLACK = rgb(0, 0, 0);
export const GRAY = rgb(0.35, 0.35, 0.35);
export const LIGHT = rgb(0.5, 0.5, 0.5);
export const RULE = rgb(0.6, 0.6, 0.6);
export const HEAD_FILL = rgb(0.9, 0.9, 0.9);

export type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont };

export async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
}

export async function embedImage(doc: PDFDocument, img: PdfImage | null | undefined): Promise<PDFImage | null> {
  if (!img?.bytes?.length) return null;
  try {
    return img.mime === "image/jpeg" ? await doc.embedJpg(img.bytes) : await doc.embedPng(img.bytes);
  } catch {
    // defekte Datei: Beleg trotzdem erzeugen (ohne Logo)
    return null;
  }
}

/** Ersetzt Zeichen, die die Standardschrift (WinAnsi) nicht darstellen kann. */
export function makeSafe(font: PDFFont) {
  const charset = new Set(font.getCharacterSet());
  return (s: string) =>
    [...s.replace(/\r\n?/g, "\n").normalize("NFC")]
      .map((c) => {
        if (c === "\t") return " ";
        // Zeilenumbrüche bleiben erhalten (wrap teilt daran Absätze auf)
        if (c === "\n") return c;
        const cp = c.codePointAt(0)!;
        if (charset.has(cp)) return c;
        if (c === " " || c === " ") return " ";
        return "?";
      })
      .join("");
}

export type TextOpts = { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; align?: "left" | "right" | "center" };

/** Zeichenfunktionen auf der jeweils aktuellen Seite (`getPage`). */
export function makeWriter(getPage: () => PDFPage, fonts: Fonts, safe: (s: string) => string) {
  const { regular } = fonts;
  const text = (t: string, x: number, yy: number, opts: TextOpts = {}) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const s = safe(t).replaceAll("\n", " ");
    const w = font.widthOfTextAtSize(s, size);
    const xx = opts.align === "right" ? x - w : opts.align === "center" ? x - w / 2 : x;
    getPage().drawText(s, { x: xx, y: yy, size, font, color: opts.color ?? BLACK });
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
    getPage().drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  const box = (x: number, yTop: number, w: number, h: number, fill?: ReturnType<typeof rgb>) =>
    getPage().drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: RULE, borderWidth: 0.6, ...(fill ? { color: fill } : {}) });
  /** Bild in maxW×maxH einpassen, Oberkante bei yTop; gibt die Höhe zurück */
  const image = (img: PDFImage, yTop: number, maxW: number, maxH: number, at: "center" | "right") => {
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const x = at === "center" ? (A4[0] - w) / 2 : RIGHT - w;
    getPage().drawImage(img, { x, y: yTop - h, width: w, height: h });
    return h;
  };
  /** QR-Code als Vektorgrafik (scharf in jeder Druckgröße), Fehlerkorrektur M (EPC-Vorgabe) */
  const qr = (payload: string, x: number, yTop: number, size: number) => {
    const code = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = code.modules.size;
    const quiet = 2;
    const cell = size / (n + quiet * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (code.modules.get(r, c)) getPage().drawRectangle({ x: x + (c + quiet) * cell, y: yTop - (r + quiet + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: BLACK });
      }
    }
  };
  return { text, clip, wrap, line, box, image, qr };
}
export type Writer = ReturnType<typeof makeWriter>;

export type LetterOrg = {
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
  bic?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
  website?: string | null;
  qualification?: string | null;
  whatsapp?: boolean;
};

/**
 * Briefkopf: vollständiges Logo zentriert; Quittungen: Zeichen dezent oben rechts und Praxisname links;
 * ohne Logo der Praxisname. Gibt die neue Schreibposition zurück.
 */
export function drawLogoHead(w: Writer, fonts: Fonts, y: number, opts: { full: PDFImage | null; compact: PDFImage | null; receiptLike?: boolean; orgName: string }): number {
  const { full, compact } = opts;
  if (opts.receiptLike && (compact || full)) {
    const img = (compact ?? full)!;
    const h = w.image(img, y, compact ? 60 : 140, compact ? 44 : 40, "right");
    w.text(opts.orgName, ML, y - 16, { size: 14, font: fonts.bold });
    return y - (Math.max(h, 24) + 22);
  }
  if (full || compact) {
    const h = full ? w.image(full, y, 230, 78, "center") : w.image(compact!, y, 70, 56, "center");
    return y - (h + 26);
  }
  w.text(opts.orgName, A4[0] / 2, y - 14, { size: 16, font: fonts.bold, align: "center" });
  return y - 42;
}

/**
 * Empfängeranschrift links (mit kleiner Absenderzeile) und rechts ein Kasten mit Belegdaten und dem Block
 * „Terminvereinbarung“. Gibt die neue Schreibposition (y) zurück.
 */
export function drawAddressBlock(
  w: Writer,
  fonts: Fonts,
  safe: (s: string) => string,
  y: number,
  opts: { senderLine: string; recipientLines: string[]; meta: [string, string][]; boldMeta?: (label: string) => boolean; org: Pick<LetterOrg, "phone" | "email" | "whatsapp"> },
): number {
  const { regular, bold } = fonts;
  const boxX = ML + CONTENT_WIDTH * 0.58;
  const boxW = RIGHT - boxX;
  const slSize = 6.5;
  const slMax = boxX - ML - 16;
  let slText = safe(opts.senderLine.replaceAll(" · ", " - "));
  while (regular.widthOfTextAtSize(slText, slSize) > slMax && slText.length > 10) slText = slText.slice(0, -2);
  const slW = w.text(slText, ML, y - 8, { size: slSize, color: GRAY });
  w.line(ML, y - 9.5, ML + slW, y - 9.5, 0.3, GRAY);
  let ly = y - 24;
  for (const l of opts.recipientLines) {
    for (const wl of w.wrap(l, slMax, 11)) {
      w.text(wl, ML, ly, { size: 11 });
      ly -= 14;
    }
  }
  const o = opts.org;
  const contact: string[] = [];
  if (o.phone) contact.push(`Tel. ${o.phone}${o.whatsapp ? " (auch WhatsApp)" : ""}`);
  if (o.email) contact.push(o.email);
  const rowH = 13;
  const boxH = 8 + opts.meta.length * rowH + (contact.length ? 10 + rowH + contact.length * rowH : 0) + 2;
  w.box(boxX, y, boxW, boxH);
  let by = y - 13;
  const labelW = 82;
  for (const [l, v] of opts.meta) {
    w.text(l, boxX + 6, by, { size: 8.5 });
    w.text(v, boxX + 6 + labelW, by, { size: 9.5, font: opts.boldMeta?.(l) ? bold : regular });
    by -= rowH;
  }
  if (contact.length) {
    by -= 10;
    const tw = w.text("Terminvereinbarung", boxX + 6, by, { size: 8.5 });
    w.line(boxX + 6, by - 1.5, boxX + 6 + tw, by - 1.5, 0.4, BLACK);
    by -= rowH;
    for (const c of contact) {
      for (const wlLine of w.wrap(c, boxW - 12, 8.5).slice(0, 2)) {
        w.text(wlLine, boxX + 6, by, { size: 8.5 });
        by -= rowH;
      }
    }
  }
  return Math.min(ly, y - boxH) - 26;
}

/** QR-Blöcke nebeneinander (GiroCode, Terminbuchung). Gibt die neue Schreibposition zurück. */
export function drawQrBlocks(w: Writer, fonts: Fonts, y: number, blocks: { title: string; sub: string[]; payload: string }[]): number {
  const qrSize = 78;
  const colWidth = CONTENT_WIDTH / 2;
  blocks.forEach((bl, i) => {
    const x = ML + i * colWidth;
    w.qr(bl.payload, x, y, qrSize);
    const tx = x + qrSize + 8;
    const maxW = colWidth - qrSize - 14;
    let ty = y - 18;
    for (const tl of w.wrap(bl.title, maxW, 9, fonts.bold)) {
      w.text(tl, tx, ty, { size: 9, font: fonts.bold });
      ty -= 11.5;
    }
    for (const s of bl.sub) {
      for (const sl2 of w.wrap(s, maxW, 8.5)) {
        w.text(sl2, tx, ty, { size: 8.5, color: GRAY });
        ty -= 11;
      }
    }
  });
  return y - (qrSize + 6);
}

/**
 * Fußzeile auf jeder Seite: Praxis/Anschrift, Bank/Steuer, Telefon/Website, Berufsbezeichnung.
 * Bei mehr als einer Seite zusätzlich „Seite X von Y“ unten rechts und auf Folgeseiten eine Kopfzeile
 * (Praxisname links, `runningHead` – Seite X von Y rechts). Bei nur einer Seite keine Seitenangabe.
 */
export function drawFooters(doc: PDFDocument, fonts: Fonts, safe: (s: string) => string, o: LetterOrg, runningHead?: string) {
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
    const w = makeWriter(() => pg, fonts, safe);
    const top = FOOTER_TOP - 14;
    const rx = ML + CONTENT_WIDTH * 0.6;
    // Spaltenbreiten begrenzen: lange Namen/Banken werden gekürzt statt über den Rand zu laufen
    left.slice(0, 5).forEach((l, li) => w.text(w.clip(l, rx - ML - 12, 7), ML, top - li * 9, { size: 7, color: LIGHT }));
    right.slice(0, 6).forEach(([k, v], li) => {
      w.text(k, rx, top - li * 9, { size: 7, color: LIGHT });
      w.text(w.clip(v, RIGHT - rx - 52, 7), rx + 52, top - li * 9, { size: 7, color: LIGHT });
    });
    const cy = top - Math.max(Math.min(left.length, 5), Math.min(right.length, 6), 3) * 9 - 6;
    center.forEach((c, ci) => w.text(c, A4[0] / 2, cy - ci * 11, { size: 9, color: GRAY, align: "center" }));
    if (o.qualification) {
      // bei Seitenangabe unten rechts schmaler, damit sich beides nicht überlagert
      w.wrap(o.qualification, pages.length > 1 ? CONTENT_WIDTH - 150 : CONTENT_WIDTH, 7, fonts.italic)
        .slice(0, 2)
        .forEach((q, qi) => w.text(q, A4[0] / 2, cy - center.length * 11 - 3 - qi * 9, { size: 7, font: fonts.italic, color: LIGHT, align: "center" }));
    }
    if (pages.length > 1) {
      const mark = `Seite ${i + 1} von ${pages.length}`;
      w.text(mark, RIGHT, 18, { size: 7, color: LIGHT, align: "right" });
      if (i > 0) {
        const head = runningHead ? `${runningHead} – ${mark}` : mark;
        const hw = w.text(head, RIGHT, TOP, { size: 8, color: GRAY, align: "right" });
        w.text(w.clip(o.name, CONTENT_WIDTH - hw - 16, 8, fonts.bold), ML, TOP, { size: 8, font: fonts.bold, color: GRAY });
        w.line(ML, TOP - 5, RIGHT, TOP - 5, 0.4);
      }
    }
  });
}
