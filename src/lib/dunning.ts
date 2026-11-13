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
 *  - Spätere Mahngebühren nur als konkrete, angemessene Kosten (keine Pauschalen) → Obergrenze MAX_FEE_CENTS.
 *  - Verzugszinsen (§ 288 Abs. 1 BGB: 5 Prozentpunkte über dem Basiszinssatz) werden nicht automatisch berechnet,
 *    die Standardtexte weisen nur darauf hin.
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

export const MAX_FEE_CENTS = 2500;
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
  reminder: [
    "{anrede},",
    "",
    "sicher ist es Ihrer Aufmerksamkeit entgangen: Für unsere Rechnung {rechnungsnummer} vom {rechnungsdatum} (zahlbar bis {faellig_am}) konnten wir bisher keinen vollständigen Zahlungseingang feststellen. Offen ist noch ein Betrag von {offener_betrag}.",
    "",
    "Bitte überweisen Sie den Betrag bis zum {frist} unter Angabe der Rechnungsnummer. Sollten Sie inzwischen bezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
  ].join("\n"),
  dunning1: [
    "{anrede},",
    "",
    "leider ist unsere Rechnung {rechnungsnummer} vom {rechnungsdatum} trotz unserer Zahlungserinnerung noch nicht vollständig beglichen. Offen ist ein Betrag von {offener_betrag}.",
    "",
    "Wir bitten Sie, den Gesamtbetrag von {gesamtbetrag} bis spätestens {frist} unter Angabe der Rechnungsnummer zu überweisen. Sollten Sie inzwischen bezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
  ].join("\n"),
  dunning2: [
    "{anrede},",
    "",
    "trotz Zahlungserinnerung und Mahnung ist unsere Rechnung {rechnungsnummer} vom {rechnungsdatum} weiterhin nicht vollständig beglichen. Offen ist ein Betrag von {offener_betrag}.",
    "",
    "Wir fordern Sie hiermit letztmalig auf, den Gesamtbetrag von {gesamtbetrag} bis spätestens {frist} zu überweisen. Sollte bis dahin kein Zahlungseingang erfolgen, behalten wir uns vor, ohne weitere Ankündigung gerichtliche Schritte (gerichtliches Mahnverfahren) einzuleiten und Verzugszinsen in gesetzlicher Höhe (§ 288 BGB) zu verlangen. Die dadurch entstehenden Kosten gehen zu Ihren Lasten.",
    "",
    "Sollten Sie inzwischen bezahlt haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
  ].join("\n"),
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
    const text = typeof r.text === "string" && r.text.trim() ? r.text.slice(0, MAX_TEXT) : d.text;
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
export type PastDunning = { stage: string; letterDate: string };

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
  | { state: "waiting" | "due"; daysOverdue: number; next: DunningStage; dueOn: string; last: DunningStage | null };

/**
 * Nächste Mahnstufe einer Rechnung zum Stichtag `today` (YYYY-MM-DD, Berliner Kalendertag).
 * Zahlungserinnerung: `days` Tage nach dem Zahlungsziel; weitere Stufen: `days` Tage nach dem vorigen Schreiben.
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
  for (const p of past) {
    const i = DUNNING_STAGES.indexOf(p.stage as DunningStage);
    if (i > lastIdx) {
      lastIdx = i;
      lastDate = p.letterDate.slice(0, 10);
    }
  }
  const last = lastIdx >= 0 ? DUNNING_STAGES[lastIdx] : null;
  if (lastIdx >= DUNNING_STAGES.length - 1) return { state: "exhausted", daysOverdue, last: last! };
  const next = DUNNING_STAGES[lastIdx + 1];
  const dueOn = addDaysIso(lastDate ?? inv.dueAt.slice(0, 10), settings.stages[next].days);
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

/** Ersetzt {platzhalter}; unbekannte Platzhalter bleiben stehen (fällt in der Vorschau auf). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (Object.hasOwn(values, k) ? values[k] : m));
}

/** Zu zahlender Betrag laut Schreiben: offener Rechnungsbetrag + alle Mahngebühren (frühere und diese). */
export const dunningTotalCents = (openCents: number, feesTotalCents: number) => openCents + feesTotalCents;
