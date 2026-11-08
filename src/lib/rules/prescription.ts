/**
 * Versionierte Regeln für das Verordnungsmanagement (GKV, Heilmittel-Richtlinie Podologie).
 *
 * ⚠️ Vor Echtbetrieb gegen aktuelle HeilM-RL/§125-Vertrag prüfen!
 * Grundlage: Heilmittel-Richtlinie des G-BA (Heilmittelkatalog Podologie) und Vertrag nach § 125 Abs. 1
 * SGB V Podologie inkl. Leistungsbeschreibung (Lesefassung 2025). Alle Zahlenwerte (Fristen, Höchstmengen,
 * Frequenzen, Zuzahlung) sind hier als Konstanten hinterlegt, damit sie bei Vertragsänderungen an EINER
 * Stelle angepasst werden können. Jede Verordnung speichert die `rulesVersion`, mit der sie bewertet wurde.
 *
 * Alles hier sind reine Funktionen (keine DB, keine Uhr – das Datum wird übergeben) → testbar.
 */

export const RULES_VERSION = "heilm-rl-podo-2025-07-entwurf";

/** Spätester Behandlungsbeginn in Kalendertagen nach Ausstellungsdatum (HeilM-RL § 15). */
export const START_DEADLINE_DAYS = 28;
/** … bei „dringlichem Behandlungsbedarf“ */
export const START_DEADLINE_URGENT_DAYS = 14;
/** Ab so vielen Tagen vor Fristende wird gewarnt (gelbe Ampel) */
export const START_WARN_DAYS = 5;
/** Toleranz in Tagen, bevor eine Frequenzüberschreitung als Warnung gemeldet wird */
export const FREQUENCY_TOLERANCE_DAYS = 7;
/** Zuzahlung (§ 32 Abs. 2, § 61 Satz 3 SGB V): 10 € je Verordnung + 10 % der Kosten */
export const COPAYMENT_FLAT_CENTS = 1000;
export const COPAYMENT_PERCENT = 10;
/** Kinder und Jugendliche bis zur Vollendung des 18. Lebensjahres sind zuzahlungsfrei (§ 32 Abs. 2 SGB V) */
export const COPAYMENT_FREE_UNDER_AGE = 18;

export type DiagnosisGroup = "DF" | "NF" | "QF" | "UI1" | "UI2";

export type DiagnosisGroupRule = {
  code: DiagnosisGroup;
  label: string;
  /** Höchstmenge je Verordnung (Behandlungseinheiten) */
  maxUnitsPerPrescription: number;
  /** Frequenzempfehlung als Text (Vorbelegung im Formular) */
  defaultFrequency: string;
  /** Beispiele/Hinweise für ICD-10 (nur Anzeige, keine Prüfung) */
  icdHint: string;
};

export const DIAGNOSIS_GROUPS: Record<DiagnosisGroup, DiagnosisGroupRule> = {
  DF: {
    code: "DF",
    label: "DF – Diabetisches Fußsyndrom",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    icdHint: "z. B. E11.74, E10.74 (mit Angabe der Neuro-/Angiopathie)",
  },
  NF: {
    code: "NF",
    label: "NF – Neuropathie, nicht diabetisch",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    icdHint: "z. B. G60.0, G62.9",
  },
  QF: {
    code: "QF",
    label: "QF – Querschnittlähmung",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    icdHint: "z. B. G82.2",
  },
  UI1: {
    code: "UI1",
    label: "UI1 – Unguis incarnatus, Stadium 1 (Nagelspange)",
    maxUnitsPerPrescription: 8,
    defaultFrequency: "1x alle 1-4 Wochen",
    icdHint: "L60.0",
  },
  UI2: {
    code: "UI2",
    label: "UI2 – Unguis incarnatus, Stadium 2 (Nagelspange)",
    maxUnitsPerPrescription: 8,
    defaultFrequency: "1x alle 1-4 Wochen",
    icdHint: "L60.0",
  },
};

