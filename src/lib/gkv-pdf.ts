/**
 * PDF-Dokumente zur GKV-Verordnung (pdf-lib, reine Funktionen ohne Server-Importe): Leistungsnachweis mit Unterschriften
 * je Behandlung (GKV Paket B). Briefkopf/Fußzeile wie Rechnungen (src/lib/pdf-letter.ts).
 */
import { PDFDocument, type PDFImage, type PDFPage } from "pdf-lib";
import { dateDe, dateTimeDe } from "./format";
import {
  A4,
  CONT_TOP,
  CONTENT_WIDTH,
  drawFooters,
  drawLogoHead,
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
  type LetterOrg,
  type PdfImage,
  type Writer,
} from "./pdf-letter";

export type GkvPdfOrg = LetterOrg & { ik?: string | null };
export type GkvPdfPatient = { name: string; birthDate: string | null; insuranceNumber: string | null; insurerName: string | null; insurerIk: string | null; number?: number | null };
export type GkvPdfPrescription = {
  issuedAt: string;
  doctorName: string | null;
  doctorLanr: string | null;
  doctorBsnr: string | null;
  diagnosisGroup: string;
  icd10: string | null;
  icd10Second?: string | null;
  diagnosisText?: string | null;
  units: number;
  positions: { position?: string; label: string; units: number }[];
};

type Page = { page: PDFPage; y: number };

/** Grundgerüst: Dokument, Schriften, Kopf mit Logo, Seitenumbruch */
async function setup(title: string, org: GkvPdfOrg, logos?: { full?: PdfImage | null; compact?: PdfImage | null } | null) {
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const safe = makeSafe(fonts.regular);
  doc.setTitle(safe(title));
  doc.setAuthor(safe(org.legalName ?? org.name));
  doc.setCreator("PodoHero");
  doc.setProducer("PodoHero (pdf-lib)");
  const full = await embedImage(doc, logos?.full);
  const compact = await embedImage(doc, logos?.compact);
  const cur: Page = { page: doc.addPage(A4), y: TOP };
  const w = makeWriter(() => cur.page, fonts, safe);
  cur.y = drawLogoHead(w, fonts, cur.y, { full, compact, receiptLike: true, orgName: org.name });
  const ensure = (h: number) => {
    if (cur.y - h < FOOTER_TOP) {
      cur.page = doc.addPage(A4);
      cur.y = CONT_TOP;
      return true;
    }
    return false;
  };
  return { doc, fonts, safe, w, cur, ensure };
}

/** Block „Praxis / Patient:in / Verordnung“ als Schlüssel-Wert-Zeilen (zweispaltig) */
function infoBlock(w: Writer, fonts: Awaited<ReturnType<typeof embedFonts>>, cur: Page, ensure: (h: number) => boolean, rows: [string, string][]) {
  for (const [k, v] of rows) {
    const lines = w.wrap(v || "–", CONTENT_WIDTH - 130, 9.5);
    ensure(lines.length * 12 + 2);
    w.text(k, ML, cur.y, { size: 9, color: GRAY });
    for (const l of lines) {
      w.text(l, ML + 130, cur.y, { size: 9.5, font: k.endsWith(":") ? fonts.regular : fonts.bold });
      cur.y -= 12;
    }
  }
}

