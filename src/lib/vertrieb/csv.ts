/**
 * CSV-Import für Vertriebs-Leads.
 * Format: UTF-8 (BOM erlaubt), Trennzeichen „;“ oder „,“ (aus der Kopfzeile erkannt), Felder optional in "…".
 * Spalten (Kopfzeile, Reihenfolge egal, Groß/Klein egal): name,email,phone,website,street,zip,city,distance_km,source,notes
 * Zusätzlich erlaubt: contact_person (Ansprechpartner:in). Pflicht: name.
 * Dublettenprüfung: E-Mail (ohne Groß/Klein) und Name+PLZ – innerhalb der Datei und gegen den Bestand; Sperrliste wird übersprungen.
 */
import { normalizeEmail } from "./eligibility";

export const CSV_COLUMNS = ["name", "email", "phone", "website", "street", "zip", "city", "distance_km", "source", "notes", "contact_person"] as const;
type Column = (typeof CSV_COLUMNS)[number];

export const CSV_MAX_BYTES = 1_000_000;
export const CSV_MAX_ROWS = 2000;

const ALIASES: Record<string, Column> = {
  praxis: "name",
  "e-mail": "email",
  mail: "email",
  telefon: "phone",
  strasse: "street",
  straße: "street",
  plz: "zip",
  ort: "city",
  entfernung_km: "distance_km",
  distanz_km: "distance_km",
  quelle: "source",
  notizen: "notes",
  ansprechpartner: "contact_person",
};

export type LeadInput = {
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  distanceKm: number | null;
  source: string | null;
  notes: string | null;
};

export type ParsedRow = { line: number; lead: LeadInput } | { line: number; error: string };

/** Zerlegt CSV-Text in Zeilen/Felder (RFC 4180: Anführungszeichen, "" als Escape, Umbrüche in Feldern). */
export function splitCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function detectSeparator(headerLine: string): ";" | "," {
  const semi = (headerLine.match(/;/g) ?? []).length;
  const comma = (headerLine.match(/,/g) ?? []).length;
  return semi >= comma && semi > 0 ? ";" : ",";
}

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const cell = (v: string | undefined, max: number): string | null => {
  // eslint-disable-next-line no-control-regex
  const s = (v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, max) : null;
};

function parseDistance(v: string | null): number | null | "invalid" {
  if (!v) return null;
  const n = Number(v.replace(",", ".").replace(/\s*km$/i, ""));
  return Number.isFinite(n) && n >= 0 && n < 10_000 ? Math.round(n * 10) / 10 : "invalid";
}

function normalizeWebsite(v: string | null): string | null {
  if (!v) return null;
  const s = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString().slice(0, 300) : null;
  } catch {
    return null;
  }
}

export function parseLeadCsv(raw: string): { rows: ParsedRow[]; error?: string } {
  const text = raw.replace(/^﻿/, "");
  if (!text.trim()) return { rows: [], error: "Die Datei ist leer." };
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = detectSeparator(firstLine);
  const table = splitCsv(text, sep);
  const header = table[0].map((h) => {
    const k = h.trim().toLowerCase().replace(/\s+/g, "_");
    return (CSV_COLUMNS as readonly string[]).includes(k) ? (k as Column) : (ALIASES[k] ?? null);
  });
  if (!header.includes("name")) return { rows: [], error: "Spalte „name“ fehlt in der Kopfzeile." };
  if (table.length - 1 > CSV_MAX_ROWS) return { rows: [], error: `Zu viele Zeilen (max. ${CSV_MAX_ROWS}).` };
  const rows: ParsedRow[] = [];
  for (let r = 1; r < table.length; r++) {
    const rec: Partial<Record<Column, string>> = {};
    header.forEach((col, i) => {
      if (col) rec[col] = table[r][i];
    });
    const line = r + 1;
    const name = cell(rec.name, 200);
    if (!name) {
      rows.push({ line, error: "Name fehlt" });
      continue;
    }
    const email = cell(rec.email, 254);
    if (email && !EMAIL_RE.test(email)) {
      rows.push({ line, error: `Ungültige E-Mail „${email.slice(0, 60)}“` });
      continue;
    }
    const dist = parseDistance(cell(rec.distance_km, 20));
    if (dist === "invalid") {
      rows.push({ line, error: "distance_km ist keine Zahl" });
      continue;
    }
    rows.push({
      line,
      lead: {
        name,
        contactPerson: cell(rec.contact_person, 120),
        email: email ? normalizeEmail(email) : null,
        phone: cell(rec.phone, 60),
        website: normalizeWebsite(cell(rec.website, 300)),
        street: cell(rec.street, 200),
        zip: cell(rec.zip, 10),
        city: cell(rec.city, 120),
        distanceKm: dist,
        source: cell(rec.source, 120),
        notes: cell(rec.notes, 2000),
      },
    });
  }
  return { rows };
}

export const nameZipKey = (name: string, zip: string | null) => `${name.trim().toLowerCase().replace(/\s+/g, " ")}|${(zip ?? "").trim()}`;

export type ImportDecision = { line: number; lead: LeadInput; action: "neu" } | { line: number; lead?: LeadInput; action: "übersprungen"; reason: string };

/** Entscheidet je Zeile: neu oder übersprungen (Fehler, Dublette in Datei/Bestand, Sperrliste). */
export function dedupeLeads(
  rows: ParsedRow[],
  existing: { emails: ReadonlySet<string>; nameZips: ReadonlySet<string>; suppressed: ReadonlySet<string> },
): ImportDecision[] {
  const emails = new Set(existing.emails);
  const nameZips = new Set(existing.nameZips);
  const out: ImportDecision[] = [];
  for (const r of rows) {
    if ("error" in r) {
      out.push({ line: r.line, action: "übersprungen", reason: r.error });
      continue;
    }
    const { lead } = r;
    const nz = nameZipKey(lead.name, lead.zip);
    if (lead.email && existing.suppressed.has(lead.email)) out.push({ line: r.line, lead, action: "übersprungen", reason: "Auf der Sperrliste (abgemeldet)" });
    else if (lead.email && emails.has(lead.email)) out.push({ line: r.line, lead, action: "übersprungen", reason: "E-Mail bereits vorhanden" });
    else if (nameZips.has(nz)) out.push({ line: r.line, lead, action: "übersprungen", reason: "Name und PLZ bereits vorhanden" });
    else {
      out.push({ line: r.line, lead, action: "neu" });
      if (lead.email) emails.add(lead.email);
      nameZips.add(nz);
    }
  }
  return out;
}
