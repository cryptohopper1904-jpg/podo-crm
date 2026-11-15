/**
 * Automatische Erkennung hochgeladener Exportdateien über Signaturen: Kopfzeile (Spalten-Kombination), Trennzeichen,
 * erste Zeile und – nur als Bestätigung – Dateiname. Die Kopfzeile entscheidet, damit umbenannte Dateien und
 * „Datei (1).csv“ aus dem Browser trotzdem erkannt werden; BOM ist optional (Excel entfernt sie beim Speichern).
 *
 * Neue Quellen: einen Eintrag in RECOGNIZERS ergänzen (Spalten-Signatur, Art, Hinweis) und den Parser in
 * analyzeFile verdrahten.
 */
import { createHash } from "node:crypto";
import { parseDateLoose, parseDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { parseWorkbook } from "../excel/parse";
import { decimalCents, parseTinanaAppointments, parseTinanaDoctors, parseTinanaInvoices, parseTinanaPatients, parseTinanaPrescriptions } from "./tinana";
import { decodeText, readTable, textSignature, type TextSignature } from "./text";
import type { DetectedFile, FileKind, SourceId } from "./types";
import { isZip } from "./zip";

export interface Recognizer {
  kind: FileKind;
  source: SourceId;
  /** z. B. „Tinana – Patienten“ */
  label: string;
  /** Was in PodoHero daraus wird (Vorschau) */
  target: string;
  /** Kopfzeile passt? (Header normalisiert, klein) */
  match: (sig: TextSignature) => boolean;
  /** Dateiname typisch für diese Quelle (nur Bestätigung/Anzeige) */
  fileName?: RegExp;
  /** info/rejected statt import */
  status?: "info" | "rejected";
  note?: string;
}

const has = (sig: TextSignature, ...cols: string[]) => cols.every((c) => sig.headers.includes(c));
const first = (sig: TextSignature, col: string) => sig.headers[0] === col;

export const RECOGNIZERS: Recognizer[] = [
  {
    kind: "tinana.patients",
    source: "tinana",
    label: "Tinana – Patienten",
    target: "Patient:innen",
    match: (s) => first(s, "patienten_id") && has(s, "nachname", "versicherungstyp", "telefon_1_label"),
    fileName: /^patients_export_\d{4}-\d{2}-\d{2}/i,
  },
  {
    kind: "tinana.appointments",
    source: "tinana",
    label: "Tinana – Termine",
    target: "Termine",
    match: (s) => first(s, "termin_id") && has(s, "patienten_id", "agenda_id", "startzeit", "heilmittel"),
    fileName: /^appointments_export_\d{4}-\d{2}-\d{2}/i,
  },
  {
    kind: "tinana.prescriptions",
    source: "tinana",
    label: "Tinana – Verordnungen",
    target: "Verordnungen",
    match: (s) => first(s, "formulartyp") && has(s, "heilmittel_positionsnummer", "kostentraeger_id", "patient_geburtsdatum"),
    fileName: /^prescriptions_export_\d{4}-\d{2}-\d{2}/i,
  },
  {
    kind: "tinana.doctors",
    source: "tinana",
    label: "Tinana – Ärzt:innen",
    target: "Nachschlagen von Arztnummern",
    match: (s) => first(s, "anrede") && has(s, "arztnummer", "betriebsstaettennummer") && !has(s, "formulartyp") && !has(s, "patienten_id"),
    fileName: /^doctors_export_\d{4}-\d{2}-\d{2}/i,
    status: "info",
    note: "PodoHero hat keine eigene Ärzteliste. Die Datei ergänzt fehlende Arzt- und Betriebsstättennummern in übernommenen Verordnungen.",
  },
  {
    kind: "tinana.invoices",
    source: "tinana",
    label: "Tinana – Rechnungen",
    target: "Archiv (nur Info)",
    match: (s) => first(s, "rechnungsnummer") && has(s, "rechnungswert_nach_korrektur", "positionen", "gesamtbetrag"),
    fileName: /^invoices_export_\d{4}-\d{2}-\d{2}/i,
    status: "info",
    note: "Rechnungen aus Tinana werden nicht als PodoHero-Rechnungen oder Kassenbuchungen angelegt. Die Liste dient zum Zuordnen der Rechnungs-PDFs (ZIP) zu Patient:innen.",
  },
  {
    kind: "tinana.invoice_list",
    source: "tinana",
    label: "Tinana – Rechnungsliste der Kasse",
    target: "nur Abgleich",
    match: (s) => s.headers.join(";") === "rechnungsnr.;datum;empfänger;aussteller;status;art;betrag (eur)",
    fileName: /^rechnungen-\d{4}-\d{2}-\d{2}/i,
    status: "info",
    note: "Die Rechnungsliste der Kasse ist ein Auszug des Rechnungsexports und wird nicht importiert. Für die Rechnungs-PDFs bitte den Datenexport „Rechnungen“ verwenden.",
  },
  // Berichte (Auswertungen) erkennen und mit Hinweis ablehnen
  {
    kind: "tinana.report",
    source: "tinana",
    label: "Tinana – Umsatzbericht",
    target: "–",
    match: (s) => first(s, "tag") && has(s, "gkv (eur)", "gesamt (eur)"),
    status: "rejected",
    note: "Das ist ein Bericht (Auswertung), kein Datenexport. Bitte in Tinana unter Einstellungen → Datenexport exportieren.",
  },
  {
    kind: "tinana.report",
    source: "tinana",
    label: "Tinana – Mitarbeiterbericht",
    target: "–",
    match: (s) => /^zeithaltungsbericht$/i.test(s.firstLine.replace(/[";]/g, "").trim()),
    status: "rejected",
    note: "Das ist ein Bericht (Auswertung), kein Datenexport. Bitte in Tinana unter Einstellungen → Datenexport exportieren.",
  },
  {
    kind: "tinana.report",
    source: "tinana",
    label: "Tinana – Heilmittelbericht",
    target: "–",
    match: (s) => s.headers.join(";") === "kürzel;heilmittel;umsatz;anteil",
    status: "rejected",
    note: "Das ist ein Bericht (Auswertung), kein Datenexport. Bitte in Tinana unter Einstellungen → Datenexport exportieren.",
  },
  {
    kind: "tinana.report",
    source: "tinana",
    label: "Tinana – Verordnungsbericht",
    target: "–",
    match: (s) => first(s, "monat") && has(s, "gesamt", "muster 13", "blanko"),
    status: "rejected",
    note: "Das ist ein Bericht (Auswertung), kein Datenexport. Bitte in Tinana unter Einstellungen → Datenexport → Verordnungen exportieren.",
  },
  {
    kind: "doctolib.patients",
    source: "doctolib",
    label: "Doctolib – Patientenliste",
    target: "Patient:innen",
    match: (s) => has(s, "last_name", "first_name") && (has(s, "import_identifier") || has(s, "insurance_sector") || has(s, "regular_doctor_name")),
  },
  {
    kind: "pododesk.cashbook",
    source: "pododesk",
    label: "Pododesk – Kassenbuch",
    target: "nur Anfangsbestand",
    match: (s) => has(s, "buchungsnummer", "belegnummer", "erfasst von", "kassenbestand in €"),
    fileName: /^Kassenbuch .+\.csv$/i,
    status: "info",
    note: "Kassenbuch – nicht nachbuchen, nur Anfangsbestand. Alte Kassenbuchungen werden nicht übernommen (GoBD, Kassensicherungsverordnung). Trage den letzten Kassenbestand in PodoHero unter Kasse als Anfangsbestand ein und bewahre den Export selbst auf.",
  },
];

export const SUPPORTED_FORMATS = [
  "Tinana: Datenexport Patienten, Termine, Verordnungen, Ärzte, Rechnungen (CSV) und Rechnungs-PDFs (ZIP)",
  "Doctolib: Patientenliste (CSV)",
  "PodoHero/Excel: „Podologie Rechnungsmanager“ (XLSX)",
  "Pododesk: Kassenbuch (CSV, nur Hinweis auf den Anfangsbestand)",
  "Alles auch als ZIP (höchstens eine Ebene verschachtelt)",
];

export const UNKNOWN_NOTE = `Format nicht erkannt. Unterstützt werden: ${SUPPORTED_FORMATS.join("; ")}.`;

const isXlsxName = (n: string) => /\.xlsx$/i.test(n);
const isPdf = (d: Uint8Array) => d.length > 5 && String.fromCharCode(...d.subarray(0, 5)) === "%PDF-";

function sha(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

/** Nur Erkennung (ohne Parsen) – für Tests und die Registry. */
export function recognize(text: string): Recognizer | null {
  const sig = textSignature(text);
  return RECOGNIZERS.find((r) => r.match(sig)) ?? null;
}

function cashbookSummary(text: string) {
  const t = readTable(text);
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  let lastBalanceCents: number | null = null;
  for (const r of t.records) {
    const d = parseDateLoose(r.values["datum"]);
    if (d && (!firstDate || d < firstDate)) firstDate = d;
    if (d && (!lastDate || d >= lastDate)) {
      lastDate = d;
      const b = decimalCents(r.values["kassenbestand in €"]);
      if (b !== null) lastBalanceCents = b;
    }
  }
  return { rows: t.records.length, firstDate, lastDate, lastBalanceCents };
}

/** Erkennt und parst eine (bereits aus ZIPs entpackte) Datei. */
export async function analyzeFile(name: string, data: Uint8Array): Promise<DetectedFile> {
  const base: DetectedFile = { name, sha256: sha(data), size: data.length, kind: "unknown", source: null, label: "nicht erkannt", target: "–", status: "rejected", records: 0, issues: [] };
  if (isPdf(data)) {
    return { ...base, kind: "pdf", label: "PDF-Dokument", target: "Dokumente der Patient:in", status: "info", pdf: data };
  }
  if (isZip(data)) {
    if (!isXlsxName(name) && !/\.xlsm?$/i.test(name)) return { ...base, note: "ZIP konnte nicht entpackt werden." };
    const excel = await parseWorkbook(data);
    const imported = Object.values(excel.report.counts).reduce((a, c) => a + c.imported, 0);
    if (!imported) {
      return { ...base, note: `Excel-Datei ohne erkennbare Blätter „Patienten“, „Leistungen“, „Rechnungen“ … ${UNKNOWN_NOTE}` };
    }
    return {
      ...base,
      kind: "podohero.excel",
      source: "podohero-excel",
      label: "PodoHero-Excel (Rechnungsmanager)",
      target: "Patient:innen, Leistungen, Gutscheine, Rechnungen, Fixkosten",
      status: "import",
      records: imported,
      excel,
      issues: excel.report.warnings.map((w) => ({ file: name, row: w.row ?? undefined, message: `${w.sheet}: ${w.message}` })),
    };
  }
  // Binärdateien (Bilder, Word, …) nicht als Text deuten
  if (data.subarray(0, 4096).some((b) => b === 0)) return { ...base, note: UNKNOWN_NOTE };
  const text = decodeText(data);
  const sig = textSignature(text);
  const rec = RECOGNIZERS.find((r) => r.match(sig));
  if (!rec) return { ...base, note: UNKNOWN_NOTE };
  const out: DetectedFile = { ...base, kind: rec.kind, source: rec.source, label: rec.label, target: rec.target, status: rec.status ?? "import", note: rec.note, records: sig.dataRows };
  switch (rec.kind) {
    case "tinana.patients": {
      const r = parseTinanaPatients(text, name);
      return { ...out, records: r.patients.length, tinanaPatients: r.patients, issues: r.issues };
    }
    case "tinana.appointments": {
      const r = parseTinanaAppointments(text, name);
      return { ...out, records: r.appointments.length, tinanaAppointments: r.appointments, issues: r.issues };
    }
    case "tinana.prescriptions": {
      const r = parseTinanaPrescriptions(text, name);
      return { ...out, records: r.prescriptions.length, tinanaPrescriptions: r.prescriptions, issues: r.issues };
    }
    case "tinana.doctors": {
      const d = parseTinanaDoctors(text);
      return { ...out, records: d.length, tinanaDoctors: d };
    }
    case "tinana.invoices": {
      const inv = parseTinanaInvoices(text);
      return { ...out, records: inv.length, tinanaInvoices: inv };
    }
    case "doctolib.patients": {
      const r = parseDoctolibPatientsCsv(text);
      return { ...out, records: r.patients.length, doctolibPatients: r.patients, issues: r.issues.map((i) => ({ file: name, row: i.row, message: i.message })) };
    }
    case "pododesk.cashbook": {
      const c = cashbookSummary(text);
      return { ...out, records: c.rows, cashbook: c };
    }
    default:
      return out;
  }
}
