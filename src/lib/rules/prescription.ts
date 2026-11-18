/**
 * Versionierte Regeln für das Verordnungsmanagement Podologie (GKV, Muster 13).
 *
 * Jede fachliche Konstante/Regel nennt ihre Quelle (Dokument + Abschnitt). Übersicht, Stand und offene Punkte:
 * docs/GKV.md. Gelesen am 17.11.2026:
 *  [HeilM-RL]  G-BA Heilmittel-Richtlinie, zuletzt geändert 15.05.2025, in Kraft 05.08.2025 (inkl. Heilmittelkatalog
 *              Teil 2, Abschnitt II „Maßnahmen der Podologischen Therapie“) – https://www.g-ba.de/richtlinien/12/
 *  [Vertrag]   Vertrag nach § 125 Abs. 1 SGB V Podologie i. d. F. vom 30.11.2020, Lesefassung inkl. Änderungen bis
 *              16.06.2025 – https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Vertrag-Lesefassung.pdf
 *  [Anlage 3]  Anlage 3 „notwendige Angaben auf der Heilmittelverordnung“ i. d. F. vom 16.06.2025 (Lesefassung) –
 *              https://www.gkv-spitzenverband.de/media/dokumente/krankenversicherung_1/ambulante_leistungen/heilmittel/vertraege_125abs1/podologie/20250617_Podologie_Anlage_3_Lesefassung.pdf
 *  [Anlage 2]  Vergütung i. d. F. vom 01.07.2025 – src/lib/rules/podologie-verguetung.ts
 *  [SGB V]     §§ 32 Abs. 2, 61 Satz 3, 62 SGB V – https://www.gesetze-im-internet.de/sgb_5/
 *  [ICD-10-GM] BfArM ICD-10-GM 2026, Block E10–E14 – https://klassifikationen.bfarm.de/icd-10-gm/kode-suche/htmlgm2026/block-e10-e14.htm
 *
 * Unsicheres meldet die Prüfung als Warnung („bitte prüfen“), nie als Fehler. Jede Verordnung speichert die
 * `rulesVersion`, mit der sie bewertet wurde; die Pflichtangaben-Prüfung (anlage3Findings) gilt nur für Verordnungen,
 * die mit dieser Version erfasst wurden (ältere hatten die Felder noch nicht).
 *
 * Alles hier sind reine Funktionen (keine DB, keine Uhr – das Datum wird übergeben) → testbar.
 */

import { isValidIk, isValidKvnr, isValidLanr, normalizeId } from "./gkv-ids";
import { HOME_VISIT_HPNR, positionFits, positionInfo, priceFor, toZlHpnr } from "./podologie-verguetung";

export const RULES_VERSION = "podo-2026-11-anlage3-2025-06";

/**
 * Ab welchem Regelwerk eine Verordnung die Felder der Anlage 3 (Personalienfeld, Stempel, Leitsymptomatik …) hat und
 * PodoHero „Frist überschritten“ automatisch setzt. Gilt für dieses und alle späteren Regelwerke „podo-JJJJ-MM-…“ –
 * neue Fassungen brauchen hier keine Änderung (Code-Review PR #111 C3). Ältere App-Regelwerke
 * („heilm-rl-podo-2025-07-entwurf“) und Übernahmen („import-…“) hatten die Felder nicht bzw. ihre Behandlungstage liegen
 * im Fremdsystem → keine Pflichtangaben-Prüfung, kein automatischer Ablauf (PR #111 C1). docs/GKV.md.
 */
export const RULES_MIN_ANLAGE3 = "podo-2026-11";

/** Regelwerk `version` ist mindestens `min` (beide im Format „podo-JJJJ-MM…“); andere Kennungen → false. */
export function rulesVersionAtLeast(version: string | null | undefined, min: string = RULES_MIN_ANLAGE3): boolean {
  const v = /^podo-(\d{4})-(\d{2})/.exec(version ?? "");
  const m = /^podo-(\d{4})-(\d{2})/.exec(min);
  if (!v || !m) return false;
  return `${v[1]}-${v[2]}` >= `${m[1]}-${m[2]}`;
}

/** Pflichtangaben nach Anlage 3 prüfen? (nur Regelwerke mit den Anlage-3-Feldern) */
export const hasAnlage3Fields = (version: string | null | undefined) => rulesVersionAtLeast(version, RULES_MIN_ANLAGE3);
/** „Frist überschritten“ automatisch setzen? (nur mit PodoHero erfasste Verordnungen ab RULES_MIN_ANLAGE3) */
export const autoExpiryApplies = (version: string | null | undefined) => rulesVersionAtLeast(version, RULES_MIN_ANLAGE3);

/** Spätester Behandlungsbeginn in Kalendertagen nach Ausstellung – [HeilM-RL] § 15 Abs. 1, [Vertrag] § 6 Abs. 3 */
export const START_DEADLINE_DAYS = 28;
/** … bei „dringlichem Behandlungsbedarf“ – [HeilM-RL] § 15 Abs. 1 Satz 2, [Anlage 3] Buchst. e */
export const START_DEADLINE_URGENT_DAYS = 14;
/** Ab so vielen Tagen vor Fristende wird gewarnt (gelbe Ampel) – Produktentscheidung, keine Vorgabe */
export const START_WARN_DAYS = 5;
/**
 * Unter-/Überschreitung der Frequenz um bis zu zwei Werktage ist ohne Rücksprache zulässig – [Vertrag] § 7 Abs. 6.
 * Werktage hier: Montag bis Samstag (Feiertage nicht berücksichtigt → im Zweifel strenger; docs/GKV.md, offene Punkte).
 */
export const FREQUENCY_TOLERANCE_WORKDAYS = 2;
/** Verordnung verliert ihre Gültigkeit bei einer Unterbrechung von 12 Kalenderwochen nach der letzten Behandlung – [Vertrag] § 7 Abs. 7 */
export const INTERRUPTION_WEEKS = 12;
/** Zuzahlung: 10 % der Kosten + 10 € je Verordnung – [SGB V] § 61 Satz 3 i. V. m. § 32 Abs. 2 */
export const COPAYMENT_FLAT_CENTS = 1000;
/** Therapiebericht (Anlage 2 § 2 Abs. 2 Buchst. d: „Therapiebericht UI 2“) – Einheit mit dem Berichtsdatum (Paket B) */
export const THERAPY_REPORT_HPNR = "78530";
export const COPAYMENT_PERCENT = 10;
/** Zuzahlungspflicht ab Vollendung des 18. Lebensjahres – [SGB V] § 32 Abs. 2 Satz 1, [Vertrag] § 8 Abs. 2 */
export const COPAYMENT_FREE_UNDER_AGE = 18;

export type DiagnosisGroup = "DF" | "NF" | "QF" | "UI1" | "UI2";

export type DiagnosisGroupRule = {
  code: DiagnosisGroup;
  label: string;
  /** Höchstmenge je Verordnung (Behandlungseinheiten) – [HeilM-RL] Heilmittelkatalog Podologie */
  maxUnitsPerPrescription: number;
  /** Frequenzempfehlung laut Heilmittelkatalog (gilt, wenn die Verordnung keine Frequenz nennt – [Anlage 3] Buchst. i b) */
  defaultFrequency: string;
  /** Frequenz nur Empfehlung, Abweichung braucht keine Begründung – [Anlage 3] Buchst. i (UI1/UI2) */
  frequencyBinding: boolean;
  /** buchstabenkodierte Leitsymptomatik laut Heilmittelkatalog */
  leitsymptomatik: Record<string, string>;
  /** Beispiele/Hinweise für ICD-10 (nur Anzeige) */
  icdHint: string;
};

const LS_FUSS = { a: "a) Hyperkeratose", b: "b) Pathologisches Nagelwachstum", c: "c) Hyperkeratose und pathologisches Nagelwachstum" };

