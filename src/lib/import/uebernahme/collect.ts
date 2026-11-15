/**
 * Upload eines Übernahme-Laufs einlesen: ZIPs sicher entpacken, jede Datei erkennen und parsen, doppelte Dateien
 * (gleicher Inhalt) markieren. Alles im Arbeitsspeicher.
 *
 * Excel: höchstens eine XLSX-Datei je Lauf (weitere werden vor dem Parsen abgelehnt), Makro-Dateien (.xlsm) nie –
 * auch nicht innerhalb eines ZIPs (AppSec B2). Doppelte Dateien werden vor dem Parsen über den SHA-256 erkannt.
 */
import { createHash } from "node:crypto";
import { analyzeFile, isXlsmName, isXlsxName, XLSM_NOTE } from "./detect";
import type { DetectedFile, InputFile } from "./types";
import { DEFAULT_ZIP_LIMITS, isZip, unzip, ZipError, type ZipLimits } from "./zip";

export const MAX_UPLOAD_FILES = 30;
export const ONE_EXCEL_NOTE = "Bitte je Lauf nur eine Excel-Datei hochladen – diese Datei wurde nicht gelesen.";

const sha = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");

export async function collectFiles(files: InputFile[], limits: Partial<ZipLimits> = {}): Promise<DetectedFile[]> {
  const budget = { usedBytes: 0 };
  const flat: InputFile[] = [];
  const out: DetectedFile[] = [];
  for (const f of files) {
    const isExcel = isXlsxName(f.name) || isXlsmName(f.name);
    if (isZip(f.data) && !isExcel) {
      try {
        const entries = unzip(f.data, { limits: { ...DEFAULT_ZIP_LIMITS, ...limits }, budget });
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
    else {
      if (isXlsxName(f.name) && isZip(f.data)) excelSeen = true;
      d = await analyzeFile(f.name, f.data);
    }
    seen.set(hash, d);
    out.push(d);
  }
  return out;
}

function stub(f: InputFile, hash: string): DetectedFile {
  return { name: f.name, sha256: hash, size: f.data.length, kind: "unknown", source: null, label: "nicht erkannt", target: "–", status: "rejected", records: 0, issues: [] };
}

function rejected(f: InputFile, note: string): DetectedFile {
  return { ...stub(f, ""), label: "ZIP-Archiv", note };
}
