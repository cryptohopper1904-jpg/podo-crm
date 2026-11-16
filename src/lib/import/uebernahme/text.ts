/**
 * Text-Hilfen für CSV-Exporte fremder Programme: Zeichensatz, BOM, Trennzeichen, Kopfzeile – mit harten Grenzen
 * (Größe, Zeilen, Spalten, Feldlänge), damit präparierte Dateien den Server nicht lahmlegen (AppSec B1).
 */
import { detectDelimiter, parseCsv, stripBom, type Delimiter } from "@/integrations/csv";

export interface TextLimits {
  /** höchstens so viele Byte je Textdatei */
  maxBytes: number;
  /** höchstens so viele Zeilen (inkl. Kopfzeile) */
  maxRows: number;
  /** höchstens so viele Spalten je Zeile */
  maxCols: number;
  /** höchstens so viele Zeichen je Feld */
  maxFieldChars: number;
}

export const TEXT_LIMITS: TextLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxCols: 200,
  maxFieldChars: 32 * 1024,
};

/** Erkennung (Trennzeichen, Kopfzeile) liest nur den Anfang der Datei. */
export const SIGNATURE_BYTES = 64 * 1024;

export class TextLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextLimitError";
  }
}

export function hasBom(data: Uint8Array): boolean {
  return data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
}

/**
 * Steuerzeichen außer Tabulator und Zeilenumbruch (U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F). Postgres
 * lehnt NUL in Texten ab – der Fehler bräche den ganzen Lauf ab und enthielte die Abfrage samt Klardaten (AppSec A-B2).
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");
export const stripControl = (s: string) => s.replace(CONTROL_CHARS, "");

/** UTF-8 (mit/ohne BOM); bei ungültigem UTF-8 Windows-1252 (Excel unter Windows). Steuerzeichen entfernt (A-B2). */
export function decodeText(data: Uint8Array): string {
  let text: string;
  try {
    text = stripBom(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    text = new TextDecoder("windows-1252").decode(data);
  }
  return stripControl(text);
}

/** Kopfzeilen-Name normalisiert: ohne Anführungszeichen, klein, Leerzeichen zusammengefasst. */
export const normHeader = (h: string) =>
  h
    .replace(/^"|"$/g, "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const de = (n: number) => n.toLocaleString("de-DE");

/**
 * CSV zerlegen und dabei abbrechen, sobald eine Grenze überschritten ist (kein Aufbau riesiger Arrays).
 * Gleiche Regeln wie parseCsv (Anführungszeichen, "" im Feld, Zeilenumbrüche im Feld, leere Zeilen entfallen).
 */
export function parseCsvBounded(input: string, delimiter?: Delimiter, limits: TextLimits = TEXT_LIMITS): string[][] {
  const text = stripBom(input);
  const d = delimiter ?? detectDelimiter(text.slice(0, SIGNATURE_BYTES));
  const n = text.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    if (row.length >= limits.maxCols) throw new TextLimitError(`Zu viele Spalten (mehr als ${de(limits.maxCols)}) – das ist kein unterstützter Export.`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === "")) {
      if (rows.length >= limits.maxRows) throw new TextLimitError(`Zu viele Zeilen (mehr als ${de(limits.maxRows)}). Bitte den Export in kleineren Teilen (z. B. je Jahr) hochladen.`);
      rows.push(row);
    }
    row = [];
  };
  const add = (chunk: string) => {
    if (field.length + chunk.length > limits.maxFieldChars) throw new TextLimitError(`Ein Feld ist länger als ${de(limits.maxFieldChars)} Zeichen – das ist kein unterstützter Export.`);
    field += chunk;
  };
  // Abschnitte statt einzelner Zeichen (A-B1: lineare, schnelle Zerlegung auch bei 50.000 Zeilen)
  const plain = new RegExp(`[${d === "\t" ? "\\t" : d}\\r\\n]`, "g");
  let i = 0;
  while (i < n) {
    if (inQuotes) {
      const q = text.indexOf('"', i);
      if (q < 0) {
        add(text.slice(i));
        i = n;
        break;
      }
      add(text.slice(i, q));
      if (text[q + 1] === '"') {
        add('"');
        i = q + 2;
      } else {
        inQuotes = false;
        i = q + 1;
      }
      continue;
    }
    const c = text[i];
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (c === d) {
      pushField();
      i++;
    } else if (c === "\r" || c === "\n") {
      pushRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      // gewöhnliche Zeichen bis zum nächsten Trennzeichen/Zeilenende („"“ mitten im Feld ist ein normales Zeichen)
      plain.lastIndex = i;
      const m = plain.exec(text);
      const j = m ? m.index : n;
      add(text.slice(i, j));
      i = j;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Größe prüfen und Text dekodieren – wirft TextLimitError. */
export function decodeBounded(data: Uint8Array, limits: TextLimits = TEXT_LIMITS): string {
  if (data.length > limits.maxBytes) throw new TextLimitError(`Die Datei ist größer als ${MB(limits.maxBytes)}. Bitte den Export in kleineren Teilen (z. B. je Jahr) hochladen.`);
  return decodeText(data);
}

export interface Table {
  headers: string[];
  records: { row: number; values: Record<string, string> }[];
}

/**
 * CSV → Datensätze mit normalisierten Spaltennamen. `row` = Zeile in der Datei (Kopf = 1). Mit Grenzen.
 * `delimiter`: Trennzeichen aus der Erkennung (textSignature) – dieselbe Zerlegung wie bei der Erkennung (A-H7).
 */
export function readTable(text: string, delimiter?: Delimiter, limits: TextLimits = TEXT_LIMITS): Table {
  return tableFromRows(parseCsvBounded(text, delimiter, limits));
}

/**
 * Bereits zerlegte Zeilen → Tabelle (analyzeFile zerlegt jede Datei nur einmal). Steuerzeichen (NUL …) werden aus
 * Kopfzeile und Feldern entfernt – zusätzlich zu decodeText, falls Zeilen aus anderer Quelle kommen (A-B2).
 */
export function tableFromRows(rows: string[][]): Table {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => normHeader(stripControl(h)));
  const records = rows.slice(1).map((r, i) => {
    const values: Record<string, string> = {};
    headers.forEach((h, k) => {
      if (h && values[h] === undefined) values[h] = stripControl(r[k] ?? "").trim();
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
}

/**
 * Signatur für die Erkennung – nur aus dem Anfang der Datei (erste 64 KB) und nur der ersten logischen Zeile,
 * damit die Erkennung unabhängig von der Dateigröße schnell bleibt (Code-Review CR6).
 */
export function textSignature(text: string): TextSignature {
  const head = stripBom(text.slice(0, SIGNATURE_BYTES));
  const firstLine = (head.split(/\r\n|\n|\r/).find((l) => l.trim() !== "") ?? "").trim();
  // Trennzeichen aus der ersten nicht-leeren Zeile (detectDelimiter liest nur bis zum ersten Zeilenende)
  const delimiter = detectDelimiter(head.replace(/^\s+/, ""));
  return { firstLine, delimiter, headers: parseCsv(head.slice(0, firstRowEnd(head)), delimiter)[0]?.map(normHeader) ?? [] };
}

/** Ende der ersten logischen Zeile (Zeilenumbrüche in Anführungszeichen gehören zum Feld; führende Leerzeilen übersprungen). */
function firstRowEnd(head: string): number {
  let inQ = false;
  let seen = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "\n" || c === "\r")) {
      if (seen) return i;
    } else if (c.trim() !== "") seen = true;
  }
  return head.length;
}