export const DIAGNOSIS_GROUPS: Record<DiagnosisGroup, DiagnosisGroupRule> = {
  DF: {
    code: "DF",
    label: "DF – Diabetisches Fußsyndrom",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    frequencyBinding: true,
    leitsymptomatik: LS_FUSS,
    icdHint: "DFS oder diabetische Neuropathie, z. B. E11.74, E11.40, G63.2",
  },
  NF: {
    code: "NF",
    label: "NF – Neuropathie (sensibel/sensomotorisch), nicht diabetisch",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    frequencyBinding: true,
    leitsymptomatik: LS_FUSS,
    icdHint: "sensible/sensomotorische Neuropathie, z. B. G60.0",
  },
  QF: {
    code: "QF",
    label: "QF – Querschnittsyndrom",
    maxUnitsPerPrescription: 6,
    defaultFrequency: "1x alle 4-6 Wochen",
    frequencyBinding: true,
    leitsymptomatik: LS_FUSS,
    icdHint: "Querschnittsyndrom, z. B. G82.2",
  },
  UI1: {
    code: "UI1",
    label: "UI1 – Unguis incarnatus, Stadium 1 (Nagelspange)",
    maxUnitsPerPrescription: 8,
    defaultFrequency: "nach Bedarf",
    frequencyBinding: false,
    leitsymptomatik: { a: "a) Pathologisches Nagelwachstum mit beginnender Entzündung" },
    icdHint: "ausschließlich L60.0",
  },
  UI2: {
    code: "UI2",
    label: "UI2 – Unguis incarnatus, Stadium 2 oder 3 (Nagelspange)",
    // Heilmittelkatalog UI 2: „Höchstmenge je VO: bis zu 4x/VO“ (orientierende Behandlungsmenge bis zu 8)
    maxUnitsPerPrescription: 4,
    defaultFrequency: "nach Bedarf",
    frequencyBinding: false,
    leitsymptomatik: { a: "a) Pathologisches Nagelwachstum mit manifester oder chronischer Entzündung" },
    icdHint: "ausschließlich L60.0",
  },
};

export const DIAGNOSIS_GROUP_CODES = Object.keys(DIAGNOSIS_GROUPS) as DiagnosisGroup[];

/** Vorschläge für das Frequenz-Feld */
export const FREQUENCY_OPTIONS = ["1x alle 4-6 Wochen", "1x alle 4 Wochen", "1x alle 6 Wochen", "1x alle 3 Wochen", "1x alle 2 Wochen", "1x wöchentlich", "nach Bedarf"];

/** patientenindividuelle Leitsymptomatik (Freitext) – [Anlage 3] Buchst. l */
export const LEITSYMPTOMATIK_FREE = "x";

// ───────────────────────── Status ─────────────────────────

export const PRESCRIPTION_STATUSES = ["open", "active", "completed", "billing_ready", "billed", "correction_needed", "expired", "cancelled"] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export const STATUS_LABEL: Record<PrescriptionStatus, string> = {
  open: "offen",
  active: "in Behandlung",
  completed: "abgeschlossen",
  billing_ready: "abrechnungsreif",
  billed: "abgerechnet",
  /** abgerechnet, aber zu korrigieren (Absetzung/Rückläufer der Kasse) – GKV Paket C, nur über einen Korrekturvermerk */
  correction_needed: "Korrektur nötig",
  /** abgelaufen (Beginnfrist verpasst oder Unterbrechung zu lang) – bleibt erhalten, wird nicht gelöscht */
  expired: "Frist überschritten",
  cancelled: "storniert",
};

const TRANSITIONS: Record<PrescriptionStatus, readonly PrescriptionStatus[]> = {
  open: ["active", "expired", "cancelled"],
  // vorzeitig „abrechnungsreif“ nur mit Abbruch-Begründung (siehe canTransition)
  active: ["completed", "billing_ready", "expired", "cancelled"],
  completed: ["billing_ready"],
  billing_ready: ["billed", "completed"],
  // „abgerechnet“ → „Korrektur nötig“ nur über markCorrectionNeeded (Korrekturvermerk mit Begründung, src/server/gkv-billing.ts)
  billed: [],
  // nach der Korrektur erneut abrechnen (Preis-Snapshot neu, nächster Abrechnungslauf); ohne Neuabrechnung → resolveCorrection
  correction_needed: ["billing_ready"],
  // Rückweg nur mit Begründung (z. B. Beginn war rechtzeitig, aber nicht erfasst) – PR #111 C1, siehe canTransition
  expired: ["open", "active"],
  cancelled: [],
};

/** Mindestlänge einer Begründung (Abbruch, Wiederaufnahme) – Produktentscheidung */
export const NOTE_MIN = 5;

export function canTransition(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
  ctx: { unitsUsed?: number; units?: number; interruptionNote?: string | null; rulesVersion?: string | null } = {},
): { ok: true } | { ok: false; reason: string } {
  if (!TRANSITIONS[from]?.includes(to)) return { ok: false, reason: `Statuswechsel ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]} ist nicht erlaubt.` };
  // „in Behandlung“ ohne erfasste Einheit gibt es nur bei Übernahmen/Altbestand (Beginn im Fremdsystem). Bei mit
  // PodoHero erfassten Verordnungen setzt erst die dokumentierte Einheit den Status (statusAfterUnit) – sonst ließe sich
  // die Beginnfrist per Statuswechsel umgehen (PR #111 Review-Runde 2, S-1).
  if (to === "active" && (ctx.unitsUsed ?? 0) === 0 && autoExpiryApplies(ctx.rulesVersion)) {
    return { ok: false, reason: "„In Behandlung“ wird mit der ersten dokumentierten Behandlung gesetzt – bitte die Behandlung in der Doku erfassen." };
  }
  if (from === "active" && to === "billing_ready" && !(ctx.interruptionNote && ctx.interruptionNote.trim().length >= 5)) {
    return { ok: false, reason: "Vorzeitige Abrechnung nur mit Begründung des Behandlungsabbruchs." };
  }
  if (to === "billing_ready" && (ctx.unitsUsed ?? 0) === 0) return { ok: false, reason: "Ohne erbrachte Einheit gibt es nichts abzurechnen." };
  if (from === "expired") {
    // Wiederaufnahme: nur mit Begründung (wird protokolliert); „offen“ nur ohne erbrachte Einheit, sonst „in Behandlung“
    if (!(ctx.interruptionNote && ctx.interruptionNote.trim().length >= NOTE_MIN)) return { ok: false, reason: "Wiederaufnahme nur mit Begründung (z. B. Behandlung hat rechtzeitig begonnen, war aber nicht erfasst)." };
    if (to === "open" && (ctx.unitsUsed ?? 0) > 0) return { ok: false, reason: "Es sind schon Einheiten erbracht – bitte „in Behandlung“ wählen." };
    if (ctx.units !== undefined && (ctx.unitsUsed ?? 0) >= ctx.units) return { ok: false, reason: "Alle Einheiten sind erbracht – keine Wiederaufnahme nötig." };
  }
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

/** Werktage Montag–Samstag weiterzählen (n > 0 vorwärts, n < 0 rückwärts) – für [Vertrag] § 7 Abs. 6 */
export function addWorkdaysIso(iso: string, n: number): string {
  let d = iso;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d = addDaysIso(d, step);
    if (new Date(toUtc(d)).getUTCDay() !== 0) left--;
  }
  return d;
}

/** Spätester Behandlungsbeginn (inklusive) */
export function startDeadline(issuedAt: string, urgent: boolean): string {
  return addDaysIso(issuedAt, urgent ? START_DEADLINE_URGENT_DAYS : START_DEADLINE_DAYS);
}

/** Letzter Tag vor dem Gültigkeitsverlust durch Unterbrechung ([Vertrag] § 7 Abs. 7: 12 Kalenderwochen nach der letzten Behandlung) */
export function interruptionDeadline(lastTreatment: string): string {
  return addDaysIso(lastTreatment, INTERRUPTION_WEEKS * 7);
}

