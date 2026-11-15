/**
 * Upload eines Übernahme-Laufs einlesen: ZIPs sicher entpacken, jede Datei erkennen und parsen, doppelte Dateien
 * (gleicher Inhalt) markieren. Alles im Arbeitsspeicher.
 */
import { analyzeFile } from "./detect";
import type { DetectedFile, InputFile } from "./types";
import { DEFAULT_ZIP_LIMITS, isZip, unzip, ZipError, type ZipLimits } from "./zip";

export const MAX_UPLOAD_FILES = 30;

export async function collectFiles(files: InputFile[], limits: Partial<ZipLimits> = {}): Promise<DetectedFile[]> {
  const budget = { usedBytes: 0 };
  const flat: InputFile[] = [];
  const out: DetectedFile[] = [];
  for (const f of files) {
    const isExcel = /\.xls[xm]$/i.test(f.name);
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
  const seen = new Map<string, string>();
  for (const f of flat) {
    const d = await analyzeFile(f.name, f.data);
    const prev = seen.get(d.sha256);
    if (prev) {
      out.push({ ...d, status: "duplicate", note: `Gleicher Inhalt wie „${prev}“ – wird nur einmal berücksichtigt.`, records: d.records, tinanaPatients: undefined, tinanaAppointments: undefined, tinanaPrescriptions: undefined, tinanaDoctors: undefined, tinanaInvoices: undefined, doctolibPatients: undefined, excel: undefined, cashbook: undefined, pdf: undefined });
      continue;
    }
    seen.set(d.sha256, f.name);
    out.push(d);
  }
  return out;
}

function rejected(f: InputFile, note: string): DetectedFile {
  return { name: f.name, sha256: "", size: f.data.length, kind: "unknown", source: null, label: "ZIP-Archiv", target: "–", status: "rejected", note, records: 0, issues: [] };
}
