/**
 * Upload eines Übernahme-Laufs einlesen: ZIPs sicher entpacken, jede Datei erkennen und parsen, doppelte Dateien
 * (gleicher Inhalt) markieren. Alles im Arbeitsspeicher.
 *
 * Excel: höchstens eine XLSX-Datei je Lauf (weitere werden vor dem Parsen abgelehnt), Makro-Dateien (.xlsm) nie –
 * auch nicht innerhalb eines ZIPs (AppSec B2). Doppelte Dateien werden vor dem Parsen über den SHA-256 erkannt.
 * Pododesk: je Lauf nur ein Export (mehrere unterschiedliche Dateien derselben Art werden abgelehnt, B1).
 */
import { createHash } from "node:crypto";
import { analyzeFile, isPdf, isXlsmName, isXlsxName, XLSM_NOTE } from "./detect";
import type { DetectedFile, InputFile } from "./types";
import { DEFAULT_ZIP_LIMITS, isZip, newZipBudget, unzip, ZipError, type ZipLimits } from "./zip";

export const MAX_UPLOAD_FILES = 30;
export const ONE_EXCEL_NOTE = "Bitte je Lauf nur eine Excel-Datei hochladen – diese Datei wurde nicht gelesen.";

/** Gesamtgrenzen je Lauf über alle Dateien und ZIP-Einträge (AppSec Runde 2 A-B1) */
export interface RunLimits {
  /** Datensätze über alle Dateien */
  maxRecords: number;
  /** Dateien inkl. ZIP-Einträge */
  maxFiles: number;
  /** Byte-Summe aller Textdateien (CSV/TXT), die geparst werden */
  maxTextBytes: number;
}
export const RUN_LIMITS: RunLimits = { maxRecords: 100_000, maxFiles: DEFAULT_ZIP_LIMITS.maxRunEntries, maxTextBytes: 40 * 1024 * 1024 };

const de = (n: number) => n.toLocaleString("de-DE");

const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

export async function collectFiles(files: InputFile[], limits: Partial<ZipLimits> = {}, runLimits: RunLimits = RUN_LIMITS): Promise<DetectedFile[]> {
  // ein Budget über alle ZIPs des Laufs: Bytes, Einträge (gegen maxFiles, vor dem Entpacken geprüft), innere ZIPs (SB1)
  const budget = newZipBudget();
  const flat: InputFile[] = [];
  const out: DetectedFile[] = [];
  for (const f of files) {
    const isExcel = isXlsxName(f.name) || isXlsmName(f.name);
    if (isZip(f.data) && !isExcel) {
      try {
        const entries = unzip(f.data, { limits: { ...DEFAULT_ZIP_LIMITS, maxRunEntries: runLimits.maxFiles, ...limits }, budget });
        if (!entries.length) {
          out.push(rejected(f, "Das ZIP enthält keine Dateien."));
          continue;
        }
        for (const e of entries) flat.push({ name: `${f.name}/${e.path}`, data: e.data });
      } catch (e) {
        out.push(rejected(f, e instanceof ZipError ? e.message : "Das ZIP konnte nicht gelesen werden."));
      }
      continue;
    }
    flat.push(f);
  }
  const seen = new Map<string, DetectedFile>();
  let excelSeen = false;
  let records = 0;
  let textBytes = 0;
  if (flat.length > runLimits.maxFiles) {
    const rest = flat.length - runLimits.maxFiles;
    flat.length = runLimits.maxFiles;
    out.push({
      ...stub({ name: `weitere ${de(rest)} Dateien`, data: new Uint8Array() }, ""),
      note: `Zu viele Dateien in einem Lauf (mehr als ${de(runLimits.maxFiles)}) – diese Dateien wurden nicht gelesen. Bitte in mehreren Durchgängen hochladen.`,
    });
  }
  for (const f of flat) {
    // SHA vor dem Parsen: doppelte Dateien werden nicht ein zweites Mal verarbeitet
    const hash = sha(f.data);
    const prev = seen.get(hash);
    if (prev) {
      // Anzeige wie die erste Datei, aber ohne Inhalte (wird nicht erneut verarbeitet)
      const { kind, source, label, target, records } = prev;
      out.push({ ...stub(f, hash), kind, source, label, target, records, status: "duplicate", note: `Gleicher Inhalt wie „${prev.name}“ – wird nur einmal berücksichtigt.` });
      continue;
    }
    let d: DetectedFile;
    if (isXlsmName(f.name)) d = { ...stub(f, hash), label: "Excel mit Makros", note: XLSM_NOTE };
    else if (isXlsxName(f.name) && isZip(f.data) && excelSeen) d = { ...stub(f, hash), label: "Excel-Datei", note: ONE_EXCEL_NOTE };
    else if (isTextCandidate(f) && textBytes + f.data.length > runLimits.maxTextBytes) {
      d = { ...stub(f, hash), note: `Die Textdateien dieses Laufs sind zusammen größer als ${Math.round(runLimits.maxTextBytes / 1024 / 1024)} MB – diese Datei wurde nicht gelesen. Bitte in mehreren Durchgängen hochladen.` };
    } else {
      if (isXlsxName(f.name) && isZip(f.data)) excelSeen = true;
      if (isTextCandidate(f)) textBytes += f.data.length;
      d = await analyzeFile(f.name, f.data);
      if (d.status !== "rejected" && records + d.records > runLimits.maxRecords) {
        // Inhalte verwerfen, nur der Hinweis bleibt
        d = { ...stub(f, hash), label: d.label, note: `Zu viele Datensätze in einem Lauf (mehr als ${de(runLimits.maxRecords)}) – diese Datei wurde nicht übernommen. Bitte in mehreren Durchgängen hochladen.` };
      } else if (d.status !== "rejected") records += d.records;
    }
    seen.set(hash, d);
    out.push(d);
  }
  return requirePododeskPatients(rejectSeveralPododeskPractices(out));
}