/**
 * Abstände laut Frequenzangabe in Tagen: { min, max }. Versteht „1x wöchentlich“, „2x/Woche“, „1-2x pro Woche“,
 * „1x alle 4-6 Wochen“, „alle 3 Wochen“, „14-tägig“. null = nicht verstanden bzw. „nach Bedarf“ (keine Prüfung).
 */
export function frequencyGap(frequency: string | null | undefined): { min: number; max: number } | null {
  if (!frequency) return null;
  const f = frequency.toLowerCase().replace(/\s+/g, " ").trim();
  if (/bedarf/.test(f)) return null;
  const range = f.match(/alle (\d+)\s*(?:-|–|bis)\s*(\d+) woche/);
  if (range) return { min: Number(range[1]) * 7, max: Number(range[2]) * 7 };
  const every = f.match(/alle (\d+) woche/);
  if (every) return { min: Number(every[1]) * 7, max: Number(every[1]) * 7 };
  const tage = f.match(/(\d+)-?tägig/) ?? f.match(/alle (\d+) tage/);
  if (tage) return { min: Number(tage[1]), max: Number(tage[1]) };
  const perWeek = f.match(/(\d+)(?:\s*(?:-|–|bis)\s*(\d+))?\s*x?\s*(?:\/|pro |je |in der )?\s*woche/);
  if (perWeek) {
    const lo = Number(perWeek[1]);
    const hi = perWeek[2] ? Number(perWeek[2]) : lo;
    return lo > 0 && hi > 0 ? { min: Math.floor(7 / hi), max: Math.ceil(7 / lo) } : null;
  }
  if (/wöchentlich/.test(f)) return { min: 7, max: 7 };
  return null;
}

/** Größter zulässiger Abstand laut Frequenzangabe (in Tagen) – null, wenn nicht verstanden */
export function maxGapDays(frequency: string | null | undefined): number | null {
  return frequencyGap(frequency)?.max ?? null;
}

export type FrequencyWarning = { from: string; to: string; gapDays: number; allowedDays: number };

/**
 * Abstände zwischen Behandlungen (und bis heute, solange die VO läuft), die die Frequenz überschreiten – mit der
 * Toleranz von zwei Werktagen ([Vertrag] § 7 Abs. 6) bzw. `toleranceDays` (Kalendertage), falls angegeben.
 */
export function frequencyWarnings(
  treatmentDates: string[],
  frequency: string | null | undefined,
  opts: { today?: string; running?: boolean; toleranceDays?: number } = {},
): FrequencyWarning[] {
  const allowed = maxGapDays(frequency);
  if (allowed === null) return [];
  const latest = (from: string) => (opts.toleranceDays !== undefined ? addDaysIso(from, allowed + opts.toleranceDays) : addWorkdaysIso(addDaysIso(from, allowed), FREQUENCY_TOLERANCE_WORKDAYS));
  const dates = [...treatmentDates].sort();
  const out: FrequencyWarning[] = [];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > latest(dates[i - 1])) out.push({ from: dates[i - 1], to: dates[i], gapDays: daysBetween(dates[i - 1], dates[i]), allowedDays: allowed });
  }
  if (opts.running && opts.today && dates.length) {
    const last = dates[dates.length - 1];
    if (opts.today > latest(last)) out.push({ from: last, to: opts.today, gapDays: daysBetween(last, opts.today), allowedDays: allowed });
  }
  return out;
}

export type FrequencyDeviation = { kind: "under" | "over"; gapDays: number; earliest: string; latest: string; frequency: string };

/**
 * Weicht eine Behandlung am Tag `date` (nach der letzten am `lastDate`) von der Frequenz ab? Zulässig ist der Abstand
 * laut Frequenz ± zwei Werktage ([Vertrag] § 7 Abs. 6). Darüber hinaus ist eine Abweichung nur nach Absprache mit der
 * verordnenden Ärztin/dem Arzt zulässig und auf der Verordnung zu dokumentieren ([HeilM-RL] § 16 Abs. 3,
 * [Anlage 3] Buchst. i a) → PodoHero verlangt je Behandlung eine Begründung.
 * Ohne Frequenzangabe gilt die Katalog-Frequenz ([Anlage 3] Buchst. i b). UI1/UI2: Frequenz nur Empfehlung → nie.
 */
export function frequencyDeviation(input: { group: string; frequency: string | null | undefined; lastDate: string | null | undefined; date: string }): FrequencyDeviation | null {
  const rule = DIAGNOSIS_GROUPS[input.group as DiagnosisGroup];
  if (!rule || !rule.frequencyBinding || !input.lastDate) return null;
  // gleicher Tag (z. B. Befundung und Behandlung als zwei Einträge): kein neuer Behandlungsabstand → keine Abweichung
  // (PR #111 C5; Vertrag § 7 Abs. 6 regelt den Abstand ZWISCHEN Behandlungen)
  if (input.date === input.lastDate) return null;
  const frequency = input.frequency?.trim() || rule.defaultFrequency;
  const gap = frequencyGap(frequency);
  if (!gap) return null;
  const earliest = addWorkdaysIso(addDaysIso(input.lastDate, gap.min), -FREQUENCY_TOLERANCE_WORKDAYS);
  const latest = addWorkdaysIso(addDaysIso(input.lastDate, gap.max), FREQUENCY_TOLERANCE_WORKDAYS);
  const gapDays = daysBetween(input.lastDate, input.date);
  if (input.date < earliest) return { kind: "under", gapDays, earliest, latest, frequency };
  if (input.date > latest) return { kind: "over", gapDays, earliest, latest, frequency };
  return null;
}

export function frequencyDeviationText(d: FrequencyDeviation): string {
  const de = (iso: string) => iso.split("-").reverse().join(".");
  return d.kind === "under"
    ? `Frequenz unterschritten: ${d.gapDays} Tage seit der letzten Behandlung (laut „${d.frequency}“ frühestens ${de(d.earliest)}, inkl. 2 Werktage Toleranz).`
    : `Frequenz überschritten: ${d.gapDays} Tage seit der letzten Behandlung (laut „${d.frequency}“ spätestens ${de(d.latest)}, inkl. 2 Werktage Toleranz).`;
}

/** Mindestlänge der Begründung einer Frequenzabweichung (Produktentscheidung) */
export const FREQUENCY_NOTE_MIN = 5;

// ───────────────────────── Alter & Befreiung ─────────────────────────

/** Volle Lebensjahre am Stichtag (JJJJ-MM-TT) */
export function ageOn(birthDate: string | null | undefined, dateIso: string): number | null {
  const m = birthDate ? /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate) : null;
  if (!m) return null;
  const [ty, tm, td] = dateIso.split("-").map(Number);
  let a = ty - Number(m[1]);
  if (tm < Number(m[2]) || (tm === Number(m[2]) && td < Number(m[3]))) a--;
  return a;
}

/**
 * Befreiungsbescheinigung der Krankenkasse ([SGB V] § 62 Abs. 1: Befreiung für den Rest des Kalenderjahres).
 * Auf den Einzug der Zuzahlung darf nur bei Vorlage einer gültigen Bescheinigung verzichtet werden ([Vertrag] § 8
 * Abs. 3, [Anlage 3] Buchst. a1 – das Kreuz „zuzahlungsfrei“ auf der Verordnung allein genügt nicht).
 */
export type CopaymentExemption = { validFrom: string; validTo: string; insurerName?: string | null; insurerIk?: string | null; note?: string | null };

export function exemptOn(exemptions: CopaymentExemption[] | null | undefined, dateIso: string): CopaymentExemption | null {
  return (exemptions ?? []).find((e) => e.validFrom <= dateIso && dateIso <= e.validTo) ?? null;
}

// ───────────────────────── Zuzahlung & Heilmittelkosten ─────────────────────────

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

