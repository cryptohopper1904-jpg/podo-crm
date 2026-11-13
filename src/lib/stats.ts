/**
 * Auswertung & Statistik – reine Funktionen (Zeitraum, Wochentage, Heatmap, Median, Lager-Reichweite).
 * Die Aggregation selbst läuft in SQL (src/server/stats.ts); hier liegt alles, was ohne Datenbank testbar ist.
 * Zeitzone der Praxis: Europe/Berlin (Wochentag/Stunde immer in Ortszeit, auch über die Sommerzeit-Umstellung).
 */
import { TZ } from "./format";
import { isValidIsoDate } from "./iso-date";

// ───────────────────────── Zeitraum ─────────────────────────

export const PERIOD_PRESETS = ["monat", "vormonat", "quartal", "vorquartal", "jahr", "vorjahr", "12monate", "frei"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  monat: "Dieser Monat",
  vormonat: "Letzter Monat",
  quartal: "Dieses Quartal",
  vorquartal: "Letztes Quartal",
  jahr: "Dieses Jahr",
  vorjahr: "Letztes Jahr",
  "12monate": "Letzte 12 Monate",
  frei: "Frei wählen",
};

export const DEFAULT_PRESET: PeriodPreset = "12monate";
/** Längster frei wählbarer Zeitraum (Performance, sinnvolle Aussagen) */
export const MAX_PERIOD_DAYS = 5 * 366;

/**
 * Zeitraum mit Datumsgrenzen in Berliner Ortszeit; `to` ist einschließlich.
 * Laufende Zeiträume (dieser Monat/dieses Quartal/…) werden nur bis heute ausgewertet: `until` = min(to, heute),
 * `days` = Kalendertage von `from` bis `until` (0, wenn der Zeitraum noch nicht begonnen hat). Alle Nenner
 * (Ø je Wochentag, Reichweite) und alle Abfragen nutzen `until` – künftige Termine verzerren sonst Vorlauf und Durchschnitte.
 */
export type Period = { preset: PeriodPreset; from: string; to: string; until: string; label: string; days: number };

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
const partsOf = (iso: string) => iso.split("-").map(Number) as [number, number, number];

/** Kalendertage addieren (rein auf dem Datum, keine Uhrzeit/Zeitzone) */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = partsOf(iso);
  return isoOf(y, m, d + days);
}

/** Anzahl Kalendertage von `from` bis `to` einschließlich (0, wenn `to` vor `from` liegt) */
export function daysInclusive(from: string, to: string): number {
  const [y1, m1, d1] = partsOf(from);
  const [y2, m2, d2] = partsOf(to);
  return Math.max(0, Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1);
}

const fmtDe = (iso: string) => {
  const [y, m, d] = partsOf(iso);
  return `${pad(d)}.${pad(m)}.${y}`;
};

/**
 * Zeitraum aus den Suchparametern (?zeitraum=…&von=…&bis=…). Ungültiges → Standard (letzte 12 Monate).
 * „Frei“: von/bis müssen gültige Daten sein; vertauschte Grenzen werden getauscht, zu lange Zeiträume gekürzt.
 */
