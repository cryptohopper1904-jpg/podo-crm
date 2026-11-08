/**
 * Verordnungs-OCR: Feldkatalog und strikte Prüfung der Modellantwort (rein, ohne I/O – testbar).
 *
 * Grundsätze
 *  - Die Modellantwort ist UNVERTRAUENSWÜRDIG (Bildinhalt kann Text enthalten, der wie eine
 *    Anweisung aussieht). Wir akzeptieren nur JSON, nur bekannte Felder, nur gültige Formate.
 *  - Ungültige einzelne Felder werden verworfen (Teilergebnis bleibt nutzbar), Freitexte bereinigt.
 *  - Ergebnis ist IMMER nur ein Vorschlag: die Praxis prüft jedes Feld und klickt „Übernehmen“.
 */
import { z } from "zod";
import { DIAGNOSIS_GROUP_CODES, type DiagnosisGroup } from "@/lib/rules/prescription";

export const OCR_SCHEMA_VERSION = "ocr-m13-v1";

/** maximale Größe der Modellantwort (Zeichen) – alles darüber ist kein sinnvolles Formular */
export const MAX_OUTPUT_CHARS = 20_000;

export type OcrPosition = { position?: string; label: string; units: number };

export interface OcrValues {
  patientName: string;
  patientBirthDate: string;
  /** Kassennummer (IK der Krankenkasse, 9 Ziffern) */
  insurerIk: string;
  /** Versichertennummer (Buchstabe + 9 Ziffern) */
  insuranceNumber: string;
  doctorName: string;
  doctorBsnr: string;
  doctorLanr: string;
  issuedAt: string;
  remedy: string;
  positions: OcrPosition[];
  units: number;
  frequencyPerWeek: string;
  icd10: string;
  diagnosisGroup: DiagnosisGroup;
  leitsymptomatik: string;
  urgent: boolean;
  homeVisit: boolean;
}

export type OcrFieldKey = keyof OcrValues;
export type OcrField<K extends OcrFieldKey = OcrFieldKey> = { value: OcrValues[K]; confidence: number };
export type OcrFields = { [K in OcrFieldKey]?: OcrField<K> };

export interface OcrSuggestion {
  version: typeof OCR_SCHEMA_VERSION;
  fields: OcrFields;
  /** Feldnamen, die verworfen wurden (keine Inhalte – darf ins Protokoll) */
  rejected: OcrFieldKey[];
}

export const OCR_FIELD_LABELS: Record<OcrFieldKey, string> = {
  patientName: "Versicherte:r – Name",
  patientBirthDate: "Versicherte:r – Geburtsdatum",
  insurerIk: "Kassennummer (IK)",
  insuranceNumber: "Versichertennummer",
  doctorName: "Arzt / Praxis",
  doctorBsnr: "BSNR",
  doctorLanr: "LANR",
  issuedAt: "Ausstellungsdatum",
  remedy: "Heilmittel",
  positions: "Heilmittelpositionen",
  units: "Anzahl Einheiten",
  frequencyPerWeek: "Frequenz",
  icd10: "Diagnose (ICD-10)",
  diagnosisGroup: "Diagnosegruppe",
  leitsymptomatik: "Leitsymptomatik",
  urgent: "Dringlicher Behandlungsbedarf",
  homeVisit: "Hausbesuch",
};

export const OCR_FIELD_KEYS = Object.keys(OCR_FIELD_LABELS) as OcrFieldKey[];

// ───────────────────────── Bereinigung ─────────────────────────

