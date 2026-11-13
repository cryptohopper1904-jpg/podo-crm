/**
 * Mahnwesen für Privatrechnungen – reine Funktionen ohne Server-Importe (Tests, PDF, Oberfläche).
 *
 * Stufen: Zahlungserinnerung → 1. Mahnung → 2. Mahnung (letzte Mahnung).
 * Einstellungen liegen in organizations.settings.dunning (eigener Schlüssel, damit „Belege speichern“
 * sie nicht überschreibt):
 *   dunning.payDays                 neue Zahlungsfrist im Schreiben (Tage ab Schreiben)
 *   dunning.stages.<stage>.days     Zahlungserinnerung: Tage nach Fälligkeit; weitere Stufen: Tage nach dem vorigen Schreiben
 *   dunning.stages.<stage>.feeCents Mahngebühr (nur konkrete Kosten wie Porto/Material, Standard 0 €)
 *   dunning.stages.<stage>.text     Textvorlage mit Platzhaltern
 *
 * Rechtliche Annahmen (BGB, Verbraucher:innen):
 *  - Unsere Rechnungen enthalten keinen Hinweis nach § 286 Abs. 3 BGB; Verzug tritt deshalb erst mit der ersten
 *    Mahnung ein – das ist hier bereits die „Zahlungserinnerung“ (eine eindeutige Zahlungsaufforderung nach Fälligkeit).
 *  - Kosten der verzugsbegründenden ersten Mahnung sind kein Verzugsschaden → Gebühr der Zahlungserinnerung immer 0 €.
 *  - Spätere Mahngebühren nur als konkrete, angemessene Kosten (keine Pauschalen). Vorerst deaktiviert (MAX_FEE_CENTS = 0),
 *    bis Gebühren-Zahlungen verbucht werden können.
 *  - Verzugszinsen (§ 288 Abs. 1 BGB: 5 Prozentpunkte über dem Basiszinssatz) werden nicht automatisch berechnet,
 *    der Standardtext der 2. Mahnung weist nur darauf hin.
 *  - Eine Stufe wird erst nach Ablauf der Frist des vorigen Schreibens fällig (Verzug ab Fristablauf).
 * Die Mahngebühr verändert die Rechnung nicht (GoBD): sie wird je Mahnung gespeichert und nur im Schreiben ausgewiesen.
 */
import { addDaysIso } from "./invoice-math";

export const DUNNING_STAGES = ["reminder", "dunning1", "dunning2"] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];

export const DUNNING_STAGE_LABEL: Record<DunningStage, string> = {
  reminder: "Zahlungserinnerung",
  dunning1: "1. Mahnung",
  dunning2: "2. Mahnung",
};

/** Überschrift im Schreiben */
export const DUNNING_STAGE_TITLE: Record<DunningStage, string> = {
  reminder: "Zahlungserinnerung",
  dunning1: "1. Mahnung",
  dunning2: "2. Mahnung – letzte Mahnung",
};

/** Nur echte Forderungen werden gemahnt – nie Quittungen, Anzahlungen oder Stornos. */
export const DUNNABLE_KINDS = ["invoice", "collective", "no_show_fee"] as const;
export const DUNNABLE_STATUSES = ["issued", "partially_paid"] as const;

/**
 * Obergrenze der Mahngebühr in der App. Vorerst 0 €: Für Gebühren gibt es noch keinen Buchungsweg
 * (Zahlung Rechnung + Gebühr wäre eine Überzahlung). Die DB erlaubt bereits bis 25 € (Schema vorbereitet).
 */
export const MAX_FEE_CENTS = 0;
/** Obergrenze, sobald Gebühren verbucht werden können (entspricht der DB-Prüfung) */
export const DB_MAX_FEE_CENTS = 2500;
export const FEES_ENABLED = MAX_FEE_CENTS > 0;
export const MAX_STAGE_DAYS = 90;
export const MAX_PAY_DAYS = 60;
export const MAX_TEXT = 2000;

export type DunningStageSettings = { days: number; feeCents: number; text: string };
export type DunningSettings = { payDays: number; stages: Record<DunningStage, DunningStageSettings> };

export const DUNNING_PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "anrede", label: "Anrede, z. B. „Sehr geehrte Frau Muster“" },
  { key: "rechnungsnummer", label: "Rechnungsnummer" },
  { key: "rechnungsdatum", label: "Rechnungsdatum" },
  { key: "faellig_am", label: "ursprüngliches Zahlungsziel" },
  { key: "offener_betrag", label: "offener Rechnungsbetrag" },
  { key: "gebuehren", label: "Mahngebühren (gesamt)" },
  { key: "gesamtbetrag", label: "zu zahlender Gesamtbetrag" },
  { key: "frist", label: "neue Zahlungsfrist (Datum)" },
  { key: "praxis", label: "Praxisname" },
];