export function resolvePeriod(sp: { zeitraum?: unknown; von?: unknown; bis?: unknown }, today: string): Period {
  const raw = typeof sp.zeitraum === "string" ? sp.zeitraum : "";
  const preset: PeriodPreset = (PERIOD_PRESETS as readonly string[]).includes(raw) ? (raw as PeriodPreset) : DEFAULT_PRESET;
  const [y, m] = partsOf(today);
  const q = Math.floor((m - 1) / 3); // 0..3
  const make = (p: PeriodPreset, from: string, to: string, label: string): Period => {
    const until = to < today ? to : today;
    return { preset: p, from, to, until, label, days: daysInclusive(from, until) };
  };
  switch (preset) {
    case "monat":
      return make(preset, isoOf(y, m, 1), isoOf(y, m + 1, 0), `${monthName(m)} ${y}`);
    case "vormonat": {
      const from = isoOf(y, m - 1, 1);
      const [py, pm] = partsOf(from);
      return make(preset, from, isoOf(y, m, 0), `${monthName(pm)} ${py}`);
    }
    case "quartal":
      return make(preset, isoOf(y, q * 3 + 1, 1), isoOf(y, q * 3 + 4, 0), `${q + 1}. Quartal ${y}`);
    case "vorquartal": {
      const from = isoOf(y, q * 3 - 2, 1);
      const [py, pm] = partsOf(from);
      return make(preset, from, isoOf(y, q * 3 + 1, 0), `${Math.floor((pm - 1) / 3) + 1}. Quartal ${py}`);
    }
    case "jahr":
      return make(preset, `${y}-01-01`, `${y}-12-31`, `Jahr ${y}`);
    case "vorjahr":
      return make(preset, `${y - 1}-01-01`, `${y - 1}-12-31`, `Jahr ${y - 1}`);
    case "frei": {
      const ok = (v: unknown): v is string => typeof v === "string" && isValidIsoDate(v, { minYear: 2000, maxYear: y + 2 });
      if (ok(sp.von) && ok(sp.bis)) {
        const to = sp.von <= sp.bis ? sp.bis : sp.von;
        let from = sp.von <= sp.bis ? sp.von : sp.bis;
        if (daysInclusive(from, to) > MAX_PERIOD_DAYS) from = addDaysIso(to, -(MAX_PERIOD_DAYS - 1));
        return make(preset, from, to, `${fmtDe(from)} – ${fmtDe(to)}`);
      }
      return resolvePeriod({ zeitraum: DEFAULT_PRESET }, today);
    }
    default: {
      // letzte 12 Monate: 12 volle Monate einschließlich des laufenden
      const from = isoOf(y, m - 11, 1);
      return make("12monate", from, isoOf(y, m + 1, 0), `${fmtDe(from)} – ${fmtDe(isoOf(y, m + 1, 0))}`);
    }
  }
}

/** Suchparameter eines Zeitraums (für Links zwischen den Reitern) */
export function periodQuery(p: Period): Record<string, string> {
  return p.preset === "frei" ? { zeitraum: "frei", von: p.from, bis: p.to } : { zeitraum: p.preset };
}

export const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const MONTH_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const monthName = (m: number) => MONTH_NAMES[(((m - 1) % 12) + 12) % 12];

