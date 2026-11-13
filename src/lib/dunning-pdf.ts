/**
 * PDF einer Zahlungserinnerung / Mahnung (pdf-lib, reine Funktion ohne Server-Importe).
 * Gleicher Briefkopf, Anschriftenblock, GiroCode und Fußzeile wie die Rechnung (src/lib/pdf-letter.ts).
 * Inhalte stammen aus der gespeicherten Mahnung: Text, offener Betrag, Gebühren, Fristen sowie Briefkopf,
 * Bankverbindung und Empfängeranschrift (Schnappschuss beim Erstellen). Nur die Logos werden aktuell geladen.
 * Der Platzhalter {frist} im Text wird hier aus pay_by ersetzt.
 */
import { PDFDocument, type PDFPage } from "pdf-lib";
import { DUNNING_STAGE_LABEL, DUNNING_STAGE_TITLE, dunningTotalCents, fillTemplate, type DunningStage } from "./dunning";
import { epcPayload, isValidIban } from "./epc-qr";
import { dateDe, money } from "./format";
import { invoiceRecipient, senderLine } from "./invoice-view";
import {
  A4,
  CONT_TOP,
  CONTENT_WIDTH,
  drawAddressBlock,
  drawFooters,
  drawLogoHead,
  drawQrBlocks,
  embedFonts,
  embedImage,
  FOOTER_TOP,
  makeSafe,
  makeWriter,
  ML,
  PAGE_BODY,
  RIGHT,
  TOP,
  type LetterOrg,
  type PdfImage,
} from "./pdf-letter";

export type DunningPdfData = {
  dunning: {
    id: string;
    stage: DunningStage;
    letterDate: string;
    payBy: string;
    openCents: number;
    feesTotalCents: number;
    body: string;
    /** Gebühren dieser und früherer Stufen (für die Aufstellung) */
    fees: { stage: DunningStage; feeCents: number }[];
  };
  invoice: { number: string | null; issuedAt: string | null; dueAt: string | null; totalCents: number };
  organization: LetterOrg & { smallBusiness?: boolean };
  patient: { number: number; salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string; street?: string | null; zip?: string | null; city?: string | null } | null;
  billingContact: { name: string; street: string | null; zip: string | null; city: string | null } | null;
  logos?: { full?: PdfImage | null; compact?: PdfImage | null };
};

export const dunningTitle = (d: { stage: DunningStage }, inv: { number: string | null }) => `${DUNNING_STAGE_LABEL[d.stage]} zur Rechnung ${inv.number ?? ""}`.trim();

