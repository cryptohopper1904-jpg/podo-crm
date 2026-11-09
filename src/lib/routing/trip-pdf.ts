/**
 * Fahrtenbuch-Export als PDF (pdf-lib, reine Funktion): Monatsliste mit Summen und Hinweis
 * „Hilfe – kein finanzamtsfestes elektronisches Fahrtenbuch“. Ziele nur pseudonymisiert.
 */
import { PDFDocument, rgb, StandardFonts, type PDFPage } from "pdf-lib";
import { TRIP_LOG_DISCLAIMER, tripLogRows, type EffectiveTrip } from "./trip-log";
import { kmDe } from "./geo";

const PAGE: [number, number] = [841.89, 595.28]; // A4 quer
const M = 36;
const COLS = [62, 130, 140, 100, 52, 62, 80, 62, 62, 60]; // Summe ≈ 770

export async function renderTripLogPdf(data: {
  practice: string;
  monthLabel: string;
  vehicle: string | null;
  plate: string | null;
  trips: EffectiveTrip[];
  totals: { count: number; distanceM: number; estimated: number };
  createdAt: Date;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = (s: string) => [...s.normalize("NFC")].map((c) => (charset.has(c.codePointAt(0)!) ? c : c === " " || c === " " ? " " : "?")).join("");
  doc.setTitle(safe(`Fahrtenbuch ${data.monthLabel}`));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");

  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - M;
  const text = (s: string, x: number, yy: number, size = 9, f = font, color = rgb(0, 0, 0)) => page.drawText(safe(s), { x, y: yy, size, font: f, color });
  const fit = (s: string, w: number, size = 9) => {
    let t = safe(s);
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > w - 4) t = t.slice(0, -2) + "…";
    return t.replace(/…+$/, "…");
  };

  const header = () => {
    text(`Fahrtenbuch (Hilfe) – ${data.monthLabel}`, M, y, 15, bold);
    y -= 18;
    text(`${data.practice}${data.vehicle ? ` · Fahrzeug: ${data.vehicle}` : ""}${data.plate ? ` · Kennzeichen: ${data.plate}` : ""}`, M, y, 10);
    y -= 22;
  };
  const tableHead = (row: string[]) => {
    let x = M;
    row.forEach((c, i) => {
      text(fit(c, COLS[i], 8), x + 2, y, 8, bold);
      x += COLS[i];
    });
    y -= 4;
    page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
    y -= 12;
  };

  header();
  const [head, ...rows] = tripLogRows(data.trips);
  tableHead(head);
  for (const row of rows) {
    if (y < M + 60) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - M;
      tableHead(head);
    }
    let x = M;
    const voided = row[9] === "storniert";
    row.forEach((c, i) => {
      text(fit(c, COLS[i]), x + 2, y, 9, font, voided ? rgb(0.55, 0.55, 0.55) : rgb(0, 0, 0));
      x += COLS[i];
    });
    y -= 14;
  }
  y -= 6;
  page.drawLine({ start: { x: M, y: y + 10 }, end: { x: PAGE[0] - M, y: y + 10 }, thickness: 0.6, color: rgb(0.6, 0.6, 0.6) });
  text(`Summe: ${data.totals.count} Fahrt(en), ${kmDe(data.totals.distanceM)}${data.totals.estimated ? ` (davon ${data.totals.estimated} geschätzt)` : ""}`, M, y, 10, bold);
  y -= 22;
  // Hinweis umbrechen
  const words = safe(TRIP_LOG_DISCLAIMER).split(" ");
  let line = "";
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(cand, 8) > PAGE[0] - 2 * M) {
      text(line, M, y, 8, font, rgb(0.35, 0.35, 0.35));
      y -= 11;
      line = w;
    } else line = cand;
  }
  if (line) text(line, M, y, 8, font, rgb(0.35, 0.35, 0.35));
  y -= 11;
  text(`Erstellt am ${new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(data.createdAt)} mit PodoHero.`, M, y, 8, font, rgb(0.35, 0.35, 0.35));
  return doc.save();
}