/** Alle Monate (JJJJ-MM) eines Zeitraums, in Reihenfolge */
export function monthsOf(p: Pick<Period, "from" | "to">): string[] {
  const out: string[] = [];
  let [y, m] = partsOf(p.from);
  const [ty, tm] = partsOf(p.to);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_SHORT[m - 1]} ${String(y).slice(2)}`;
};

// ───────────────────────── Wochentage & Stunden (Berliner Ortszeit) ─────────────────────────

/** ISO-Wochentage: Index 0 = Montag (isodow 1) … 6 = Sonntag (isodow 7) */
export const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
export const WEEKDAYS_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Wie oft jeder Wochentag (Mo…So) im Zeitraum vorkommt – Nenner für „Ø je Tag“ */
export function weekdayOccurrences(from: string, to: string): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  const n = daysInclusive(from, to);
  if (!n) return out;
  const [y, m, d] = partsOf(from);
  const first = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Mo
  const full = Math.floor(n / 7);
  for (let i = 0; i < 7; i++) out[i] = full;
  for (let i = 0; i < n % 7; i++) out[(first + i) % 7]++;
  return out;
}

const berlinParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", weekday: "short", hour: "2-digit" });
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * Heatmap-Fach eines Zeitpunkts: ISO-Wochentag (1 = Mo … 7 = So) und volle Stunde in Berliner Ortszeit.
 * Entspricht in SQL `extract(isodow|hour from ts at time zone 'Europe/Berlin')` (gleiche Sommerzeit-Regeln).
 */
export function berlinWeekdayHour(d: Date): { isodow: number; hour: number } {
  const p = berlinParts.formatToParts(d);
  return { isodow: DOW[p.find((x) => x.type === "weekday")!.value], hour: Number(p.find((x) => x.type === "hour")!.value) };
}

// ───────────────────────── Kennzahlen ─────────────────────────

/** Median (Mittelwert der beiden mittleren Werte bei gerader Anzahl, wie percentile_cont(0.5)); null bei leer */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Vorlaufzeit in Stunden zwischen Buchung und Terminbeginn; null, wenn der Termin nachträglich eingetragen wurde */
export function leadTimeHours(createdAt: Date, startsAt: Date): number | null {
  const h = (startsAt.getTime() - createdAt.getTime()) / 3_600_000;
  return h >= 0 ? h : null;
}

/** Vorlaufzeit lesbar: unter 2 Tagen in Stunden, darunter ganze Tage bzw. Wochen */
export function formatLead(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "–";
  if (hours < 1) return "unter 1 Std.";
  if (hours < 48) return `${Math.round(hours)} Std.`;
  const days = hours / 24;
  if (days < 21) return `${Math.round(days)} Tage`;
  const weeks = Math.round((days / 7) * 10) / 10;
  return `${weeks.toLocaleString("de-DE")} Wochen`;
}

/** Kurzform für Heatmap-Zellen: „5 h“, „3 T“, „6 W“ */
export function formatLeadShort(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "";
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 21) return `${Math.round(days)} T`;
  return `${Math.round(days / 7)} W`;
}

/** Anteil in Prozent mit einer Nachkommastelle; null, wenn die Grundmenge leer ist */
export function rate(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export const pctDe = (v: number | null) => (v === null ? "–" : `${v.toLocaleString("de-DE")} %`);

// ───────────────────────── Heatmap ─────────────────────────

export type HeatRow = { isodow: number; hour: number; value: number };
export type Heatmap = {
  /** angezeigte Stunden (lückenlos von der frühesten bis zur spätesten Stunde mit Daten) */
  hours: number[];
  /** [Wochentag 0 = Mo][Stunde-Index] → Wert oder null (kein Termin) */
  cells: (number | null)[][];
  max: number;
  /** Wochentage, die überhaupt Daten haben (Sa/So werden sonst ausgeblendet) */
  days: number[];
};

/** Baut das Raster Wochentag × Stunde. Ohne Daten: Mo–Fr, 8–18 Uhr leer. */
export function buildHeatmap(rows: readonly HeatRow[], defaults = { from: 8, to: 18 }): Heatmap {
  const valid = rows.filter((r) => r.isodow >= 1 && r.isodow <= 7 && r.hour >= 0 && r.hour <= 23 && Number.isFinite(r.value));
  const minH = valid.length ? Math.min(...valid.map((r) => r.hour)) : defaults.from;
  const maxH = valid.length ? Math.max(...valid.map((r) => r.hour)) : defaults.to;
  const hours = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const cells = Array.from({ length: 7 }, () => hours.map((): number | null => null));
  for (const r of valid) cells[r.isodow - 1][r.hour - minH] = (cells[r.isodow - 1][r.hour - minH] ?? 0) + r.value;
  const max = Math.max(0, ...cells.flat().map((v) => v ?? 0));
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => d < 5 || cells[d].some((v) => v !== null));
  return { hours, cells, max, days };
}

/** Farbstufe 0–4 einer Zelle (0 = leer) – gleichmäßig zum Maximum */
export function heatLevel(value: number | null, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value === null || value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as 1 | 2 | 3 | 4;
}

/** Wochentage nach Ø je Kalendertag sortiert (stärkster zuerst); Tage ohne Vorkommen im Zeitraum entfallen */
export function rankWeekdays(totals: readonly number[], occurrences: readonly number[]) {
  return WEEKDAYS.map((label, i) => ({ index: i, label, total: totals[i] ?? 0, perDay: occurrences[i] ? (totals[i] ?? 0) / occurrences[i] : 0 }))
    .filter((d) => occurrences[d.index] > 0)
    .sort((a, b) => b.perDay - a.perDay || a.index - b.index);
}

// ───────────────────────── Lager ─────────────────────────

/**
 * Reichweite und Lagerumschlag aus Bestand und Abgang im Zeitraum.
 * - Reichweite: Tage, bis der heutige Bestand beim bisherigen Tempo aufgebraucht ist
 * - Umschlag/Jahr: Abgang aufs Jahr hochgerechnet ÷ heutiger Bestand (Näherung ohne Bestandsverlauf)
 */
export function stockCoverage(stock: number, outflow: number, days: number): { coverageDays: number | null; turnoverPerYear: number | null } {
  if (outflow <= 0 || days <= 0) return { coverageDays: null, turnoverPerYear: null };
  const perDay = outflow / days;
  if (stock <= 0) return { coverageDays: 0, turnoverPerYear: null };
  return { coverageDays: Math.floor(stock / perDay), turnoverPerYear: Math.round(((perDay * 365) / stock) * 10) / 10 };
}

/** Online gebuchte Termine: Online-Buchung, Patientenportal, Doctolib */
export const ONLINE_SOURCES = ["online", "portal", "doctolib"] as const;
/** Für die Vorlaufzeit ungeeignet: Kalender-Abo (Anlagezeit = Importzeit, nicht Buchungszeit) */
export const LEAD_EXCLUDED_SOURCES = ["extern"] as const;
/** Mindestzahl an Terminen, damit ein Slot in den Ranglisten „früh ausgebucht/kurzfristig“ erscheint */
export const MIN_SLOT_BOOKINGS = 3;
