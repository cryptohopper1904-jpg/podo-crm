/** Text-Hilfen für CSV-Exporte fremder Programme: Zeichensatz, BOM, Trennzeichen, Kopfzeile. */
import { detectDelimiter, parseCsv, stripBom } from "@/integrations/csv";

export function hasBom(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
}

/** UTF-8 (mit/ohne BOM); bei ungültigem UTF-8 Windows-1252 (Excel unter Windows). */
export function decodeText(data: Uint8Array): string {
  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Kopfzeilen-Name normalisiert: ohne Anführungszeichen, klein, Leerzeichen zusammengefasst. */
export const normHeader = (h: string) =>
  h
    .replace(/^"|"$/g, "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export interface Table {
  headers: string[];
  records: { row: number; values: Record<string, string> }[];
}

/** CSV → Datensätze mit normalisierten Spaltennamen. `row` = Zeile in der Datei (Kopf = 1). */
export function readTable(text: string): Table {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(normHeader);
  const records = rows.slice(1).map((r, i) => {
    const values: Record<string, string> = {};
    headers.forEach((h, k) => {
      if (h && values[h] === undefined) values[h] = (r[k] ?? "").trim();
    });
    return { row: i + 2, values };
  });
  return { headers, records };
}

export interface TextSignature {
  /** erste nicht-leere Zeile, roh */
  firstLine: string;
  delimiter: string;
  /** Kopfzeile normalisiert (erste Zeile) */
  headers: string[];
  /** Anzahl Datenzeilen (ohne Kopf, ohne Leerzeilen) */
  dataRows: number;
}

export function textSignature(text: string): TextSignature {
  const firstLine = (text.split(/\r\n|\n|\r/).find((l) => l.trim() !== "") ?? "").trim();
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  return {
    firstLine,
    delimiter,
    headers: (rows[0] ?? []).map(normHeader),
    dataRows: Math.max(0, rows.length - 1),
  };
}
