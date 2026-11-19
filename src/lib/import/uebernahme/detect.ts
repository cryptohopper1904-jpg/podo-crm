/**
 * Automatische Erkennung hochgeladener Exportdateien über Signaturen: Kopfzeile (Spalten-Kombination), Trennzeichen,
 * erste Zeile und – nur als Bestätigung – Dateiname. Die Kopfzeile entscheidet, damit umbenannte Dateien und
 * „Datei (1).csv“ aus dem Browser trotzdem erkannt werden; BOM ist optional (Excel entfernt sie beim Speichern).
 *
 * Neue Quellen: einen Eintrag in RECOGNIZERS ergänzen (Spalten-Signatur, Art, Hinweis) und den Parser in
 * analyzeFile verdrahten.
 */
import { createHash } from "node:crypto";
import type { Delimiter } from "@/integrations/csv";
import { parseDateLoose, parseDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { parseWorkbook } from "../excel/parse";
import { decimalCents, parseTinanaAppointments, parseTinanaDoctors, parseTinanaInvoices, parseTinanaPatients, parseTinanaPrescriptions } from "./tinana";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { parsePododeskAppointments, parsePododeskDoctors, parsePododeskPatients, parsePododeskPractice, parsePododeskServices, parsePododeskUsers, pododeskFileOf, restrictColumns, type PododeskFile } from "./pododesk";
import { decodeBounded, parseCsvBounded, tableFromRows, TextLimitError, textSignature, type Table, type TextSignature } from "./text";
import type { DetectedFile, FileKind, SourceId } from "./types";
import { isZip, unzip, ZipError, type ZipLimits } from "./zip";

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
  /** Datei des Pododesk-Gesamtexports: nur die erlaubten Spalten werden gelesen (restrictColumns) */
  pododesk?: PododeskFile;
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
  // Pododesk-Gesamtexport: Erkennung über die Pflichtspalten der jeweiligen Datei (einzeln oder im ZIP), zusätzliche Spalten erlaubt
  {
    kind: "pododesk.patients",
    source: "pododesk",
    label: "Pododesk – Patient:innen",
    target: "Patient:innen",
    match: (s) => pododeskFileOf(s.headers) === "patienten",
    fileName: /^patienten\.csv$/i,
    pododesk: "patienten",
  },
  {
    kind: "pododesk.appointments",
    source: "pododesk",
    label: "Pododesk – Termine",
    target: "Termine",
    match: (s) => pododeskFileOf(s.headers) === "termine",
    fileName: /^termine\.csv$/i,
    pododesk: "termine",
  },
  {
    kind: "pododesk.services",
    source: "pododesk",
    label: "Pododesk – Leistungen (privat)",
    target: "Leistungen",
    match: (s) => pododeskFileOf(s.headers) === "leistungenPrivat",
    fileName: /^leistungenPrivat\.csv$/i,
    pododesk: "leistungenPrivat",
  },
  {
    kind: "pododesk.doctors",
    source: "pododesk",
    label: "Pododesk – Ärzt:innen",
    target: "Haus- und Fachärzt:in bei den Patient:innen",
    match: (s) => pododeskFileOf(s.headers) === "aerzte",
    fileName: /^aerzte\.csv$/i,
    status: "info",
    note: "PodoHero hat keine eigene Ärzteliste. Die Datei ergänzt bei neu übernommenen Patient:innen den Namen der Hausärzt:in und der Fachärzt:in.",
    pododesk: "aerzte",
  },
  {
    kind: "pododesk.users",
    source: "pododesk",
    label: "Pododesk – Mitarbeitende",
    target: "Zuordnung der Termine zum Team",
    match: (s) => pododeskFileOf(s.headers) === "users",
    fileName: /^users\.csv$/i,
    status: "info",
    note: "Mitarbeitende werden nicht als Nutzerkonten angelegt, sondern über den Namen deinem Team in PodoHero zugeordnet. Zugangsdaten, Tokens und Kontaktdaten werden nicht gelesen.",
    pododesk: "users",
  },
  {
    kind: "pododesk.practice",
    source: "pododesk",
    label: "Pododesk – Praxisstammdaten",
    target: "nur Vorschläge",
    match: (s) => pododeskFileOf(s.headers) === "praxisstammdaten",
    fileName: /^praxisstammdaten\.csv$/i,
    status: "info",
    note: "Es wird nichts automatisch geändert. Bankverbindung, PayPal- und sevDesk-Zugangsdaten werden nicht gelesen.",
    pododesk: "praxisstammdaten",
  },
  {
    kind: "pododesk.cashbook",
    source: "pododesk",
    label: "Pododesk – Kassenbuch",
    target: "nur Anfangsbestand",
    match: (s) => has(s, "buchungsnummer", "belegnummer", "erfasst von", "kassenbestand in €"),
    fileName: /^Kassenbuch .+\.csv$/i,
    status: "info",
    note: "Kassenbuch – nicht nachbuchen, nur Anfangsbestand. Alte Kassenbuchungen werden nicht übernommen (GoBD, Kassensicherungsverordnung). Trag den letzten Kassenbestand in PodoHero unter Kasse als Anfangsbestand ein und bewahre den Export selbst auf.",
  },
];