export const DIAGNOSIS_GROUP_CODES = Object.keys(DIAGNOSIS_GROUPS) as DiagnosisGroup[];

/** Vorschläge für das Frequenz-Feld */
export const FREQUENCY_OPTIONS = ["1x wöchentlich", "1x alle 2 Wochen", "1x alle 1-4 Wochen", "1x alle 3 Wochen", "1x alle 4 Wochen", "1x alle 4-6 Wochen", "1x alle 6 Wochen"];

// ───────────────────────── Status ─────────────────────────

export const PRESCRIPTION_STATUSES = ["open", "active", "completed", "billing_ready", "billed", "expired", "cancelled"] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export const STATUS_LABEL: Record<PrescriptionStatus, string> = {
  open: "offen",
  active: "in Behandlung",
  completed: "abgeschlossen",
  billing_ready: "abrechnungsreif",
  billed: "abgerechnet",
  expired: "verfallen",
  cancelled: "storniert",
};

const TRANSITIONS: Record<PrescriptionStatus, readonly PrescriptionStatus[]> = {
  open: ["active", "expired", "cancelled"],
  // vorzeitig „abrechnungsreif“ nur mit Abbruch-Begründung (siehe canTransition)
  active: ["completed", "billing_ready", "cancelled"],
  completed: ["billing_ready"],
  billing_ready: ["billed", "completed"],
  billed: [],
  expired: [],
  cancelled: [],
};

export function canTransition(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
  ctx: { unitsUsed?: number; units?: number; interruptionNote?: string | null } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!TRANSITIONS[from]?.includes(to)) return { ok: false, reason: `Statuswechsel ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]} ist nicht erlaubt.` };
  if (from === "active" && to === "billing_ready" && !(ctx.interruptionNote && ctx.interruptionNote.trim().length >= 5)) {
    return { ok: false, reason: "Vorzeitige Abrechnung nur mit Begründung des Behandlungsabbruchs." };
  }
  if (to === "billing_ready" && (ctx.unitsUsed ?? 0) === 0) return { ok: false, reason: "Ohne erbrachte Einheit gibt es nichts abzurechnen." };
  const early = ctx.units !== undefined && (ctx.unitsUsed ?? 0) < ctx.units;
  if (from === "active" && to === "completed" && early && !(ctx.interruptionNote && ctx.interruptionNote.trim().length >= 5)) {
    return { ok: false, reason: "Vorzeitiger Abschluss nur mit Begründung des Behandlungsabbruchs." };
  }
  return { ok: true };
}

/** Status nach einer neu dokumentierten Einheit (open → active, bei letzter Einheit → completed). */
export function statusAfterUnit(status: PrescriptionStatus, unitsUsedAfter: number, units: number): PrescriptionStatus {
  if (status !== "open" && status !== "active") return status;
  return unitsUsedAfter >= units ? "completed" : "active";
}

/** Kann auf diese Verordnung eine (weitere) Behandlung gebucht werden? */
export function acceptsUnit(status: string, unitsUsed: number, units: number): boolean {
  return (status === "open" || status === "active") && unitsUsed < units;
}

// ───────────────────────── Fristen & Frequenz ─────────────────────────

const DAY = 86_400_000;
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

export function addDaysIso(iso: string, days: number): string {
  return new Date(toUtc(iso) + days * DAY).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY);
}

/** Spätester Behandlungsbeginn (inklusive) */
export function startDeadline(issuedAt: string, urgent: boolean): string {
  return addDaysIso(issuedAt, urgent ? START_DEADLINE_URGENT_DAYS : START_DEADLINE_DAYS);
}

/**
 * Größter zulässiger Abstand zwischen zwei Behandlungen laut Frequenzangabe (in Tagen).
 * Versteht u. a. „1x wöchentlich“, „2x/Woche“, „1x alle 4-6 Wochen“, „alle 3 Wochen“, „14-tägig“.
 * Gibt null zurück, wenn die Angabe nicht verstanden wird (dann keine Prüfung).
 */
