/**
 * Schutz der Vorschau des Übernahme-Assistenten: Klardaten in Hinweisen maskieren und Durchläufe je Person drosseln.
 * (AppSec-Hinweis: Warnungen dürfen keine E-Mail-Adressen, Geburtsdaten oder Telefonnummern im Klartext zeigen.)
 */
import { createRateLimiter } from "@/lib/rate-limit";
import type { DuplicateDecision, FileSummary, ImportPlan, PlanTotals } from "./plan";

/** Vorschau + Import zusammen: höchstens 20 Durchläufe je Person und Praxis in 10 Minuten */
export const uebernahmeLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20, maxKeys: 2_000 });

/**
 * E-Mail-Adressen: Teil vor und nach dem „@“ mit festen Obergrenzen (64 bzw. 253 Zeichen wie RFC 5321) und ohne
 * verschachtelte Quantoren – der Aufwand bleibt linear in der Länge der Meldung (AppSec A-B1, ReDoS). Ob der Teil nach
 * dem „@“ einen Punkt enthält, prüft emailMask, nicht der reguläre Ausdruck.
 */
const EMAIL = /[^\s@„“"'()<>,;]{1,64}@[^\s@„“"'()<>,;]{1,253}/g;
/** Telefonnummern: beginnt mit + oder 0, mindestens 7 Ziffern (Rechnungsnummern wie RE-2026-00001 bleiben) */
const PHONE = /(?:\+|\b0)\d[\d /-]{5,}\d/g;
const SENSITIVE = /geburt|e-?mail|telefon|handy|mobil|festnetz/i;

function emailMask(m: string): string {
  const at = m.indexOf("@");
  // Punkte am Ende gehören zum Satz, nicht zur Adresse
  const domain = m.slice(at + 1).replace(/\.+$/, "");
  if (!domain.includes(".")) return m;
  return `***@***${m.slice(at + 1 + domain.length)}`;
}

export function maskPii(message: string): string {
  let m = message.replace(EMAIL, emailMask).replace(PHONE, "***");
  if (SENSITIVE.test(m)) {
    // Rohwerte in Anführungszeichen bzw. Klammern (z. B. „31.02.1950“, (0151 …)) – nicht das Pseudonym „(Jg. 1950)“.
    // Ohne Längengrenze, auch unbeendet bis zum Ende (Meldung ist vorher auf 500 Zeichen gekürzt, R3-5); linear, weil
    // jeder Treffer am nächsten Abschluss- bzw. Klammerzeichen endet und Versuche nur an „ bzw. ( beginnen.
    m = m.replace(/„[^“]*(?:“|$)/g, (x) => (x.endsWith("“") ? "„***“" : "„***")).replace(/\((?!Jg\. \d{4}\))[^()\d]*\d[^()]*(?:\)|$)/g, (x) => (x.endsWith(")") ? "(***)" : "(***"));
  }
  return m;
}

/** Meldungen und Dateinotizen in der Vorschau: höchstens so viele Zeichen (vor dem Maskieren gekürzt, A-B1) */
export const PREVIEW_MESSAGE_MAX = 500;
const short = (s: string) => (s.length > PREVIEW_MESSAGE_MAX ? `${s.slice(0, PREVIEW_MESSAGE_MAX)}…` : s);

/**
 * Fehler für das Server-Log: nur Fehlerart und – falls vorhanden – Fehlercode (z. B. Postgres „22021“), nie die
 * Meldung. Datenbankfehler enthalten die Abfrage samt Parametern, also Klardaten von Patient:innen (AppSec A-B2).
 */
export function errorForLog(e: unknown): string {
  if (!(e instanceof Error)) return "unbekannter Fehler";
  const codeOf = (x: unknown) => {
    const c = x && typeof x === "object" && "code" in x ? (x as { code: unknown }).code : undefined;
    // nur SQLSTATE (fünf Zeichen, z. B. 23505, 22P02) oder Node-Fehlercodes (ERR_…) – keine freien Texte (R3-7)
    return typeof c === "string" && (/^[0-9A-Z]{5}$/.test(c) || /^ERR_[A-Z_]{1,60}$/.test(c)) ? c : null;
  };
  const code = codeOf(e) ?? codeOf(e.cause);
  const name = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(e.name) ? e.name : "Error";
  return code ? `${name} ${code}` : name;
}

/** Vorschau, wie sie an den Browser geht (gekürzt, Klardaten maskiert) */
export interface UebernahmePreview {
  files: FileSummary[];
  filesTotal: number;
  totals: PlanTotals;
  warnings: { file?: string; row?: number; message: string }[];
  warningsTotal: number;
  samples: ImportPlan["samples"];
  cashbook: ImportPlan["cashbook"];
  /** Vorschläge aus den Pododesk-Praxisstammdaten (nur Zahlen, keine Personendaten) */
  practiceHints: string[];
  /** Kalenderfarben, die für Teammitglieder ohne Farbe gesetzt werden */
  therapistColors: number;
  decisions: Pick<DuplicateDecision, "key" | "who" | "sourceLabel" | "candidates" | "defaultChoice" | "newLabel">[];
  decisionsTotal: number;
  hasWork: boolean;
}

/** höchstens so viele Dateien, Hinweise und Entscheidungen in der Vorschau */
const PREVIEW_MAX = 200;

/** Hinweise für den Browser: höchstens 200, je Meldung erst gekürzt, dann maskiert (auch Excel-/Doctolib-Einzelimport, R3-9) */
export function safeWarnings<T extends { message: string }>(list: readonly T[]): T[] {
  return list.slice(0, PREVIEW_MAX).map((w) => ({ ...w, message: maskPii(short(w.message)) }));
}

export function toPreview(plan: ImportPlan): UebernahmePreview {
  return {
    // gekürzt wie die Hinweise (AppSec A-H4: ein ZIP mit Tausenden Einträgen bläht sonst die Antwort auf)
    files: plan.files.slice(0, PREVIEW_MAX).map((f) => ({ ...f, note: f.note ? maskPii(short(f.note)) : f.note })),
    filesTotal: plan.files.length,
    totals: plan.totals,
    // E-Mail-Adressen, Geburtsdaten und Telefonnummern in Hinweisen maskiert (Vorschau zeigt keine Klardaten);
    // erst kürzen, dann maskieren (A-B1: Aufwand je Meldung begrenzt)
    warnings: safeWarnings(plan.warnings),
    warningsTotal: plan.warnings.length,
    samples: plan.samples,
    cashbook: plan.cashbook,
    practiceHints: plan.practiceHints.slice(0, 20),
    therapistColors: plan.therapistColors.length,
    decisions: plan.decisions.slice(0, PREVIEW_MAX).map(({ key, who, sourceLabel, candidates, defaultChoice, newLabel }) => ({ key, who, sourceLabel, candidates, defaultChoice, newLabel })),
    decisionsTotal: plan.decisions.length,
    hasWork: plan.hasWork,
  };
}

