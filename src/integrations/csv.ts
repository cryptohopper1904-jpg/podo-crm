/**
 * Minimaler, robuster CSV-Parser/-Writer (RFC 4180 + Excel-Eigenheiten):
 * - Anführungszeichen, verdoppelte "" in Feldern, Zeilenumbrüche in Feldern
 * - Trennzeichen-Erkennung (Semikolon, Komma, Tab) anhand der Kopfzeile
 * - UTF-8-BOM wird entfernt, CRLF/LF/CR
 */

export type Delimiter = ";" | "," | "\t";

/** Ermittelt das Trennzeichen anhand der ersten (logischen) Zeile außerhalb von Anführungszeichen. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && (c === ";" || c === "," || c === "\t")) counts[c]++;
  }
  if (counts[";"] >= counts[","] && counts[";"] >= counts["\t"] && counts[";"] > 0) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Zerlegt CSV-Text in Zeilen aus Feldern. Leere Zeilen werden entfernt. */
export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = stripBom(input);
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (c === d) {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\r" || c === "\n") {
      pushRow();
      i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Wie parseCsv, aber mit Kopfzeile → Objekte. `row` ist die 1-basierte Zeilennummer in der Datei (Kopf = 1). */
export function parseCsvObjects(
  input: string,
  delimiter?: Delimiter,
): { headers: string[]; records: { row: number; values: Record<string, string> }[] } {
  const rows = parseCsv(input, delimiter);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      values[h] = (r[i] ?? "").trim();
    });
    return { row: idx + 2, values };
  });
  return { headers, records };
}

function escapeField(value: unknown, d: Delimiter): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(d) || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Schreibt CSV. Standard: Semikolon + BOM + CRLF (Excel-kompatibel im deutschen Gebietsschema). */
export function writeCsv(
  rows: unknown[][],
  opts: { delimiter?: Delimiter; bom?: boolean; eol?: "\r\n" | "\n" } = {},
): string {
  const d = opts.delimiter ?? ";";
  const eol = opts.eol ?? "\r\n";
  const body = rows.map((r) => r.map((v) => escapeField(v, d)).join(d)).join(eol) + eol;
  return (opts.bom ?? true ? "﻿" : "") + body;
}