export function maxGapDays(frequency: string | null | undefined): number | null {
  if (!frequency) return null;
  const f = frequency.toLowerCase().replace(/\s+/g, " ").trim();
  const range = f.match(/alle (\d+)\s*(?:-|–|bis)\s*(\d+) woche/);
  if (range) return Number(range[2]) * 7;
  const every = f.match(/alle (\d+) woche/);
  if (every) return Number(every[1]) * 7;
  const tage = f.match(/(\d+)-?tägig/) ?? f.match(/alle (\d+) tage/);
  if (tage) return Number(tage[1]);
  const perWeek = f.match(/(\d+)(?:\s*(?:-|–|bis)\s*(\d+))?\s*x?\s*(?:\/|pro |je |in der )?\s*woche/);
  if (perWeek) {
    const min = Number(perWeek[1]);
    return min > 0 ? Math.ceil(7 / min) : null;
  }
  if (/wöchentlich/.test(f)) return 7;
  return null;
}

export type FrequencyWarning = { from: string; to: string; gapDays: number; allowedDays: number };

/** Abstände zwischen Behandlungen (und bis heute, solange die VO läuft), die die Frequenz überschreiten. */
export function frequencyWarnings(
  treatmentDates: string[],
  frequency: string | null | undefined,
  opts: { today?: string; running?: boolean; toleranceDays?: number } = {},
): FrequencyWarning[] {
  const allowed = maxGapDays(frequency);
  if (allowed === null) return [];
  const limit = allowed + (opts.toleranceDays ?? FREQUENCY_TOLERANCE_DAYS);
  const dates = [...treatmentDates].sort();
  const out: FrequencyWarning[] = [];
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween(dates[i - 1], dates[i]);
    if (gap > limit) out.push({ from: dates[i - 1], to: dates[i], gapDays: gap, allowedDays: allowed });
  }
  if (opts.running && opts.today && dates.length) {
    const last = dates[dates.length - 1];
    const gap = daysBetween(last, opts.today);
    if (gap > limit) out.push({ from: last, to: opts.today, gapDays: gap, allowedDays: allowed });
  }
  return out;
}

// ───────────────────────── Zuzahlung ─────────────────────────

export type PricedPosition = { units: number; priceCents: number | null | undefined };

/** Kosten des Heilmittels (Summe Einheiten × Preis). `complete` = false, wenn ein Preis fehlt. */
export function remedyCostCents(positions: PricedPosition[]): { cents: number; complete: boolean } {
  let cents = 0;
  let complete = positions.length > 0;
  for (const p of positions) {
    if (p.priceCents === null || p.priceCents === undefined) complete = false;
    else cents += p.units * p.priceCents;
  }
  return { cents, complete };
}

/** Zuzahlung: 10 € je Verordnung + 10 % der Heilmittelkosten (kaufmännisch auf Cent gerundet). */
export function copaymentCents(costCents: number, opts: { exempt?: boolean; ageYears?: number | null } = {}): number {
  if (opts.exempt) return 0;
  if (opts.ageYears !== null && opts.ageYears !== undefined && opts.ageYears < COPAYMENT_FREE_UNDER_AGE) return 0;
  if (costCents <= 0) return 0;
  return COPAYMENT_FLAT_CENTS + Math.round((costCents * COPAYMENT_PERCENT) / 100);
}

// ───────────────────────── Eingabeprüfung ─────────────────────────

export type PrescriptionPosition = { position?: string; label: string; units: number };

export const ICD10_PATTERN = /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?[GVZA+*!]?$/;