export function prescriptionRows(org: GkvPdfOrg, p: GkvPdfPatient, vo: GkvPdfPrescription): [string, string][] {
  return [
    ["Praxis:", [org.legalName || org.name, org.ik ? `IK ${org.ik}` : null].filter(Boolean).join(" · ")],
    ["Patient:in:", [p.name, p.birthDate ? `geb. ${dateDe(p.birthDate)}` : null].filter(Boolean).join(" · ")],
    ["Krankenkasse:", [p.insurerName, p.insurerIk ? `IK ${p.insurerIk}` : null, p.insuranceNumber ? `Vers.-Nr. ${p.insuranceNumber}` : null].filter(Boolean).join(" · ")],
    ["Verordnung:", [`vom ${dateDe(vo.issuedAt)}`, vo.doctorName, vo.doctorLanr ? `LANR ${vo.doctorLanr}` : null, vo.doctorBsnr ? `BSNR ${vo.doctorBsnr}` : null].filter(Boolean).join(" · ")],
    ["Diagnose:", [vo.diagnosisGroup, vo.icd10, vo.icd10Second, vo.diagnosisText].filter(Boolean).join(" · ")],
    ["Heilmittel:", vo.positions.map((x) => `${x.position ? `${x.position} ` : ""}${x.label} × ${x.units}`).join(", ") || `${vo.units} Einheiten`],
  ];
}

export type ProofPdfRow = {
  date: string;
  /** z. B. „78020 × 1, 79933 × 1“ */
  positions: string;
  units: number;
  signature: { kind: "device" | "paper"; image?: Uint8Array | null; signerName: string | null; roleLabel: string | null; signedAt: Date } | null;
};

/**
 * Leistungsnachweis je Verordnung: Tabelle aller Behandlungen (Datum, Position, Einheiten, Unterschrift als Bild bzw.
 * Vermerk „auf der Papier-Verordnung“). Zum Ausdruck und Beilegen zur Abrechnung.
 */
