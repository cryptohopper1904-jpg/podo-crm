/**
 * Zellwert-Normalisierung für exceljs: Formeln (gecachtes Ergebnis), Rich-Text, Hyperlinks,
 * Excel-Seriendaten, deutsche Zahlen- und Datumsformate.
 */
import type { Cell, CellValue } from "exceljs";

export type Primitive = string | number | boolean | Date | null;

export interface ReadCell {
  value: Primitive;
  /** Formel ohne gespeichertes Ergebnis (Datei nie in Excel neu berechnet/gespeichert) */
  formulaWithoutResult?: string;
  error?: string;
}

/** Liest einen Zellwert; bei Formeln das gecachte Ergebnis. =ROW()-n wird nachgerechnet. */
export function readCell(cell: Cell | undefined, rowNumber: number): ReadCell {
  if (!cell) return { value: null };
  return normalize(cell.value, rowNumber);
}

function normalize(v: CellValue, rowNumber: number): ReadCell {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { value: v };
  if (v instanceof Date) return { value: v };
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const f = v as { formula?: string; sharedFormula?: string; result?: unknown };
      const formula = f.formula ?? f.sharedFormula ?? "";
      if (f.result !== undefined && f.result !== null) {
        if (typeof f.result === "object" && !(f.result instanceof Date) && "error" in (f.result as object)) {
          return { value: null, error: String((f.result as { error: string }).error) };
        }
        return { value: f.result as Primitive };
      }
      const row = formula.replace(/\s/g, "").match(/^ROW\(\)-(\d+)$/i);
      if (row) return { value: rowNumber - Number(row[1]) };
      if (/^ROW\(\)$/i.test(formula.replace(/\s/g, ""))) return { value: rowNumber };
      return { value: null, formulaWithoutResult: formula };
    }
    if ("richText" in v) return { value: (v as { richText: { text: string }[] }).richText.map((r) => r.text).join("") };
    if ("text" in v && "hyperlink" in v) {
      const t = (v as { text: unknown }).text;
      return { value: typeof t === "string" ? t : typeof t === "object" && t && "richText" in t ? (t as { richText: { text: string }[] }).richText.map((r) => r.text).join("") : String(t) };
    }
    if ("error" in v) return { value: null, error: String((v as { error: string }).error) };
  }
  return { value: String(v) };
}

export function asString(v: Primitive): string | null {
  if (v === null) return null;
  if (v instanceof Date) return toIsoDate(v);
  const s = String(v).replace(/ /g, " ").trim();
  return s === "" ? null : s;
}

/** Excel-Seriennummer (1900-System) → Date (UTC) */
export function excelSerialToDate(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
}

function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** → YYYY-MM-DD oder null. exceljs liefert Datumszellen als UTC-Date. */
export function toIsoDate(v: Primitive): string | null {
  if (v === null || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === "number") {
    if (v < 1 || v > 2958465) return null;
    return toIsoDate(excelSerialToDate(v));
  }
  if (typeof v === "boolean") return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += y > 30 ? 1900 : 2000;
    return ymd(y, Number(m[2]), Number(m[1]));
  }
  return null;
}

/** Zahl aus Zahl/String („65,00 €“, „1.234,50“, „19%“). Nicht lesbar → null. */
export function toNumber(v: Primitive): number | null {
  if (v === null || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  let s = v.replace(/[€%\s ]/g, "").replace(/EUR/i, "");
  if (s === "" || s === "-") return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Euro → Cent (gerundet) */
export function toCents(v: Primitive): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.round(n * 100);
}

/** Minuten aus Zahl, „40“, „0:40“ oder Excel-Uhrzeit (Bruchteil eines Tages / Date). */
export function toMinutes(v: Primitive): number | null {
  if (v === null) return null;
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
  if (typeof v === "number") return v > 0 && v < 1 ? Math.round(v * 1440) : Math.round(v);
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const n = toNumber(v.replace(/min\.?|minuten/i, ""));
    return n === null ? null : Math.round(n);
  }
  return null;
}

/** Steuersatz in Prozent: 0, 7, 19 (auch 0.19 oder „19 %“). */
export function toVatRate(v: Primitive): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return n > 0 && n < 1 ? Math.round(n * 100) : Math.round(n);
}

export const normalizeHeader = (h: string) =>
  h.replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