/** Muster, die in einem Verordnungsfeld nichts zu suchen haben (Prompt-Injection, Links, Markup, Code). */
const SUSPICIOUS: RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /<\s*\/?\s*[a-z!]/i,
  /\{\{|\}\}|\$\{/,
  /```/,
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|above|all|instructions?|prompt)\b/i,
  /\b(ignorier|vergiss|missacht)\w*\b.{0,40}\b(anweisung|vorherig|oben|prompt|regeln)/i,
  /\b(system|developer)\s*(prompt|message|nachricht)\b/i,
  /\b(you are|du bist jetzt|act as|als ki|as an ai)\b/i,
  /\b(assistant|system|user)\s*:/i,
  /\b(api[_ -]?key|password|passwort|token)\b/i,
  /\b(select|insert|update|delete|drop)\b\s.+\b(from|into|table|where)\b/i,
];

/** Steuerzeichen, Zero-Width, Bidi-Overrides */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

/** Freitext bereinigen; null = verwerfen */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  let s = String(v).normalize("NFC").replace(INVISIBLE, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!s) return null;
  if (SUSPICIOUS.some((re) => re.test(s))) return null;
  // Formelzeichen, die auf Papier-Verordnungen nicht vorkommen
  s = s.replace(/[<>{}[\]`|\\^~]/g, "").trim();
  // Formularfelder sind kurz – überlange Texte sind kein Feldinhalt, sondern Fehlleistung/Injektion
  if (s.length > max) return null;
  // muss überwiegend aus Buchstaben/Ziffern bestehen (kein Zeichensalat)
  const letters = (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters < Math.ceil(s.length * 0.5)) return null;
  return s;
}

const digits = (n: number) => (v: unknown) => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/[\s.-]/g, "");
  return new RegExp(`^\\d{${n}}$`).test(s) ? s : null;
};

/** Datum aus ISO (YYYY-MM-DD) oder deutsch (TT.MM.JJ[JJ]) → ISO; nur plausible Kalenderdaten. */
export function cleanDate(v: unknown, opts: { minYear?: number; maxYear?: number } = {}): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  let hit = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else {
    hit = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
    if (!hit) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (y < 100) y += y > 50 ? 1900 : 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < (opts.minYear ?? 1900) || y > (opts.maxYear ?? 2100)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const ICD10 = /^[A-TV-Z]\d{2}(\.\d{1,3})?[GVZA]?$/;

function cleanBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "ja" || v === "x" || v === "X") return true;
  if (v === "false" || v === "nein" || v === "") return false;
  return null;
}

function cleanInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,3}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function cleanPositions(v: unknown): OcrPosition[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) return null;
  const out: OcrPosition[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const label = cleanText(r.label ?? "", 200) ?? "";
    const position = r.position == null || r.position === "" ? undefined : digits(5)(r.position);
    if (position === null) return null;
    const units = cleanInt(r.units, 1, 99);
    if (units === null || (!label && !position)) return null;
    out.push({ ...(position ? { position } : {}), label, units });
  }
  return out;
}

const thisYear = () => new Date().getUTCFullYear();

/** Feld-Validatoren: liefern den bereinigten Wert oder null (= Feld verwerfen). */
const VALIDATORS: { [K in OcrFieldKey]: (v: unknown) => OcrValues[K] | null } = {
  patientName: (v) => cleanText(v, 120),
  patientBirthDate: (v) => cleanDate(v, { minYear: 1900, maxYear: thisYear() }),
  insurerIk: digits(9),
  insuranceNumber: (v) => {
    if (typeof v !== "string") return null;
    const s = v.replace(/\s/g, "").toUpperCase();
    return /^[A-Z]\d{9}$/.test(s) ? s : null;
  },
  doctorName: (v) => cleanText(v, 200),
  doctorBsnr: digits(9),
  doctorLanr: digits(9),
  issuedAt: (v) => cleanDate(v, { minYear: 2015, maxYear: thisYear() + 1 }),
  remedy: (v) => cleanText(v, 300),
  positions: cleanPositions,
  units: (v) => cleanInt(v, 1, 99),
  frequencyPerWeek: (v) => cleanText(v, 80),
  icd10: (v) => {
    if (typeof v !== "string") return null;
    const s = v.trim().toUpperCase().replace(/\s/g, "");
    return ICD10.test(s) ? s : null;
  },
  diagnosisGroup: (v) => {
    if (typeof v !== "string") return null;
    const s = v.trim().toUpperCase().replace(/\s/g, "") as DiagnosisGroup;
    return DIAGNOSIS_GROUP_CODES.includes(s) ? s : null;
  },
  leitsymptomatik: (v) => cleanText(v, 300),
  urgent: cleanBool,
  homeVisit: cleanBool,
};