/** Zuzahlung (Schätzung ohne Behandlungsdaten): 10 € je Verordnung + 10 % der Heilmittelkosten (kaufmännisch gerundet). */
export function copaymentCents(costCents: number, opts: { exempt?: boolean; ageYears?: number | null } = {}): number {
  if (opts.exempt) return 0;
  if (opts.ageYears !== null && opts.ageYears !== undefined && opts.ageYears < COPAYMENT_FREE_UNDER_AGE) return 0;
  if (costCents <= 0) return 0;
  return Math.min(costCents, COPAYMENT_FLAT_CENTS + Math.round((costCents * COPAYMENT_PERCENT) / 100));
}

/** „Zuzahlung erhalten“: Hinweis, wenn der erhaltene Betrag über der berechneten Zuzahlung liegt (nicht blockierend). */
export function copaymentOverpaid(paidCents: number | null | undefined, expectedCents: number | null | undefined): string | null {
  if (paidCents === null || paidCents === undefined || expectedCents === null || expectedCents === undefined || paidCents <= expectedCents) return null;
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  return `Erhaltener Betrag (${eur(paidCents)} €) liegt über der berechneten Zuzahlung (${eur(expectedCents)} €) – bitte prüfen (Tippfehler? Zuviel bitte erstatten).`;
}

/** „Zuzahlung erhalten“: Hinweis bei Über- oder Unterzahlung (Restbetrag offen) – nicht blockierend (Runde 3, S4). */
export function copaymentPaidHint(paidCents: number | null | undefined, expectedCents: number | null | undefined): string | null {
  if (paidCents === null || paidCents === undefined || expectedCents === null || expectedCents === undefined) return null;
  if (paidCents < expectedCents) return `Restbetrag ${((expectedCents - paidCents) / 100).toFixed(2).replace(".", ",")} € offen.`;
  return copaymentOverpaid(paidCents, expectedCents);
}

export type PrescriptionPosition = { position?: string; label: string; units: number };

/**
 * Doppelte Positionsnummern zusammenfassen (Einheiten addieren, Bezeichnung/Nummer der ersten Zeile) – PR #111 Runde 2/3.
 * Sonst verteilte der Preis-Snapshot dieselbe Position zweimal je Behandlungstag. Schlüssel ist die ZL-Nummer
 * (`toZlHpnr`: 78020, 68020 und 88020 sind dieselbe Leistung, Anlage 2 § 1 Abs. 2), sonst die Nummer ohne Leerzeichen;
 * Zeilen ohne Nummer bleiben unverändert. Reihenfolge der ersten Vorkommen bleibt erhalten. Die Einheiten müssen vorher
 * geprüft sein (`preparePositions`) – sonst verrechnete eine negative Zeile eine andere.
 */
export function mergePositions<P extends PrescriptionPosition>(positions: P[]): P[] {
  const out: P[] = [];
  const byCode = new Map<string, P>();
  for (const p of positions) {
    const code = positionKey(p.position);
    const prev = code ? byCode.get(code) : undefined;
    if (prev) {
      prev.units += p.units;
      continue;
    }
    const copy = { ...p };
    if (code) byCode.set(code, copy);
    out.push(copy);
  }
  return out;
}

/** Vergleichsschlüssel einer Positionsnummer: ZL-Nummer, sonst die Nummer ohne Leerzeichen; ohne Nummer null */
function positionKey(position: string | null | undefined): string | null {
  const raw = position?.replace(/\s+/g, "") || null;
  return raw ? (toZlHpnr(raw) ?? raw) : null;
}

/**
 * Positionen einer Eingabe vorbereiten (Runde 3, H-2): leere Zeilen weglassen, JEDE Zeile muss ganze Einheiten ≥ 1 haben
 * (erst prüfen, dann `mergePositions` – [5, −3] darf nicht zu 2 verrechnet werden).
 */
export function preparePositions<P extends PrescriptionPosition>(rows: P[]): { positions: P[] } | { error: string } {
  const filled = rows.filter((p) => p.label?.trim() || p.position?.trim());
  const bad = filled.find((p) => !Number.isInteger(p.units) || p.units < 1);
  if (bad) return { error: `Position „${bad.label || bad.position}“: Einheiten fehlen oder sind ungültig (ganze Zahl ab 1).` };
  return { positions: mergePositions(filled) };
}

export type SnapshotLine = {
  date: string;
  position: string;
  units: number;
  priceCents: number | null;
  /**
   * 10-%-Anteil dieser Zeile. `null` = die Position hat laut Anlage 2 keine Zuzahlung (Spalte „davon Zuzahlung“ leer,
   * z. B. 78220, 78530) – wichtig für die spätere Übergabe nach § 302 SGB V; 0 = zuzahlungspflichtige Position, aber
   * an diesem Tag befreit bzw. unter 18.
   */
  copayCents: number | null;
  exempt: boolean;
  minor: boolean;
  tableVersion: string | null;
};

export type PriceSnapshot = {
  rulesVersion: string;
  computedOn: string;
  remedyCents: number;
  copaymentPercentCents: number;
  flatFeeCents: number;
  copaymentCents: number;
  complete: boolean;
  lines: SnapshotLine[];
  notes: string[];
};

/**
 * Heilmittelkosten und Zuzahlung einer Verordnung aus den Behandlungstagen (Preis-Snapshot bei Abrechnungsreife).
 *  - Preis je Position nach Behandlungsdatum ([Anlage 2] § 2 Abs. 2 / § 3 Abs. 2); jede Zeile trägt den Tabellenstand
 *    dieses Tages (`tableVersion`) – Behandlungen über den 01.07. hinweg haben verschiedene Preisstände.
 *  - 10 %-Anteil je Behandlungstag, wenn die Person an DIESEM Tag 18 ist und keine gültige Befreiung vorliegt
 *    ([Vertrag] § 8 Abs. 2 Satz 2: „Zeitpunkt der Leistungserbringung“). Betrag je Position laut Spalte
 *    „davon Zuzahlung (nachrichtlich)“ der Anlage 2; dort ohne Angabe (78220, 78530) → 0.
 *  - 10 € Verordnungsblattgebühr nach dem ERSTEN Behandlungstag ([Vertrag] § 8 Abs. 2 Satz 3) – nur, wenn für diesen
 *    Tag ein Preis hinterlegt ist (sonst ist der Snapshot unvollständig und die VO nicht abrechnungsreif, PR #111 S2).
 *  - höchstens die Kosten der erbrachten Heilmittel ([Vertrag] § 8 Abs. 1).
 *  - Positionen mit Tageshöchstmenge (78610: „dürfen zweimal je Tag abgegeben werden“, [Anlage 2] § 2 Abs. 2 Buchst. c)
 *    werden auf die Behandlungstage verteilt: je Tag so viele wie nötig, damit die verordneten Einheiten auf die
 *    vorhandenen Tage passen, höchstens `maxPerDay` (PR #111 S3). Vorzeitig beendete Verordnung (`endedEarly`,
 *    Abbruchvermerk) → nur eine je Tag. Jede Annahme „2 × am Tag“ und nicht verteilbare Einheiten stehen in `notes`.
 *  - Verordnungsblattgebühr höchstens bis zu den Kosten abzüglich des 10-%-Anteils, damit
 *    `copaymentCents = copaymentPercentCents + flatFeeCents` gilt (wie #110 betraege.ts).
 *  - Behandlungseinträge werden je Kalendertag zusammengefasst, bevor verteilt wird: je (Tag, Position) genau eine Zeile
 *    mit höchstens `maxPerDay` Einheiten; mehrere Einträge am selben Tag → Hinweis (nicht blockierend), Rest „nicht
 *    verteilbar“ (Runde 3 B1, Runde 4 V-1).
 * Annahme (docs/GKV.md, offene Punkte): Die Einheiten je Position werden den Behandlungstagen in zeitlicher
 * Reihenfolge zugeordnet (je Tag eine Einheit jeder Position, solange vorhanden). Die tatsächlich abgegebenen
 * Positionen je Tag erfasst PodoHero (noch) nicht einzeln.
 */