export function validatePrescription(input: {
  issuedAt: string;
  diagnosisGroup: string;
  units: number;
  positions: PrescriptionPosition[];
  icd10?: string | null;
  today: string;
}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const group = DIAGNOSIS_GROUPS[input.diagnosisGroup as DiagnosisGroup];
  if (!group) errors.push("Unbekannte Diagnosegruppe.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issuedAt)) errors.push("Ausstellungsdatum fehlt.");
  else if (input.issuedAt > input.today) errors.push("Das Ausstellungsdatum liegt in der Zukunft.");
  if (!Number.isInteger(input.units) || input.units < 1) errors.push("Bitte die verordneten Einheiten angeben.");
  if (group && input.units > group.maxUnitsPerPrescription) {
    warnings.push(`Mehr als die Höchstmenge je Verordnung (${group.maxUnitsPerPrescription}) für ${group.code} – Verordnung prüfen bzw. Arzt kontaktieren.`);
  }
  if (input.positions.length === 0) errors.push("Bitte mindestens eine Heilmittelposition angeben.");
  for (const p of input.positions) {
    if (!p.label.trim()) errors.push("Jede Position braucht eine Bezeichnung.");
    if (!Number.isInteger(p.units) || p.units < 1) errors.push(`Position „${p.label}“: Einheiten fehlen.`);
    else if (p.units > input.units) errors.push(`Position „${p.label}“ hat mehr Einheiten als die Verordnung.`);
  }
  if (input.icd10 && !ICD10_PATTERN.test(input.icd10.trim().toUpperCase())) warnings.push("ICD-10-Code sieht ungewöhnlich aus (Format z. B. E11.74).");
  if (!input.icd10) warnings.push("ICD-10-Code fehlt – für die Abrechnung erforderlich.");
  return { errors, warnings };
}

// ───────────────────────── Gesamtbewertung / Ampel ─────────────────────────

export type Light = "green" | "yellow" | "red" | "blue" | "gray";

export type PrescriptionEvaluation = {
  startBy: string;
  daysToStartDeadline: number;
  startState: "started" | "ok" | "soon" | "missed";
  unitsUsed: number;
  unitsRemaining: number;
  frequency: FrequencyWarning[];
  light: Light;
  messages: string[];
};

export function evaluatePrescription(p: {
  issuedAt: string;
  urgent: boolean;
  units: number;
  status: string;
  frequency?: string | null;
  treatmentDates: string[];
  today: string;
  startBy?: string | null;
}): PrescriptionEvaluation {
  const startBy = p.startBy ?? startDeadline(p.issuedAt, p.urgent);
  const unitsUsed = p.treatmentDates.length;
  const unitsRemaining = Math.max(0, p.units - unitsUsed);
  const firstDate = [...p.treatmentDates].sort()[0];
  const daysToStartDeadline = daysBetween(p.today, startBy);
  const startState: PrescriptionEvaluation["startState"] = firstDate
    ? "started"
    : daysToStartDeadline < 0
      ? "missed"
      : daysToStartDeadline <= START_WARN_DAYS
        ? "soon"
        : "ok";
  const running = p.status === "open" || p.status === "active";
  const freq = frequencyWarnings(p.treatmentDates, p.frequency, { today: p.today, running });
  const messages: string[] = [];
  if (firstDate && firstDate > startBy) messages.push(`Behandlungsbeginn (${firstDate}) nach der Frist (${startBy}).`);
  if (startState === "missed") messages.push(`Behandlungsbeginn bis ${startBy} verpasst – Verordnung ist ungültig.`);
  if (startState === "soon") messages.push(`Behandlung muss bis ${startBy} beginnen (noch ${daysToStartDeadline} Tage).`);
  for (const w of freq) messages.push(`Abstand ${w.gapDays} Tage (${w.from} → ${w.to}) überschreitet die Frequenz (max. ${w.allowedDays} Tage).`);
  if (running && unitsRemaining > 0 && unitsRemaining <= 1 && unitsUsed > 0) messages.push("Letzte Einheit – Folgeverordnung anfragen.");

  let light: Light = "green";
  if (p.status === "billing_ready") light = "blue";
  else if (!running) light = "gray";
  else if (startState === "missed" || (firstDate && firstDate > startBy)) light = "red";
  else if (startState === "soon" || freq.length || (unitsRemaining <= 1 && unitsUsed > 0)) light = "yellow";
  return { startBy, daysToStartDeadline, startState, unitsUsed, unitsRemaining, frequency: freq, light, messages };
}