export const ONE_PODODESK_NOTE = "Mehrere unterschiedliche Pododesk-Exporte – bitte nur einen Export hochladen. Mehrere Pododesk-Praxen in einem PodoHero-Konto werden derzeit nicht unterstützt.";

/**
 * Pododesk-IDs sind nur innerhalb einer Praxis eindeutig (fortlaufende Zahlen). Zwei unterschiedliche Dateien derselben
 * Art (z. B. zwei patienten.csv) stammen fast immer aus zwei Praxen – zusammengeführt würden Termine der falschen
 * Person zugeordnet (Code-Review B1). Deshalb werden alle Dateien dieser Art abgelehnt; gleicher Inhalt zweimal ist
 * schon als „doppelt“ markiert und zählt nicht.
 */
/** Pododesk-Dateiarten mit praxisbezogenen IDs; Kassenbücher (z. B. je Jahr eines) tragen keine und bleiben erlaubt (R3-3) */
const PODODESK_ID_KINDS = new Set(["pododesk.patients", "pododesk.appointments", "pododesk.services", "pododesk.users", "pododesk.doctors", "pododesk.practice"]);

function rejectSeveralPododeskPractices(files: DetectedFile[]): DetectedFile[] {
  const count = new Map<string, number>();
  const counts = (d: DetectedFile) => d.source === "pododesk" && PODODESK_ID_KINDS.has(d.kind) && d.status !== "duplicate" && d.status !== "rejected";
  for (const d of files) if (counts(d)) count.set(d.kind, (count.get(d.kind) ?? 0) + 1);
  return files.map((d) =>
    counts(d) && count.get(d.kind)! > 1 ? { ...stub({ name: d.name, data: new Uint8Array() }, d.sha256), size: d.size, label: d.label, note: ONE_PODODESK_NOTE } : d,
  );
}

export const PODODESK_TERMINE_NOTE = "termine.csv nur zusammen mit patienten.csv aus demselben Pododesk-Export – bitte lade beide Dateien gemeinsam hoch.";

/**
 * Termine werden nur Personen aus der mitgeladenen patienten.csv zugeordnet (R4-A): ohne sie könnte eine Pododesk-ID
 * aus einem anderen Export still bei einer Bestandsperson landen. Fehlt patienten.csv (oder wurde sie abgelehnt),
 * wird termine.csv als Ganzes nicht übernommen.
 */
function requirePododeskPatients(files: DetectedFile[]): DetectedFile[] {
  const usable = (d: DetectedFile) => d.status !== "duplicate" && d.status !== "rejected";
  if (files.some((d) => d.kind === "pododesk.patients" && usable(d))) return files;
  return files.map((d) =>
    d.kind === "pododesk.appointments" && usable(d) ? { ...stub({ name: d.name, data: new Uint8Array() }, d.sha256), size: d.size, label: d.label, note: PODODESK_TERMINE_NOTE } : d,
  );
}

/** wird als Text (CSV) geparst: kein PDF, kein ZIP/XLSX */
const isTextCandidate = (f: InputFile) => !isZip(f.data) && !isPdf(f.data);

function stub(f: InputFile, hash: string): DetectedFile {
  return { name: f.name, sha256: hash, size: f.data.length, kind: "unknown", source: null, label: "nicht erkannt", target: "–", status: "rejected", records: 0, issues: [] };
}

function rejected(f: InputFile, note: string): DetectedFile {
  return { ...stub(f, ""), label: "ZIP-Archiv", note };
}