export function priceSnapshot(input: {
  positions: PrescriptionPosition[];
  treatmentDates: string[];
  birthDate: string | null | undefined;
  exemptions: CopaymentExemption[] | null | undefined;
  computedOn: string;
  /** IK der Krankenkasse laut Verordnung – Befreiung einer anderen Kasse → Hinweis (Vertrag § 8 Abs. 3: Bescheinigung „der Krankenkasse“) */
  insurerIk?: string | null;
  /** Verordnung vorzeitig beendet (Abbruch-/Unterbrechungsvermerk) → Positionen mit Tageshöchstmenge nur einmal je Tag */
  endedEarly?: boolean;
  /**
   * Datum des Therapieberichts (Paket B): Position 78530 wird nicht auf die Behandlungstage verteilt, sondern einmal mit
   * dem Berichtsdatum angesetzt (Preis an diesem Tag, Zuzahlung laut Anlage 2: keine → copayCents null). Ohne Bericht
   * wird 78530 nicht angesetzt (Hinweis).
   */
  therapyReportDate?: string | null;
}): PriceSnapshot {
  const dates = [...input.treatmentDates].sort();
  const lines: SnapshotLine[] = [];
  const notes: string[] = [];
  // doppelte Positionen (auch ZL/KH/KB-Nummer derselben Leistung) zusammenfassen – sonst entstünden je Tag zwei Zeilen
  // derselben Position, die der Export (#110) als „Position doppelt“ ablehnt (Runde 3, B1)
  const positions = mergePositions(input.positions);
  for (const m of positions) {
    const key = positionKey(m.position);
    const n = key ? input.positions.filter((p) => positionKey(p.position) === key).length : 0;
    if (n > 1) notes.push(`Position ${key} steht mehrfach auf der Verordnung – zusammengefasst (${m.units} Einheiten).`);
  }
  // Behandlungseinträge je Kalendertag zusammenfassen, BEVOR verteilt wird (Runde 4, V-1): je Tag und Position
  // höchstens `maxPerDay` (78610: 2, sonst 1; vorzeitig beendet: 1) – mehrere Einträge am selben Tag erhöhen das nicht
  const entriesPerDay = new Map<string, number>();
  for (const d of dates) entriesPerDay.set(d, (entriesPerDay.get(d) ?? 0) + 1);
  const days = [...entriesPerDay.keys()];
  let complete = days.length > 0;
  let remedy = 0;
  let percent = 0;
  const de = (iso: string) => iso.split("-").reverse().join(".");
  // Therapiebericht (78530): eigener Tag = Berichtsdatum, nicht über die Behandlungstage verteilen
  const isReport = (p: PrescriptionPosition) => positionKey(p.position) === THERAPY_REPORT_HPNR;
  const left = new Map(positions.map((p, i) => [i, isReport(p) ? 0 : p.units]));
  let firstDayPriced = false;
  // Befreiung einer anderen Kasse: ein Hinweis je Befreiung (nicht je Tag); IK normalisiert vergleichen (Runde 4)
  const foreignExemptions = new Set<CopaymentExemption>();
  days.forEach((date, di) => {
    const entries = entriesPerDay.get(date) ?? 1;
    const age = ageOn(input.birthDate, date);
    const minor = age !== null && age < COPAYMENT_FREE_UNDER_AGE;
    const exemption = exemptOn(input.exemptions, date);
    const exempt = !!exemption;
    if (exemption?.insurerIk && input.insurerIk && normalizeId(exemption.insurerIk) !== normalizeId(input.insurerIk)) foreignExemptions.add(exemption);
    const daysLeft = days.length - di;
    positions.forEach((p, pi) => {
      const rest = left.get(pi) ?? 0;
      if (rest <= 0) return;
      const perDay = input.endedEarly ? 1 : Math.max(1, positionInfo(p.position)?.maxPerDay ?? 1);
      const units = Math.min(perDay, Math.max(1, Math.ceil(rest / daysLeft)), rest);
      left.set(pi, rest - units);
      const code = toZlHpnr(p.position) ?? p.position ?? p.label;
      // mehr Einträge als die Tageshöchstmenge (78610: 2, sonst 1) → Hinweis; zwei Einträge bei 78610 sind zulässig
      if (entries > perDay) notes.push(`${entries} Behandlungseinträge am ${de(date)} – nur ${perDay} ${perDay === 1 ? "Einheit" : "Einheiten"} ${code} abrechenbar, bitte prüfen.`);
      else if (units > entries) notes.push(`${units} × ${code} am ${de(date)} angenommen – bitte mit Doku abgleichen.`);
      const pr = p.position ? priceFor(p.position, date) : null;
      if (!pr) {
        complete = false;
        notes.push(`Kein Preis für Position ${p.position ?? p.label} am ${de(date)} hinterlegt.`);
      } else if (di === 0) firstDayPriced = true;
      const copay = pr && pr.copayCents === null ? null : pr && !minor && !exempt ? pr.copayCents! * units : 0;
      remedy += (pr?.cents ?? 0) * units;
      percent += copay ?? 0;
      lines.push({ date, position: code, units, priceCents: pr?.cents ?? null, copayCents: copay, exempt, minor, tableVersion: pr?.version ?? null });
    });
  });
  for (const p of positions.filter(isReport)) {
    const date = input.therapyReportDate;
    if (!date) {
      notes.push(`Therapiebericht (${THERAPY_REPORT_HPNR}) noch nicht erstellt – nicht angesetzt.`);
      continue;
    }
    if (p.units > 1) notes.push(`${p.units} × ${THERAPY_REPORT_HPNR} verordnet – ein Therapiebericht je Verordnung angesetzt.`);
    const pr = priceFor(THERAPY_REPORT_HPNR, date);
    if (!pr) {
      complete = false;
      notes.push(`Kein Preis für Position ${THERAPY_REPORT_HPNR} am ${de(date)} hinterlegt.`);
    }
    const age = ageOn(input.birthDate, date);
    const minor = age !== null && age < COPAYMENT_FREE_UNDER_AGE;
    const exempt = !!exemptOn(input.exemptions, date);
    const copay = pr && pr.copayCents === null ? null : pr && !minor && !exempt ? pr.copayCents! : 0;
    remedy += pr?.cents ?? 0;
    percent += copay ?? 0;
    lines.push({ date, position: THERAPY_REPORT_HPNR, units: 1, priceCents: pr?.cents ?? null, copayCents: copay, exempt, minor, tableVersion: pr?.version ?? null });
  }
  // zeitliche Reihenfolge (Berichtsdatum zwischen den Behandlungstagen); stabil – je Tag bleibt die Positionsfolge
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const e of foreignExemptions) {
    notes.push(`Befreiung (gültig ${de(e.validFrom)}–${de(e.validTo)}) ist von einer anderen Krankenkasse (IK ${e.insurerIk}) als auf der Verordnung (IK ${input.insurerIk}) – bitte prüfen.`);
  }
  positions.forEach((p, pi) => {
    const rest = left.get(pi) ?? 0;
    if (rest > 0 && days.length) {
      const code = toZlHpnr(p.position) ?? p.position ?? p.label;
      notes.push(`${rest} ${rest === 1 ? "Einheit" : "Einheiten"} ${code} nicht verteilbar (${days.length} ${days.length === 1 ? "Behandlungstag" : "Behandlungstage"}${input.endedEarly ? ", vorzeitig beendet" : ""}) – nicht angesetzt.`);
    }
  });
  if (input.birthDate === null || input.birthDate === undefined) notes.push("Geburtsdatum fehlt – Zuzahlungspflicht (ab 18) bitte prüfen.");
  const first = dates[0];
  const firstAge = first ? ageOn(input.birthDate, first) : null;
  // Gebühr höchstens bis zu den Kosten abzüglich 10-%-Anteil (nie negativ) → Zuzahlung = Anteil + Gebühr ≤ Kosten
  const flatDue = first && firstDayPriced && !(firstAge !== null && firstAge < COPAYMENT_FREE_UNDER_AGE) && !exemptOn(input.exemptions, first) && remedy > 0;
  const flat = flatDue ? Math.max(0, Math.min(COPAYMENT_FLAT_CENTS, remedy - percent)) : 0;
  const eur = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  if (flatDue && flat < COPAYMENT_FLAT_CENTS) notes.push(`Pauschale auf ${eur(flat)} € gedeckelt (Kosten ${eur(remedy)} € − 10 % ${eur(percent)} €).`);
  const copay = Math.min(remedy, percent + flat);
  return { rulesVersion: RULES_VERSION, computedOn: input.computedOn, remedyCents: remedy, copaymentPercentCents: percent, flatFeeCents: flat, copaymentCents: copay, complete, lines, notes: [...new Set(notes)] };
}