export const SUPPORTED_FORMATS = [
  "Tinana: Datenexport Patienten, Termine, Verordnungen, Ärzte, Rechnungen (CSV) und Rechnungs-PDFs (ZIP)",
  "Doctolib: Patientenliste (CSV)",
  "PodoHero/Excel: „Podologie Rechnungsmanager“ (XLSX)",
  "Pododesk: Gesamtexport „Praxisdaten“ (ZIP oder einzelne CSV-Dateien) und Kassenbuch (CSV, nur Hinweis auf den Anfangsbestand)",
  "Alles auch als ZIP (höchstens eine Ebene verschachtelt)",
];

export const UNKNOWN_NOTE = `Format nicht erkannt. Unterstützt werden: ${SUPPORTED_FORMATS.join("; ")}.`;

export const isXlsxName = (n: string) => /\.xlsx$/i.test(n);
export const isXlsmName = (n: string) => /\.xlsm$/i.test(n);
export const XLSM_NOTE = "Excel-Dateien mit Makros (.xlsm) werden nicht angenommen. Bitte in Excel als „Excel-Arbeitsmappe (.xlsx)“ speichern und erneut hochladen.";

/** Grenzen für den Inhalt einer XLSX-Datei (ist intern ein ZIP) – vor dem Parsen geprüft (AppSec B2). */
export const XLSX_LIMITS: Partial<ZipLimits> = {
  maxEntries: 2000,
  // entpackt höchstens 25 MB (AppSec Runde 2 A-H8) – ein echter Rechnungsmanager liegt weit darunter
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  // Tabellen-XML packt sehr gut; deutlich großzügiger als bei Exporten, die Größen-Grenzen bleiben hart
  maxRatio: 1000,
  maxDepth: 0,
};

export const isPdf = (d: Uint8Array) => d.length > 5 && String.fromCharCode(...d.subarray(0, 5)) === "%PDF-";