export async function renderDunningPdf(data: DunningPdfData): Promise<Uint8Array> {
  const { dunning: d, invoice: inv, organization: o } = data;
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const { bold } = fonts;
  const safe = makeSafe(fonts.regular);
  doc.setTitle(safe(dunningTitle(d, inv)));
  doc.setAuthor(safe(o.legalName ?? o.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");

  let page: PDFPage = doc.addPage(A4);
  let y = TOP;
  const w = makeWriter(() => page, fonts, safe);
  // Folgeseiten beginnen unter der Kopfzeile (Praxisname, Mahnung, „Seite X von Y“ – drawFooters)
  const ensure = (h: number) => {
    if (y - h < FOOTER_TOP) {
      page = doc.addPage(A4);
      y = CONT_TOP;
    }
  };
  /** Block zusammenhalten (ggf. komplett auf die nächste Seite), sofern er auf eine Seite passt; höhere Blöcke zeilenweise */
  const keep = (h: number) => (h <= PAGE_BODY ? ensure(h) : undefined);

  y = drawLogoHead(w, fonts, y, { full: await embedImage(doc, data.logos?.full), compact: await embedImage(doc, data.logos?.compact), orgName: o.name });

  const r = invoiceRecipient(data.patient, data.billingContact);
  const meta: [string, string][] = [
    ["Datum:", dateDe(d.letterDate)],
    ["Rechnungsnummer:", inv.number ?? ""],
    ["Rechnungsdatum:", dateDe(inv.issuedAt)],
  ];
  if (data.patient) meta.push(["Patientennummer:", String(data.patient.number)]);
  meta.push(["Zahlbar bis:", dateDe(d.payBy)]);
  y = drawAddressBlock(w, fonts, safe, y, {
    senderLine: senderLine({ ...o, smallBusiness: !!o.smallBusiness }),
    recipientLines: [r.name, r.care ? `für ${r.care}` : null, r.street, r.city || null].filter((v): v is string => !!v),
    meta,
    boldMeta: (l) => l.startsWith("Zahlbar"),
    org: o,
  });

  w.text(DUNNING_STAGE_TITLE[d.stage], ML, y, { size: 12.5, font: bold });
  y -= 15;
  w.text(`zur Rechnung ${inv.number ?? ""} vom ${dateDe(inv.issuedAt)} (zahlbar bis ${dateDe(inv.dueAt)})`, ML, y, { size: 9.5 });
  y -= 22;

  for (const l of w.wrap(fillTemplate(d.body, { frist: dateDe(d.payBy) }), CONTENT_WIDTH, 10)) {
    ensure(13);
    if (l) w.text(l, ML, y, { size: 10 });
    y -= 13;
  }
  y -= 10;

  // ── Aufstellung ──
  const total = dunningTotalCents(d.openCents, d.feesTotalCents);
  const paid = inv.totalCents - d.openCents;
  const rows: { l: string; v: number; strong?: boolean }[] = [{ l: `Rechnungsbetrag ${inv.number ?? ""}`, v: inv.totalCents }];
  if (paid > 0) rows.push({ l: "bereits bezahlt", v: -paid });
  if (paid > 0 || d.feesTotalCents > 0) rows.push({ l: "offener Rechnungsbetrag", v: d.openCents });
  for (const f of d.fees.filter((x) => x.feeCents > 0)) rows.push({ l: `Mahngebühr ${DUNNING_STAGE_LABEL[f.stage]}`, v: f.feeCents });
  rows.push({ l: "zu zahlen", v: total, strong: true });
  keep(rows.length * 14 + 10);
  const labelX = ML + CONTENT_WIDTH * 0.45;
  for (const row of rows) {
    ensure(14);
    if (row.strong) w.box(labelX, y, RIGHT - labelX, 14);
    w.text(row.l, RIGHT - 80, y - 10, { size: 9, font: row.strong ? bold : fonts.regular, align: "right" });
    w.text(money(row.v), RIGHT - 4, y - 10, { size: 9, font: row.strong ? bold : fonts.regular, align: "right" });
    y -= 14;
  }
  y -= 14;

  // ── Hinweise ──
  const notes: string[] = [];
  if (d.feesTotalCents > 0) notes.push("Die Mahngebühren sind Ersatz der uns entstandenen Kosten (Verzugsschaden), nicht Teil der Rechnung und nicht umsatzsteuerbar.");
  const giro = isValidIban(o.iban)
    ? epcPayload({ name: o.accountHolder?.trim() || o.legalName?.trim() || o.name, iban: o.iban ?? "", bic: o.bic, amountCents: total, remittance: `Rechnung ${inv.number ?? ""}` })
    : null;
  if (o.iban) notes.push(`Bitte überweisen Sie ${money(total)} bis zum ${dateDe(d.payBy)} unter Angabe der Rechnungsnummer ${inv.number ?? ""} auf das unten genannte Konto.`);
  else notes.push(`Bitte zahlen Sie ${money(total)} bis zum ${dateDe(d.payBy)}.`);
  if (giro) notes.push("Tipp: Scannen Sie den GiroCode mit Ihrer Banking-App – Empfänger, Betrag und Verwendungszweck sind dann schon ausgefüllt.");
  keep(notes.reduce((h, n) => h + w.wrap(n, CONTENT_WIDTH, 9.5).length * 12.5 + 2, 0));
  for (const n of notes) {
    const wl = w.wrap(n, CONTENT_WIDTH, 9.5);
    keep(wl.length * 12.5 + 2);
    for (const l of wl) {
      ensure(12.5);
      w.text(l, ML, y, { size: 9.5 });
      y -= 12.5;
    }
    y -= 2;
  }
  y -= 8;
  ensure(40);
  w.text("Mit freundlichen Grüßen", ML, y, { size: 10 });
  y -= 14;
  w.text(o.legalName ?? o.name, ML, y, { size: 10 });
  y -= 10;

  if (giro) {
    y -= 10;
    ensure(78 + 10);
    const holder = (o.accountHolder?.trim() || o.legalName?.trim() || o.name).slice(0, 70);
    y = drawQrBlocks(w, fonts, y, [{ title: "Bezahlen per GiroCode", sub: [`${money(total)} an ${holder}`, `Verwendungszweck: Rechnung ${inv.number ?? ""}`], payload: giro }]);
  }

  drawFooters(doc, fonts, safe, o, dunningTitle(d, inv));
  return doc.save();
}

export function dunningPdfFilename(d: { stage: DunningStage }, inv: { number: string | null; id: string }) {
  const stage = { reminder: "Zahlungserinnerung", dunning1: "Mahnung-1", dunning2: "Mahnung-2" }[d.stage];
  return `${stage}_${(inv.number ?? inv.id).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
}