/**
 * Zuzahlungsbefreiung laut Preis-Snapshot für den Export (PR #111 B1): je Behandlungstag „befreit“ (Bescheinigung),
 * „minderjährig“ (unter 18 am Behandlungstag) oder „pflichtig“. Alle Tage gleich → dieser Wert („nein“ statt
 * „pflichtig“), sonst „gemischt (TT.MM.JJJJ befreit | …)“. Ohne Snapshot → "" (nicht berechnet).
 */
export function exemptionSummary(snap: Pick<PriceSnapshot, "lines"> | null | undefined): string {
  if (!snap?.lines?.length) return "";
  const byDay = new Map<string, string>();
  for (const l of snap.lines) byDay.set(l.date, l.exempt ? "befreit" : l.minor ? "minderjährig" : "pflichtig");
  const kinds = new Set(byDay.values());
  if (kinds.size === 1) {
    const k = [...kinds][0];
    return k === "befreit" ? "ja" : k === "pflichtig" ? "nein" : k;
  }
  return `gemischt (${[...byDay].map(([d, k]) => `${d.split("-").reverse().join(".")} ${k}`).join(" | ")})`;
}

// ───────────────────────── Eingabeprüfung ─────────────────────────

export const ICD10_PATTERN = /^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?[GVZA+*!†]?$/;

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
    // [Anlage 3] Buchst. f b): nur so viele Einheiten abrechenbar, wie nach HeilM-RL zulässig; Arzt informieren
    warnings.push(`Mehr als die Höchstmenge je Verordnung (${group.maxUnitsPerPrescription}) für ${group.code} – abrechenbar sind höchstens ${group.maxUnitsPerPrescription}; Ärztin/Arzt informieren.`);
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

/**
 * Passt der ICD-10-Code zur Diagnosegruppe? [Anlage 3] Buchst. k:
 *  a) DF: Schlüssel muss DFS oder diabetische Neuropathie deklarieren. Laut [ICD-10-GM] E10–E14: 4. Stelle „.4“ = mit
 *     neurologischen Komplikationen (inkl. diabetische Polyneuropathie G63.2*), „.74“/„.75“ = mit diabetischem
 *     Fußsyndrom. Andere Schlüssel → nur Warnung „bitte prüfen“ (die Liste ist nicht abschließend belegt).
 *  b) NF/QF: keine Schlüsselliste belegt → keine Prüfung.
 *  c) UI1/UI2: ausschließlich L60.0 maßgeblich, sonst Korrektur erforderlich.
 */
export function icdMatchesGroup(group: string, icd: string): "ok" | "check" | "wrong" {
  const c = icd.trim().toUpperCase().replace(/[GVZA+*!†]$/, "");
  if (group === "UI1" || group === "UI2") return c === "L60.0" ? "ok" : "wrong";
  if (group === "DF") {
    if (/^E1[0-4]\.(4|7[45])/.test(c) || /^G63\.2/.test(c)) return "ok";
    return "check";
  }
  return "ok";
}

export type FindingLevel = "start" | "billing" | "warning";
export type Finding = { code: string; level: FindingLevel; message: string; source: string };

export type Anlage3Input = {
  diagnosisGroup: string;
  issuedAt: string;
  units: number;
  icd10?: string | null;
  icd10Second?: string | null;
  diagnosisText?: string | null;
  leitsymptomatik?: string | null;
  leitsymptomatikText?: string | null;
  frequency?: string | null;
  remedy?: string | null;
  positions: PrescriptionPosition[];
  homeVisit: boolean;
  insurerIk?: string | null;
  insuranceNumber?: string | null;
  insuredStatus?: string | null;
  doctorLanr?: string | null;
  doctorBsnr?: string | null;
  /** Arztstempel + Unterschrift vorhanden (null = nicht erfasst, z. B. eVerordnung/Altbestand) */
  doctorSigned?: boolean | null;
  /** IK der Praxis (Stammdaten) */
  practiceIk?: string | null;
};

const A3 = "Anlage 3 Podologie (16.06.2025)";

/**
 * Pflichtangaben der Verordnung nach [Anlage 3] Ziffer 3 und 5. Stufen:
 *  - „start“: Behandlung darf nicht begonnen werden (Ziff. 3 bzw. Buchst. a „kann die Behandlung nicht begonnen werden“)
 *  - „billing“: Korrektur vor Einreichung zur Abrechnung erforderlich
 *  - „warning“: Hinweis bzw. nachträglich korrigierbar (Ziff. 4 Abs. 2) oder Regel nicht sicher belegt („bitte prüfen“)
 */