function sha(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

/** XLSX vorab mit dem eigenen, begrenzten Entpacker prüfen. Liefert einen Ablehnungsgrund oder null. */
export function xlsxPrecheck(data: Uint8Array): string | null {
  try {
    const parts = unzip(data, { limits: XLSX_LIMITS });
    if (parts.some((p) => /^xl\/vbaProject\.bin$/i.test(p.path))) return XLSM_NOTE;
    return null;
  } catch (e) {
    return e instanceof ZipError ? `Excel-Datei abgelehnt: ${e.message}` : "Die Excel-Datei konnte nicht gelesen werden.";
  }
}

/** Nur Erkennung (ohne Parsen) – für Tests und die Registry. */
export function recognize(text: string): Recognizer | null {
  const sig = textSignature(text);
  return RECOGNIZERS.find((r) => r.match(sig)) ?? null;
}

function cashbookSummary(t: Table) {
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
    if (data.length > MAX_UPLOAD_BYTES) return { ...base, label: "PDF-Dokument", note: `PDF größer als ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB – nicht übernommen.` };
    return { ...base, kind: "pdf", label: "PDF-Dokument", target: "Dokumente der Patient:in", status: "info", pdf: data };
  }
  if (isZip(data)) {
    if (isXlsmName(name)) return { ...base, label: "Excel mit Makros", note: XLSM_NOTE };
    if (!isXlsxName(name)) return { ...base, note: "ZIP konnte nicht entpackt werden." };
    const bad = xlsxPrecheck(data);
    if (bad) return { ...base, label: "Excel-Datei", note: bad };
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
  let text: string;
  let sig: TextSignature;
  let table: Table;
  try {
    text = decodeBounded(data);
    // Erkennung nur über den Anfang der Datei
    sig = textSignature(text);
    if (!RECOGNIZERS.some((r) => r.match(sig))) return { ...base, note: UNKNOWN_NOTE };
    // harte Grenzen über die ganze Datei, bevor ein Parser sie verarbeitet – einmal zerlegt, die Tinana-Parser
    // arbeiten auf dieser Tabelle (A-B1), mit dem Trennzeichen aus der Erkennung (A-H7)
    table = tableFromRows(parseCsvBounded(text, sig.delimiter as Delimiter));
  } catch (e) {
    if (e instanceof TextLimitError) return { ...base, note: e.message };
    throw e;
  }
  const rec = RECOGNIZERS.find((r) => r.match(sig))!;
  // Pododesk: nicht benötigte und sensible Spalten (Bankdaten, Tokens, Einwilligungs-Schalter …) sofort verwerfen
  if (rec.pododesk) table = restrictColumns(table, rec.pododesk);
  const out: DetectedFile = { ...base, kind: rec.kind, source: rec.source, label: rec.label, target: rec.target, status: rec.status ?? "import", note: rec.note, records: table.records.length };
  // Trennzeichen aus der Erkennung an die Parser weitergeben (A-H7)
  const d = sig.delimiter as Delimiter;
  try {
    switch (rec.kind) {
      case "tinana.patients": {
        const r = parseTinanaPatients(table, name);
        return { ...out, records: r.patients.length, tinanaPatients: r.patients, issues: r.issues };
      }
      case "tinana.appointments": {
        const r = parseTinanaAppointments(table, name);
        return { ...out, records: r.appointments.length, tinanaAppointments: r.appointments, issues: r.issues };
      }
      case "tinana.prescriptions": {
        const r = parseTinanaPrescriptions(table, name);
        return { ...out, records: r.prescriptions.length, tinanaPrescriptions: r.prescriptions, issues: r.issues };
      }
      case "tinana.doctors": {
        const list = parseTinanaDoctors(table);
        return { ...out, records: list.length, tinanaDoctors: list };
      }
      case "tinana.invoices": {
        const inv = parseTinanaInvoices(table);
        return { ...out, records: inv.length, tinanaInvoices: inv };
      }
      case "doctolib.patients": {
        const r = parseDoctolibPatientsCsv(text, d);
        return { ...out, records: r.patients.length, doctolibPatients: r.patients, issues: r.issues.map((i) => ({ file: name, row: i.row, message: i.message })) };
      }
      case "pododesk.patients": {
        const r = parsePododeskPatients(table, name);
        return { ...out, records: r.patients.length, pododeskPatients: r.patients, issues: r.issues };
      }
      case "pododesk.appointments": {
        const r = parsePododeskAppointments(table, name);
        return { ...out, records: r.appointments.length, pododeskAppointments: r.appointments, issues: r.issues };
      }
      case "pododesk.services": {
        const r = parsePododeskServices(table, name);
        return { ...out, records: r.services.length, pododeskServices: r.services, issues: r.issues };
      }
      case "pododesk.doctors": {
        const list = parsePododeskDoctors(table);
        return { ...out, records: list.length, pododeskDoctors: list };
      }
      case "pododesk.users": {
        const list = parsePododeskUsers(table);
        return { ...out, records: list.length, pododeskUsers: list };
      }
      case "pododesk.practice":
        return { ...out, pododeskPractice: parsePododeskPractice(table) };
      case "pododesk.cashbook": {
        const c = cashbookSummary(table);
        return { ...out, records: c.rows, cashbook: c };
      }
      default:
        return out;
    }
  } catch (e) {
    // Grenzen beim Parsen (z. B. anderes Trennzeichen im Rest der Datei) → Dateinotiz statt Abbruch des ganzen Laufs
    if (e instanceof TextLimitError) return { ...base, label: rec.label, note: e.message };
    throw e;
  }
}