export async function renderProofPdf(input: { organization: GkvPdfOrg; logos?: { full?: PdfImage | null; compact?: PdfImage | null } | null; patient: GkvPdfPatient; prescription: GkvPdfPrescription; rows: ProofPdfRow[]; generatedAt: Date }): Promise<Uint8Array> {
  const title = `Leistungsnachweis Verordnung vom ${dateDe(input.prescription.issuedAt)}`;
  const { doc, fonts, safe, w, cur, ensure } = await setup(title, input.organization, input.logos);
  w.text("Leistungsnachweis – Bestätigung der Behandlungen", ML, cur.y, { size: 14, font: fonts.bold });
  cur.y -= 20;
  infoBlock(w, fonts, cur, ensure, prescriptionRows(input.organization, input.patient, input.prescription));
  cur.y -= 10;

  const col = { nr: ML, date: ML + 24, pos: ML + 90, units: ML + 240, sig: ML + 262, who: ML + 412 };
  const head = () => {
    ensure(20);
    w.box(ML, cur.y + 10, CONTENT_WIDTH, 16, HEAD_FILL);
    const ty = cur.y - 1;
    w.text("Nr.", col.nr + 2, ty, { size: 8, font: fonts.bold });
    w.text("Datum", col.date, ty, { size: 8, font: fonts.bold });
    w.text("Position(en)", col.pos, ty, { size: 8, font: fonts.bold });
    w.text("Einh.", col.units + 16, ty, { size: 8, font: fonts.bold, align: "right" });
    w.text("Unterschrift", col.sig, ty, { size: 8, font: fonts.bold });
    w.text("Unterschrieben von", col.who, ty, { size: 8, font: fonts.bold });
    cur.y -= 18;
  };
  head();
  const images = new Map<number, PDFImage>();
  for (const [i, r] of input.rows.entries()) {
    if (r.signature?.image) {
      try {
        images.set(i, await doc.embedPng(r.signature.image));
      } catch {
        // beschädigtes Bild: Zeile zeigt den Hinweis statt des Bildes
      }
    }
  }
  const rowH = 46;
  input.rows.forEach((r, i) => {
    if (ensure(rowH)) head();
    const top = cur.y;
    w.text(String(i + 1), col.nr + 2, top - 10, { size: 9 });
    w.text(dateDe(r.date), col.date, top - 10, { size: 9 });
    w.wrap(r.positions || "–", col.units - col.pos - 18, 8.5).slice(0, 3).forEach((l, li) => w.text(l, col.pos, top - 10 - li * 10, { size: 8.5 }));
    w.text(String(r.units), col.units + 16, top - 10, { size: 9, align: "right" });
    const img = images.get(i);
    if (img) {
      const scale = Math.min(140 / img.width, 38 / img.height);
      cur.page.drawImage(img, { x: col.sig, y: top - 4 - img.height * scale, width: img.width * scale, height: img.height * scale });
    } else {
      const t = r.signature?.kind === "paper" ? "auf der Papier-Verordnung (Rückseite)" : r.signature ? "Bild nicht lesbar" : "Unterschrift fehlt";
      w.wrap(t, 140, 8).forEach((l, li) => w.text(l, col.sig, top - 10 - li * 10, { size: 8, color: GRAY, font: r.signature ? fonts.regular : fonts.bold }));
    }
    if (r.signature) {
      const who = [r.signature.signerName, r.signature.roleLabel].filter(Boolean).join(", ");
      w.wrap(who || "–", RIGHT - col.who, 8).slice(0, 2).forEach((l, li) => w.text(l, col.who, top - 10 - li * 10, { size: 8 }));
      w.text(dateTimeDe(r.signature.signedAt), col.who, top - 32, { size: 7, color: GRAY });
    }
    w.line(ML, top - rowH + 6, RIGHT, top - rowH + 6, 0.3);
    cur.y -= rowH;
  });
  if (!input.rows.length) {
    w.text("Noch keine Behandlung auf diese Verordnung dokumentiert.", ML, cur.y - 4, { size: 9.5 });
    cur.y -= 20;
  }
  const total = input.rows.reduce((s, r) => s + r.units, 0);
  ensure(40);
  cur.y -= 6;
  w.text(`${input.rows.length} ${input.rows.length === 1 ? "Behandlungstag" : "Behandlungstage"} · ${total} Einheiten von ${input.prescription.units} verordneten`, ML, cur.y, { size: 9, font: fonts.bold });
  cur.y -= 14;
  for (const l of w.wrap("Mit der Unterschrift bestätigt die versicherte Person (bzw. Betreuungsperson/Angehörige:r) die Behandlung am angegebenen Tag (Vertrag nach § 125 SGB V Podologie, Anlage 3). Positionen je Tag laut Preis-Snapshot bzw. Zuordnung in zeitlicher Reihenfolge.", CONTENT_WIDTH, 8)) {
    ensure(10);
    w.text(l, ML, cur.y, { size: 8, color: GRAY });
    cur.y -= 10;
  }
  ensure(10);
  w.text(`Erstellt am ${dateTimeDe(input.generatedAt)} mit PodoHero`, ML, cur.y - 2, { size: 7, color: GRAY });
  drawFooters(doc, fonts, safe, input.organization, title);
  return doc.save();
}

/** Fließtext-Absätze mit Seitenumbruch */
function paragraphs(w: Writer, cur: Page, ensure: (h: number) => boolean, items: string[], size = 10) {
  for (const p of items) {
    for (const l of w.wrap(p, CONTENT_WIDTH, size)) {
      ensure(size + 4);
      w.text(l, ML, cur.y, { size });
      cur.y -= size + 4;
    }
    cur.y -= 6;
  }
}