export const DEFAULT_DUNNING_TEXT: Record<DunningStage, string> = {
  reminder:
    "{anrede},\n\nunsere Rechnung {rechnungsnummer} vom {rechnungsdatum} war am {faellig_am} zur Zahlung fällig. Bis heute konnten wir keinen vollständigen Zahlungseingang feststellen; offen ist noch ein Betrag von {offener_betrag}.\n\nBitte überweisen Sie diesen Betrag bis spätestens {frist} unter Angabe der Rechnungsnummer. Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.",
  dunning1:
    "{anrede},\n\nunsere Rechnung {rechnungsnummer} vom {rechnungsdatum} ist trotz unserer Zahlungserinnerung noch nicht vollständig beglichen. Offen ist ein Betrag von {offener_betrag}. Seit Ablauf der in der Zahlungserinnerung gesetzten Frist befinden Sie sich in Zahlungsverzug.\n\nBitte überweisen Sie den Gesamtbetrag von {gesamtbetrag} (Aufstellung unten) bis spätestens {frist} unter Angabe der Rechnungsnummer. Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.",
  dunning2:
    "{anrede},\n\ntrotz Zahlungserinnerung und Mahnung ist unsere Rechnung {rechnungsnummer} vom {rechnungsdatum} weiterhin nicht vollständig beglichen. Offen ist ein Betrag von {offener_betrag}.\n\nWir fordern Sie hiermit letztmalig auf, den Gesamtbetrag von {gesamtbetrag} (Aufstellung unten) bis spätestens {frist} unter Angabe der Rechnungsnummer zu überweisen. Geht bis dahin keine Zahlung ein, behalten wir uns vor, ohne weitere Ankündigung gerichtliche Schritte (z. B. ein gerichtliches Mahnverfahren) einzuleiten. Für die Dauer des Verzugs können wir zudem Verzugszinsen in Höhe von 5 Prozentpunkten über dem Basiszinssatz verlangen (§ 288 Abs. 1 BGB).\n\nSollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte als gegenstandslos.",
};

export const DEFAULT_DUNNING_SETTINGS: DunningSettings = {
  payDays: 10,
  stages: {
    reminder: { days: 7, feeCents: 0, text: DEFAULT_DUNNING_TEXT.reminder },
    dunning1: { days: 14, feeCents: 0, text: DEFAULT_DUNNING_TEXT.dunning1 },
    dunning2: { days: 14, feeCents: 0, text: DEFAULT_DUNNING_TEXT.dunning2 },
  },
};

const intIn = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);

