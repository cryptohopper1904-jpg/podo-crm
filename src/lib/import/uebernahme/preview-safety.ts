/**
 * Schutz der Vorschau des Übernahme-Assistenten: Klardaten in Hinweisen maskieren und Durchläufe je Person drosseln.
 * (AppSec-Hinweis: Warnungen dürfen keine E-Mail-Adressen, Geburtsdaten oder Telefonnummern im Klartext zeigen.)
 */
import { createRateLimiter } from "@/lib/rate-limit";
import type { DuplicateDecision, FileSummary, ImportPlan, PlanTotals } from "./plan";

/** Vorschau + Import zusammen: höchstens 20 Durchläufe je Person und Praxis in 10 Minuten */
export const uebernahmeLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20, maxKeys: 2_000 });

const EMAIL = /[^\s@„“"'()<>,;]+@[^\s@„“"'()<>,;]*\.[^\s@„“"'()<>,;]*[^\s@„“"'()<>,;.]/g;
/** Telefonnummern: beginnt mit + oder 0, mindestens 7 Ziffern (Rechnungsnummern wie RE-2026-00001 bleiben) */
const PHONE = /(?:\+|\b0)\d[\d /-]{5,}\d/g;
const SENSITIVE = /geburt|e-?mail|telefon|handy|mobil|festnetz/i;

export function maskPii(message: string): string {
  let m = message.replace(EMAIL, "***@***").replace(PHONE, "***");
  if (SENSITIVE.test(m)) {
    // Rohwerte in Anführungszeichen bzw. Klammern (z. B. „31.02.1950“, (0151 …)) – nicht das Pseudonym „(Jg. 1950)“
    m = m.replace(/„[^“]*“/g, "„***“").replace(/\((?!Jg\. \d{4}\))[^()]*\d[^()]*\)/g, "(***)");
  }
  return m;
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
  decisions: Pick<DuplicateDecision, "key" | "who" | "sourceLabel" | "candidates" | "defaultChoice">[];
  decisionsTotal: number;
  hasWork: boolean;
}

/** höchstens so viele Dateien, Hinweise und Entscheidungen in der Vorschau */
const PREVIEW_MAX = 200;

export function toPreview(plan: ImportPlan): UebernahmePreview {
  return {
    // gekürzt wie die Hinweise (AppSec A-H4: ein ZIP mit Tausenden Einträgen bläht sonst die Antwort auf)
    files: plan.files.slice(0, PREVIEW_MAX).map((f) => ({ ...f, note: f.note ? maskPii(f.note) : f.note })),
    filesTotal: plan.files.length,
    totals: plan.totals,
    // E-Mail-Adressen, Geburtsdaten und Telefonnummern in Hinweisen maskiert (Vorschau zeigt keine Klardaten)
    warnings: plan.warnings.slice(0, PREVIEW_MAX).map((w) => ({ ...w, message: maskPii(w.message) })),
    warningsTotal: plan.warnings.length,
    samples: plan.samples,
    cashbook: plan.cashbook,
    decisions: plan.decisions.slice(0, PREVIEW_MAX).map(({ key, who, sourceLabel, candidates, defaultChoice }) => ({ key, who, sourceLabel, candidates, defaultChoice })),
    decisionsTotal: plan.decisions.length,
    hasWork: plan.hasWork,
  };
}