export function anlage3Findings(v: Anlage3Input): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, level: FindingLevel, message: string, source: string) => out.push({ code, level, message, source });
  const group = DIAGNOSIS_GROUPS[v.diagnosisGroup as DiagnosisGroup];
  const ui = v.diagnosisGroup === "UI1" || v.diagnosisGroup === "UI2";

  // a) Personalienfeld
  const kvnr = normalizeId(v.insuranceNumber);
  if (!kvnr) add("kvnr_missing", "start", "Versichertennummer fehlt – Behandlung kann nicht begonnen werden (Korrektur nur durch die Ärztin/den Arzt).", `${A3}, Ziff. 5 Buchst. a`);
  else if (!isValidKvnr(kvnr)) add("kvnr_check", "warning", `Versichertennummer ${kvnr}: Format/Prüfziffer passt nicht – bitte prüfen.`, "Richtlinie § 290 SGB V, Anlage 1");
  const ik = normalizeId(v.insurerIk);
  if (!ik) add("insurer_ik_missing", "start", "Kostenträgerkennung (IK der Krankenkasse) fehlt – Behandlung kann nicht begonnen werden.", `${A3}, Ziff. 5 Buchst. a`);
  else if (!isValidIk(ik)) add("insurer_ik_check", "billing", `IK der Krankenkasse ${ik}: Prüfziffer stimmt nicht – Tippfehler? Handschriftliche Änderung der Kasse ist nicht zulässig.`, `${A3}, Ziff. 5 Buchst. a; Richtlinie § 290 SGB V, Anlage 1`);
  if (!v.insuredStatus) add("status_missing", "warning", "Versichertenstatus fehlt – nachträglich korrigierbar, bitte ergänzen.", `${A3}, Ziff. 5 Buchst. a (Korrekturzeitpunkt)`);
  const lanr = normalizeId(v.doctorLanr);
  if (!lanr) add("lanr_missing", "start", "Arztnummer (LANR) fehlt – Behandlung kann nicht begonnen werden.", `${A3}, Ziff. 5 Buchst. a`);
  else if (!isValidLanr(lanr)) add("lanr_check", "warning", `LANR ${lanr}: Prüfziffer (7. Stelle) passt nicht – bitte mit dem Arztstempel vergleichen.`, "ANRV-Vereinbarung § 4 Abs. 3");
  if (!normalizeId(v.doctorBsnr)) add("bsnr_missing", "warning", "Betriebsstättennummer fehlt – darf aus dem Arztstempel übernommen werden.", `${A3}, Ziff. 5 Buchst. a (Korrekturzeitpunkt)`);

  // n) Stempel/Unterschrift
  if (v.doctorSigned === false) add("signature_missing", "start", "Arztstempel und Unterschrift fehlen – Verordnung ungültig, Behandlung darf nicht beginnen.", `${A3}, Ziff. 3 und Ziff. 5 Buchst. n`);

  // k) Diagnose
  const icds = [v.icd10, v.icd10Second].map((x) => (x ?? "").trim().toUpperCase()).filter(Boolean);
  if (!icds.length && !(v.diagnosisText ?? "").trim()) add("diagnosis_missing", "start", "Diagnose (ICD-10 oder Klartext) fehlt – Behandlung kann nicht begonnen werden.", `${A3}, Ziff. 3 und Ziff. 5 Buchst. k`);
  if (ui) {
    if (icds.length && !icds.some((c) => icdMatchesGroup(v.diagnosisGroup, c) === "ok")) {
      add("icd_group", "billing", `Bei ${v.diagnosisGroup} ist ausschließlich ICD-10 L60.0 maßgeblich – Korrektur durch die Ärztin/den Arzt erforderlich.`, `${A3}, Ziff. 5 Buchst. k c)`);
    }
  } else if (v.diagnosisGroup === "DF" && icds.length && !icds.some((c) => icdMatchesGroup("DF", c) === "ok")) {
    add("icd_group", "warning", `ICD-10 ${icds.join(", ")}: deklariert der Schlüssel ein diabetisches Fußsyndrom oder eine diabetische Neuropathie? Bitte prüfen.`, `${A3}, Ziff. 5 Buchst. k a); ICD-10-GM E10–E14`);
  }
  for (const c of icds) if (!ICD10_PATTERN.test(c)) add("icd_format", "warning", `ICD-10 „${c}“ sieht ungewöhnlich aus (Format z. B. E11.74).`, "ICD-10-GM");

  // g1) Heilmittel passend zur Diagnosegruppe (Positionen laut Anlage 2)
  if (!v.positions.length && !(v.remedy ?? "").trim()) add("remedy_missing", "start", "Heilmittel fehlt – Behandlung kann nicht begonnen werden.", `${A3}, Ziff. 3 und Ziff. 5 Buchst. g1`);
  for (const p of v.positions) {
    if (!p.position) continue;
    const fit = positionFits(p.position, v.diagnosisGroup, v.issuedAt);
    if (!fit.ok) add("position_group", "billing", fit.reason, `${A3}, Ziff. 5 Buchst. g1; Anlage 2 § 2 Abs. 2`);
  }
  // c) Hausbesuch nur mit „ja“
  if (!v.homeVisit && v.positions.some((p) => HOME_VISIT_HPNR.includes(toZlHpnr(p.position) as (typeof HOME_VISIT_HPNR)[number]))) {
    add("home_visit", "billing", "Hausbesuch ist nur abrechenbar, wenn auf der Verordnung „Hausbesuch: ja“ angekreuzt ist (Änderung nur durch die Ärztin/den Arzt).", `${A3}, Ziff. 5 Buchst. c`);
  }
  // f) Höchstmenge
  if (group && v.units > group.maxUnitsPerPrescription) {
    add("units_max", "warning", `Mehr als ${group.maxUnitsPerPrescription} Einheiten verordnet – abrechenbar sind höchstens ${group.maxUnitsPerPrescription}; Ärztin/Arzt informieren.`, `${A3}, Ziff. 5 Buchst. f b); HeilM-RL Heilmittelkatalog`);
  }
  // i) Frequenz
  if (group?.frequencyBinding && !(v.frequency ?? "").trim()) {
    add("frequency_missing", "warning", `Keine Frequenz angegeben – es gilt die Katalog-Frequenz (${group.defaultFrequency}).`, `${A3}, Ziff. 5 Buchst. i b)`);
  }
  // l) Leitsymptomatik (UI: Korrekturen nicht erforderlich)
  if (!ui && !v.leitsymptomatik && !(v.leitsymptomatikText ?? "").trim()) {
    add("leitsymptomatik_missing", "warning", "Leitsymptomatik fehlt – im Einvernehmen mit der Ärztin/dem Arzt nachtragen (ohne neue Unterschrift).", `${A3}, Ziff. 5 Buchst. l`);
  }
  if (v.leitsymptomatik === LEITSYMPTOMATIK_FREE && !(v.leitsymptomatikText ?? "").trim()) {
    add("leitsymptomatik_text", "warning", "Patientenindividuelle Leitsymptomatik gewählt, aber kein Freitext eingetragen.", `${A3}, Ziff. 5 Buchst. l`);
  }
  // p) IK der Praxis
  if (!normalizeId(v.practiceIk)) add("practice_ik_missing", "billing", "IK der Praxis fehlt (Einstellungen → Praxis → Kassenzulassung) – für die Abrechnung erforderlich.", `${A3}, Ziff. 5 Buchst. p; Vertrag § 17`);
  else if (!isValidIk(v.practiceIk)) add("practice_ik_check", "billing", "IK der Praxis: Prüfziffer stimmt nicht (Einstellungen → Praxis).", "Vertrag § 17; Richtlinie § 290 SGB V, Anlage 1");
  return out;
}

export const blocksStart = (f: Finding[]) => f.some((x) => x.level === "start");
export const blocksBilling = (f: Finding[]) => f.some((x) => x.level === "start" || x.level === "billing");

// ───────────────────────── Gesamtbewertung / Ampel ─────────────────────────

export type Light = "green" | "yellow" | "red" | "blue" | "gray";