/** Liest settings.dunning; Ungültiges fällt auf die Standardwerte zurück. */
export function readDunningSettings(settings: Record<string, unknown> | null | undefined): DunningSettings {
  const raw = ((settings ?? {}).dunning ?? {}) as Record<string, unknown>;
  const st = (raw.stages ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const stages = {} as Record<DunningStage, DunningStageSettings>;
  for (const s of DUNNING_STAGES) {
    const d = DEFAULT_DUNNING_SETTINGS.stages[s];
    const r = st[s] ?? {};
    const text = typeof r.text === "string" && r.text.trim() ? normalizeNewlines(r.text).slice(0, MAX_TEXT) : d.text;
    stages[s] = {
      days: intIn(r.days, 1, MAX_STAGE_DAYS, d.days),
      // Zahlungserinnerung begründet erst den Verzug → keine Gebühr
      feeCents: s === "reminder" ? 0 : intIn(r.feeCents, 0, MAX_FEE_CENTS, d.feeCents),
      text,
    };
  }
  return { payDays: intIn(raw.payDays, 1, MAX_PAY_DAYS, DEFAULT_DUNNING_SETTINGS.payDays), stages };
}

export type DunnableInvoice = { kind: string; status: string; dueAt: string | null; totalCents: number; paidCents: number };
export type PastDunning = { stage: string; letterDate: string; payBy: string; sentVia: string | null };

/** Ganze Kalendertage von a bis b (YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export const isDunnable = (inv: Pick<DunnableInvoice, "kind" | "status">) =>
  (DUNNABLE_KINDS as readonly string[]).includes(inv.kind) && (DUNNABLE_STATUSES as readonly string[]).includes(inv.status);

export type DunningState =
  | { state: "not_dunnable"; reason: string }
  | { state: "not_overdue"; daysOverdue: 0 }
  | { state: "exhausted"; daysOverdue: number; last: DunningStage }
  /** vorige Stufe erstellt, aber noch nicht versendet (kein Versandvermerk) → nächste Stufe gesperrt */
  | { state: "unsent"; daysOverdue: number; last: DunningStage; next: DunningStage }
  | { state: "waiting" | "due"; daysOverdue: number; next: DunningStage; dueOn: string; last: DunningStage | null };

/**
 * Nächste Mahnstufe einer Rechnung zum Stichtag `today` (YYYY-MM-DD, Berliner Kalendertag).
 * Zahlungserinnerung: `days` Tage nach dem Zahlungsziel; weitere Stufen: `days` Tage nach dem vorigen Schreiben,
 * frühestens am Tag nach der dort gesetzten Zahlungsfrist (pay_by) und nur, wenn es versendet ist (Versandvermerk).
 * Feiertage/Wochenenden werden nicht berücksichtigt.
 */
export function dunningState(inv: DunnableInvoice, past: PastDunning[], settings: DunningSettings, today: string): DunningState {
  if (!isDunnable(inv)) return { state: "not_dunnable", reason: "Nur offene Rechnungen, Sammelrechnungen und Ausfallhonorare werden gemahnt." };
  if (inv.totalCents - inv.paidCents <= 0) return { state: "not_dunnable", reason: "Kein offener Betrag." };
  if (!inv.dueAt) return { state: "not_dunnable", reason: "Kein Zahlungsziel." };
  const daysOverdue = daysBetween(inv.dueAt.slice(0, 10), today);
  if (daysOverdue <= 0) return { state: "not_overdue", daysOverdue: 0 };
  let lastIdx = -1;
  let lastDate: string | null = null;
  let lastPayBy: string | null = null;
  let lastSent: string | null = null;
  for (const p of past) {
    const i = DUNNING_STAGES.indexOf(p.stage as DunningStage);
    if (i > lastIdx) {
      lastIdx = i;
      lastDate = p.letterDate.slice(0, 10);
      lastPayBy = p.payBy.slice(0, 10);
      lastSent = p.sentVia;
    }
  }
  const last = lastIdx >= 0 ? DUNNING_STAGES[lastIdx] : null;
  if (lastIdx >= DUNNING_STAGES.length - 1) return { state: "exhausted", daysOverdue, last: last! };
  const next = DUNNING_STAGES[lastIdx + 1];
  if (last && !lastSent) return { state: "unsent", daysOverdue, last, next };
  let dueOn = addDaysIso(lastDate ?? inv.dueAt.slice(0, 10), settings.stages[next].days);
  // nie vor Ablauf der im vorigen Schreiben gesetzten Zahlungsfrist
  if (lastPayBy) {
    const afterDeadline = addDaysIso(lastPayBy, 1);
    if (afterDeadline > dueOn) dueOn = afterDeadline;
  }
  return { state: today >= dueOn ? "due" : "waiting", daysOverdue, next, dueOn, last };
}

/** Anrede für das Schreiben: „Sehr geehrte Frau Muster“ / „Sehr geehrter Herr Muster“ / „Guten Tag Alex Muster“ / Firma. */
export function salutationLine(p: { salutation?: string | null; title?: string | null; firstName?: string | null; lastName: string } | null, billingName?: string | null): string {
  if (billingName) return "Sehr geehrte Damen und Herren";
  if (!p) return "Sehr geehrte Damen und Herren";
  const s = (p.salutation ?? "").trim().toLowerCase();
  const name = [p.title, p.lastName].filter(Boolean).join(" ");
  if (s === "frau") return `Sehr geehrte Frau ${name}`;
  if (s === "herr") return `Sehr geehrter Herr ${name}`;
  return `Guten Tag ${[p.title, p.firstName, p.lastName].filter(Boolean).join(" ")}`;
}

/** Zeilenumbrüche vereinheitlichen (Textarea sendet \r\n) – vor Längenprüfung und Speicherung. */
export const normalizeNewlines = (s: string) => s.replace(/\r\n?/g, "\n");

/**
 * Platzhalter, der erst beim Erzeugen von PDF/E-Mail aus pay_by ersetzt wird: Beim E-Mail-Versand beginnt
 * die Frist am Versandtag (pay_by wird dann einmalig nach hinten verschoben).
 */
export const FRIST_PLACEHOLDER = "{frist}";

/** Ersetzt {platzhalter}; unbekannte Platzhalter bleiben stehen (fällt in der Vorschau auf). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k] : m));
}

/** Zu zahlender Betrag laut Schreiben: offener Rechnungsbetrag + alle Mahngebühren (frühere und diese). */
export const dunningTotalCents = (openCents: number, feesTotalCents: number) => openCents + feesTotalCents;