/** Empfänger (Ärztin/Arzt) links, Datum rechts */
function letterHead(w: Writer, fonts: Awaited<ReturnType<typeof embedFonts>>, cur: Page, org: GkvPdfOrg, vo: GkvPdfPrescription, date: string) {
  const sender = [org.legalName || org.name, org.street, [org.zip, org.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  w.text(w.clip(sender, CONTENT_WIDTH * 0.6, 6.5), ML, cur.y, { size: 6.5, color: GRAY });
  cur.y -= 16;
  const to = [vo.doctorName || "An die verordnende Ärztin / den verordnenden Arzt", vo.doctorLanr ? `LANR ${vo.doctorLanr}` : null, vo.doctorBsnr ? `BSNR ${vo.doctorBsnr}` : null].filter((x): x is string => !!x);
  to.forEach((l, i) => w.text(l, ML, cur.y - i * 13, { size: 10.5, font: i === 0 ? fonts.bold : fonts.regular }));
  w.text(`Datum: ${dateDe(date)}`, RIGHT, cur.y, { size: 10, align: "right" });
  cur.y -= to.length * 13 + 22;
}

export type TherapyReportPdfInput = {
  organization: GkvPdfOrg;
  logos?: { full?: PdfImage | null; compact?: PdfImage | null } | null;
  patient: GkvPdfPatient;
  prescription: GkvPdfPrescription;
  report: { reportDate: string; findings: string | null; course: string | null; result: string | null; recommendation: string | null; notes: string | null; author: string | null };
  treatmentDates: string[];
};

/** Therapiebericht (Position 78530) für die verordnende Ärztin/den Arzt: Praxiskopf mit Logo, Person, Verordnung, Datum */
export async function renderTherapyReportPdf(input: TherapyReportPdfInput): Promise<Uint8Array> {
  const title = `Therapiebericht ${input.patient.name} – Verordnung vom ${dateDe(input.prescription.issuedAt)}`;
  const { doc, fonts, safe, w, cur, ensure } = await setup(title, input.organization, input.logos);
  letterHead(w, fonts, cur, input.organization, input.prescription, input.report.reportDate);
  w.text("Therapiebericht Podologie", ML, cur.y, { size: 14, font: fonts.bold });
  cur.y -= 20;
  infoBlock(w, fonts, cur, ensure, prescriptionRows(input.organization, input.patient, input.prescription).slice(1));
  const dates = [...input.treatmentDates].sort();
  infoBlock(w, fonts, cur, ensure, [["Behandlungen:", dates.length ? `${dates.length} (${dateDe(dates[0])}${dates.length > 1 ? ` bis ${dateDe(dates.at(-1)!)}` : ""})` : "–"]]);
  cur.y -= 8;
  const sections: [string, string | null][] = [
    ["Befund", input.report.findings],
    ["Verlauf", input.report.course],
    ["Ergebnis", input.report.result],
    ["Empfehlung", input.report.recommendation],
    ["Weitere Angaben", input.report.notes],
  ];
  for (const [label, text] of sections) {
    if (!text?.trim()) continue;
    ensure(30);
    w.text(label, ML, cur.y, { size: 11, font: fonts.bold });
    cur.y -= 15;
    paragraphs(w, cur, ensure, [text.trim()]);
  }
  ensure(60);
  cur.y -= 24;
  w.line(ML, cur.y, ML + 200, cur.y, 0.5);
  cur.y -= 11;
  w.text([input.report.author, input.organization.qualification].filter(Boolean).join(", ") || input.organization.name, ML, cur.y, { size: 8.5, color: GRAY });
  drawFooters(doc, fonts, safe, input.organization, title);
  return doc.save();
}

/** Anforderung einer Folgeverordnung (Brief an die Ärztin/den Arzt) */
export async function renderFollowUpPdf(input: { organization: GkvPdfOrg; logos?: { full?: PdfImage | null; compact?: PdfImage | null } | null; prescription: GkvPdfPrescription; letter: { subject: string; paragraphs: string[] }; date: string }): Promise<Uint8Array> {
  const { doc, fonts, safe, w, cur, ensure } = await setup(input.letter.subject, input.organization, input.logos);
  letterHead(w, fonts, cur, input.organization, input.prescription, input.date);
  for (const l of w.wrap(input.letter.subject, CONTENT_WIDTH, 12, fonts.bold)) {
    w.text(l, ML, cur.y, { size: 12, font: fonts.bold });
    cur.y -= 16;
  }
  cur.y -= 8;
  paragraphs(w, cur, ensure, input.letter.paragraphs);
  drawFooters(doc, fonts, safe, input.organization, "Anforderung Folgeverordnung");
  return doc.save();
}