export type PrescriptionEvaluation = {
  startBy: string;
  daysToStartDeadline: number;
  startState: "started" | "ok" | "soon" | "missed";
  unitsUsed: number;
  unitsRemaining: number;
  frequency: FrequencyWarning[];
  /** letzter Tag vor Gültigkeitsverlust durch Unterbrechung (nur laufende, begonnene VOs) */
  interruptionBy: string | null;
  interrupted: boolean;
  /** Bezugspunkt der 12-Wochen-Unterbrechung (letzte Behandlung, Wiederaufnahme oder Übernahme) – für Meldungen */
  interruptionSince: { label: string; date: string } | null;
  /** Grund, die Verordnung als „Frist überschritten“ zu kennzeichnen (null = gültig) */
  expiry: "start_missed" | "interrupted" | null;
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
  /** Tag der Wiederaufnahme aus „Frist überschritten“ (prescriptions.reopened_at), s. canTransition */
  reopenedOn?: string | null;
  /**
   * Regelwerk der Verordnung. Nur Übernahmen/Altbestand (!autoExpiryApplies) dürfen „in Behandlung“ ohne erfassten
   * Behandlungstag sein (Beginn im Fremdsystem); fehlt die Angabe, gilt das wie bisher als Übernahme.
   */
  rulesVersion?: string | null;
  /** Tag der Übernahme/Erfassung in PodoHero (created_at) – Unterbrechung einer Übernahme ohne erfassten Tag zählt ab hier */
  importedOn?: string | null;
}): PrescriptionEvaluation {
  const startBy = p.startBy ?? startDeadline(p.issuedAt, p.urgent);
  const unitsUsed = p.treatmentDates.length;
  const unitsRemaining = Math.max(0, p.units - unitsUsed);
  const sorted = [...p.treatmentDates].sort();
  const firstDate = sorted[0];
  // Status „in Behandlung“ ohne erfassten Behandlungstag: Beginn liegt außerhalb von PodoHero (Übernahme aus anderer
  // Praxissoftware) → Beginnfrist gilt als eingehalten (PR #111 C1) – aber nur für Übernahmen/Altbestand, nicht für mit
  // PodoHero erfasste Verordnungen (Review-Runde 2, S-1). Ebenso nach bestätigter Wiederaufnahme.
  const startedElsewhere = !firstDate && p.status === "active" && !autoExpiryApplies(p.rulesVersion);
  const startConfirmed = startedElsewhere || !!p.reopenedOn;
  // Unterbrechung zählt ab der letzten Behandlung bzw. ab der Wiederaufnahme, falls diese später liegt; bei einer
  // Übernahme ohne erfassten Tag ab dem Übernahmedatum (Review-Runde 2, S-2)
  const lastTreatment = sorted[sorted.length - 1] ?? (startedElsewhere && p.importedOn ? p.importedOn : undefined);
  const lastDate = p.reopenedOn && (!lastTreatment || p.reopenedOn > lastTreatment) ? p.reopenedOn : lastTreatment;
  const anchorLabel = lastDate && lastDate === p.reopenedOn ? "der Wiederaufnahme" : firstDate ? "der letzten Behandlung" : "der Übernahme in PodoHero";
  const interruptionSince = lastDate ? { label: anchorLabel, date: lastDate } : null;
  const daysToStartDeadline = daysBetween(p.today, startBy);
  const startState: PrescriptionEvaluation["startState"] = firstDate || startConfirmed
    ? "started"
    : daysToStartDeadline < 0
      ? "missed"
      : daysToStartDeadline <= START_WARN_DAYS
        ? "soon"
        : "ok";
  const running = p.status === "open" || p.status === "active";
  const freq = frequencyWarnings(p.treatmentDates, p.frequency, { today: p.today, running });
  const interruptionBy = running && lastDate && unitsRemaining > 0 ? interruptionDeadline(lastDate) : null;
  const interrupted = !!interruptionBy && p.today > interruptionBy;
  const expiry: PrescriptionEvaluation["expiry"] = !running ? null : startState === "missed" ? "start_missed" : interrupted ? "interrupted" : null;
  const messages: string[] = [];
  const de = (iso: string) => iso.split("-").reverse().join(".");
  if (firstDate && firstDate > startBy && !p.reopenedOn) messages.push(`Behandlungsbeginn (${de(firstDate)}) nach der Frist (${de(startBy)}).`);
  if (startedElsewhere) {
    messages.push(
      p.importedOn
        ? `Übernommene Verordnung ohne erfassten Behandlungstag – Beginn und letzte Behandlung bitte mit der Vorakte abgleichen. Die ${INTERRUPTION_WEEKS}-Wochen-Unterbrechung zählt ab der Übernahme (${de(p.importedOn)}).`
        : "Behandlungsbeginn nicht in PodoHero erfasst (Übernahme) – Unterbrechung wird ab der ersten erfassten Behandlung geprüft.",
    );
  }
  if (p.reopenedOn) messages.push(`Aus „Frist überschritten“ wiederaufgenommen am ${de(p.reopenedOn)} (Begründung in der Akte) – Unterbrechungsfrist ab diesem Tag.`);
  if (startState === "missed") messages.push(`Behandlungsbeginn bis ${de(startBy)} verpasst – Verordnung ist ungültig (Frist überschritten).`);
  if (startState === "soon") messages.push(`Behandlung muss bis ${de(startBy)} beginnen (noch ${daysToStartDeadline} Tage).`);
  if (interrupted) messages.push(`Seit ${anchorLabel} (${de(lastDate!)}) mehr als ${INTERRUPTION_WEEKS} Wochen – Verordnung ist ungültig (Frist überschritten).`);
  else if (interruptionBy && daysBetween(p.today, interruptionBy) <= 14) messages.push(`Nächste Behandlung spätestens ${de(interruptionBy)} – sonst verliert die Verordnung ihre Gültigkeit (${INTERRUPTION_WEEKS} Wochen Unterbrechung).`);
  for (const w of freq) messages.push(`Abstand ${w.gapDays} Tage (${de(w.from)} → ${de(w.to)}) überschreitet die Frequenz (max. ${w.allowedDays} Tage + 2 Werktage).`);
  if (running && unitsRemaining > 0 && unitsRemaining <= 1 && unitsUsed > 0) messages.push("Letzte Einheit – Folgeverordnung anfragen.");

  if (p.status === "correction_needed") messages.push("Abgerechnete Verordnung muss korrigiert werden (Korrekturvermerk) – danach erneut „abrechnungsreif“ setzen.");
  let light: Light = "green";
  if (p.status === "correction_needed") light = "red";
  else if (p.status === "billing_ready") light = "blue";
  else if (!running) light = "gray";
  else if (expiry || (firstDate && firstDate > startBy && !p.reopenedOn)) light = "red";
  else if (startState === "soon" || startedElsewhere || freq.length || (unitsRemaining <= 1 && unitsUsed > 0)) light = "yellow";
  return { startBy, daysToStartDeadline, startState, unitsUsed, unitsRemaining, frequency: freq, interruptionBy, interrupted, interruptionSince, expiry, light, messages };
}

/**
 * Hinweise beim PLANEN eines Termins auf eine Verordnung (Termin-Formular): Restmenge, Beginnfrist, Unterbrechung,
 * Frequenz. Nur Warnungen – gespeichert wird trotzdem.
 */
export function planningWarnings(input: {
  group: string;
  frequency: string | null | undefined;
  urgent: boolean;
  issuedAt: string;
  startBy?: string | null;
  /** Beginn schon erfolgt (auch außerhalb erfasst/Übernahme) oder per Wiederaufnahme bestätigt → keine Beginnfrist-Warnung */
  started?: boolean;
  /** Wiederaufnahme aus „Frist überschritten“: Unterbrechung zählt ab diesem Tag */
  reopenedOn?: string | null;
  units: number;
  /** Behandlungstage (dokumentiert) */
  treatmentDates: string[];
  /** bereits geplante, nicht dokumentierte Termine auf diese Verordnung */
  plannedDates: string[];
  /** neue Termine */
  newDates: string[];
}): string[] {
  const out: string[] = [];
  const de = (iso: string) => iso.split("-").reverse().join(".");
  const used = input.treatmentDates.length;
  const planned = input.plannedDates.length;
  const remaining = input.units - used - planned;
  if (input.newDates.length > remaining) {
    out.push(
      remaining <= 0
        ? `Keine Einheiten mehr frei (${used} erbracht, ${planned} schon geplant von ${input.units}).`
        : `Nur noch ${remaining} von ${input.units} Einheiten frei (${used} erbracht, ${planned} geplant) – ${input.newDates.length} Termine geplant.`,
    );
  }
  const startBy = input.startBy ?? startDeadline(input.issuedAt, input.urgent);
  const all = [...input.treatmentDates, ...input.plannedDates].sort();
  const firstNew = [...input.newDates].sort()[0];
  if (firstNew && !all.length && !input.started && firstNew > startBy) out.push(`Erster Termin ${de(firstNew)} liegt nach dem spätesten Behandlungsbeginn ${de(startBy)} – die Verordnung wäre dann ungültig.`);
  let last = [...input.treatmentDates, ...input.plannedDates].filter((d) => !firstNew || d <= firstNew).sort().at(-1) ?? null;
  for (const d of [...input.newDates].sort()) {
    // Unterbrechung ab der letzten Behandlung bzw. ab der Wiederaufnahme (falls später); Frequenz nur zwischen Behandlungen
    const anchor = input.reopenedOn && (!last || input.reopenedOn > last) && input.reopenedOn <= d ? input.reopenedOn : last;
    if (anchor && d > interruptionDeadline(anchor)) out.push(`Termin ${de(d)}: mehr als ${INTERRUPTION_WEEKS} Wochen nach ${anchor === last ? "der letzten Behandlung" : "der Wiederaufnahme"} (${de(anchor)}) – Verordnung wäre ungültig.`);
    const dev = frequencyDeviation({ group: input.group, frequency: input.frequency, lastDate: last, date: d });
    if (dev) out.push(`Termin ${de(d)}: ${frequencyDeviationText(dev)} Bei der Behandlung ist eine Begründung nötig.`);
    last = d;
  }
  return out;
}