const confidenceOf = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  // manche Modelle antworten in Prozent
  const p = n > 1 && n <= 100 ? n / 100 : n;
  return Math.round(Math.min(1, Math.max(0, p)) * 100) / 100;
};

/** Grobe Struktur der Modellantwort: { fields: { key: { value, confidence } } } */
const rawOutput = z.object({
  fields: z.record(z.string().max(40), z.object({ value: z.unknown(), confidence: z.unknown().optional() }).loose()),
});

export class OcrOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrOutputError";
  }
}

/** Prüft/bereinigt bereits geparste Felder (auch für erneut eingereichte importData). */
export function normalizeFields(input: unknown): OcrSuggestion {
  const parsed = rawOutput.safeParse(input);
  if (!parsed.success) throw new OcrOutputError("Die Auslesung hat nicht das erwartete Format.");
  const fields: OcrFields = {};
  const rejected: OcrFieldKey[] = [];
  for (const key of OCR_FIELD_KEYS) {
    const f = parsed.data.fields[key];
    if (!f || f.value === null || f.value === undefined || f.value === "") continue;
    const value = VALIDATORS[key](f.value);
    if (value === null) {
      rejected.push(key);
      continue;
    }
    (fields as Record<string, OcrField>)[key] = { value, confidence: confidenceOf(f.confidence) } as OcrField;
  }
  return { version: OCR_SCHEMA_VERSION, fields, rejected };
}

/**
 * Modellantwort (Text) → geprüfter Vorschlag. Nur ein JSON-Objekt ist erlaubt
 * (höchstens in einem ```json-Block); alles andere wird abgelehnt.
 */
export function parseOcrOutput(text: unknown): OcrSuggestion {
  if (typeof text !== "string") throw new OcrOutputError("Leere Antwort des Auslesedienstes.");
  if (text.length > MAX_OUTPUT_CHARS) throw new OcrOutputError("Antwort des Auslesedienstes ist zu groß.");
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  if (!s.startsWith("{") || !s.endsWith("}")) throw new OcrOutputError("Antwort des Auslesedienstes ist kein JSON.");
  let json: unknown;
  try {
    json = JSON.parse(s);
  } catch {
    throw new OcrOutputError("Antwort des Auslesedienstes ist kein gültiges JSON.");
  }
  const result = normalizeFields(json);
  if (Object.keys(result.fields).length === 0) throw new OcrOutputError("Auf dem Foto wurden keine verwertbaren Angaben erkannt.");
  return result;
}

/** Felder mit geringer Sicherheit hervorheben */
export const LOW_CONFIDENCE = 0.6;

/** Was als importData gespeichert wird (kein Bild, keine Rohantwort). */
export interface OcrImportData {
  kind: "ocr";
  version: typeof OCR_SCHEMA_VERSION;
  mock: boolean;
  at: string;
  fields: OcrFields;
  rejected: OcrFieldKey[];
  /** Felder, die beim Übernehmen vom Vorschlag abweichen (nur Namen) */
  edited: string[];
}

/** Prüft die vom Formular zurückgesendete importData erneut (Client ist nicht vertrauenswürdig). */
export function parseImportData(raw: unknown): OcrImportData | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_OUTPUT_CHARS) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const shape = z
    .object({
      kind: z.literal("ocr"),
      mock: z.boolean(),
      at: z.string().datetime(),
      fields: z.record(z.string(), z.unknown()),
      edited: z.array(z.enum(OCR_FIELD_KEYS as [OcrFieldKey, ...OcrFieldKey[]])).max(OCR_FIELD_KEYS.length).default([]),
    })
    .safeParse(v);
  if (!shape.success) return null;
  try {
    const n = normalizeFields({ fields: shape.data.fields });
    return { kind: "ocr", version: OCR_SCHEMA_VERSION, mock: shape.data.mock, at: shape.data.at, fields: n.fields, rejected: n.rejected, edited: [...new Set(shape.data.edited)] };
  } catch {
    return null;
  }
}
