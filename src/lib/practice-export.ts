/**
 * Reine Hilfsfunktionen für den vollständigen Praxis-Export (ohne DB-Zugriff, testbar).
 * Der eigentliche Export liegt in src/server/practice-export.ts.
 */
import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { berlinDateIso } from "./format";

/**
 * Tabellen, die nicht in den Export gehören (Sitzungen, plattformweite Technik-Protokolle, interner Zustand des
 * Archiv-Nachhol-Laufs – archive_catchup_attempts ist kein Geschäftsvorfall).
 */
export const EXCLUDED_TABLES = new Set(["sessions", "billing_events", "webhook_events", "archive_catchup_attempts"]);

/** Spalten (SQL-Namen), die nie exportiert werden: Geheimnisse, Hashes von Zugangstoken, interne Speicherpfade. */
export const STRIPPED_COLUMNS = new Set(["password_hash", "totp_secret_enc", "totp_last_step", "secret_enc", "token_hash", "storage_key"]);

export type ExportTable = { name: string; table: PgTable; strippedKeys: string[] };

/** Alle Mandanten-Tabellen (mit organization_id) aus dem Schema – neue Tabellen werden automatisch erfasst. */
export function tenantTables(): ExportTable[] {
  const out: ExportTable[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    if (cfg.name === "organizations" || EXCLUDED_TABLES.has(cfg.name)) continue;
    if (!cfg.columns.some((c) => c.name === "organization_id")) continue;
    const strippedKeys = Object.entries(getTableColumns(value))
      .filter(([, col]) => STRIPPED_COLUMNS.has(col.name))
      .map(([key]) => key);
    out.push({ name: cfg.name, table: value, strippedKeys });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function stripRow<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Partial<T> {
  if (!keys.length) return row;
  const copy: Record<string, unknown> = { ...row };
  for (const k of keys) delete copy[k];
  return copy as Partial<T>;
}

/** Schlüsselnamen in JSON-Einstellungen, die Geheimnisse/Chiffrate enthalten (z. B. settings.ocr.apiKeyEnc). */
export const SECRET_KEY_RE = /enc$|secret|password|token|api_?key/i;

/** Entfernt rekursiv alle Schlüssel, deren Name nach Geheimnis aussieht (Objekte und Arrays, ohne Mutation). */
export function stripSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map((v) => stripSecretsDeep(v, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!SECRET_KEY_RE.test(k)) out[k] = stripSecretsDeep(v, depth + 1);
    return out;
  }
  return value;
}

/** Praxis-Stammdaten für den Export: Einstellungen ohne Geheimnisse (OCR-Schlüssel u. Ä.). */
export function sanitizeOrganizationRow<T extends { settings?: unknown }>(row: T): T {
  return { ...row, settings: stripSecretsDeep(row.settings ?? {}) };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};

/** Pfad im ZIP: media/<Patientennummer>/<Datum>_<Zweck>_<ID-Kurz>.<Endung> – ohne Namen, nur sichere Zeichen. */
export function mediaPath(m: { id: string; mime: string; purpose: string; takenAt: Date | string }, patientNumber: number | string | null | undefined): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const day = berlinDateIso(new Date(m.takenAt)); // Aufnahmetag in Berlin
  const folder = patientNumber === null || patientNumber === undefined ? "ohne-zuordnung" : safe(String(patientNumber));
  return `media/${folder}/${day}_${safe(m.purpose)}_${safe(m.id.slice(0, 8))}.${EXT[m.mime] ?? "bin"}`;
}

/** JSON mit Datumswerten als ISO-Strings und BigInt als String. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
