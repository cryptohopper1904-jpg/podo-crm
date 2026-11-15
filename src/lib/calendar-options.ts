/**
 * Kalender – Anzeige-Optionen (je Person in users.prefs.calendar.options, per URL überschreibbar).
 * Reine Anzeige: Buchung, Verfügbarkeit und „Freien Termin finden“ hängen NICHT davon ab.
 */
import type { UserPrefs } from "@/db/schema";
import type { CalendarMode } from "./calendar-grid";

/** Wochenende: „auto“ = Sa immer, So nur wenn Termine; „alle“ = Sa + So; „keine“ = nur Mo–Fr */
export type WeekendMode = "auto" | "alle" | "keine";
export const WEEKEND_MODES: readonly WeekendMode[] = ["auto", "alle", "keine"];

export type CalendarOptions = {
  holidays: boolean;
  schoolHolidays: boolean;
  absences: boolean;
  /** Sperrzeiten (Pause, Schulung …) einzeichnen – nur Anzeige, die Verfügbarkeit bleibt gesperrt */
  blocks: boolean;
  /** abgesagte Termine anzeigen (für die aktuelle Ansicht aufgelöst) */
  cancelled: boolean;
  weekend: WeekendMode;
  workHours: boolean;
  weekNumbers: boolean;
  /** Zeitachse (volle Stunden); Termine außerhalb erweitern sie weiterhin */
  startHour: number;
  endHour: number;
  /** Hausbesuche anzeigen */
  homeVisits: boolean;
  /** ausgeblendete Behandler:innen (User-IDs) – Termine ohne Zuordnung bleiben immer sichtbar */
  hiddenTherapists: string[];
};

/** Gespeicherte Form (users.prefs.calendar.options) – nur abweichende Werte, abgesagte je Ansicht */
export type StoredCalendarOptions = NonNullable<NonNullable<UserPrefs["calendar"]>["options"]>;

export const TIME_BOUNDS = { minStart: 0, maxStart: 12, minEnd: 12, maxEnd: 24, minSpan: 4 } as const;

export function defaultCalendarOptions(mode: CalendarMode): CalendarOptions {
  return {
    holidays: true,
    schoolHolidays: false,
    absences: true,
    blocks: true,
    cancelled: mode === "simple",
    weekend: "auto",
    workHours: true,
    weekNumbers: true,
    startHour: 7,
    endHour: 20,
    homeVisits: true,
    hiddenTherapists: [],
  };
}

const BOOL_KEYS = ["holidays", "schoolHolidays", "absences", "blocks", "workHours", "weekNumbers", "cancelledSimple", "cancelledFull", "homeVisits"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** höchstens so viele ausgeblendete Behandler:innen merken (Schutz vor übergroßen Eingaben) */
export const MAX_HIDDEN_THERAPISTS = 50;
/** Liste von User-IDs prüfen: nur UUIDs, ohne Doppelte, begrenzt */
export function sanitizeIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()))].slice(0, MAX_HIDDEN_THERAPISTS);
}
const isHour = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 24;

/** Gespeicherte Optionen aus users.prefs prüfen (unbekannte/ungültige Felder fallen weg). */
export function sanitizeStoredOptions(v: unknown): StoredCalendarOptions {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: StoredCalendarOptions = {};
  for (const k of BOOL_KEYS) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  if (WEEKEND_MODES.includes(o.weekend as WeekendMode)) out.weekend = o.weekend as WeekendMode;
  if (isHour(o.startHour)) out.startHour = o.startHour;
  if (isHour(o.endHour)) out.endHour = o.endHour;
  const hidden = sanitizeIdList(o.hiddenTherapists);
  if (hidden.length) out.hiddenTherapists = hidden;
  return out;
}

/** URL-Parameter der Optionen (Kurzname → Bedeutung) */
export const OPTION_PARAMS = {
  feiertage: "holidays",
  ferien: "schoolHolidays",
  abwesend: "absences",
  sperr: "blocks",
  abgesagt: "cancelled",
  az: "workHours",
  kw: "weekNumbers",
  we: "weekend",
  von: "startHour",
  bis: "endHour",
  hb: "homeVisits",
} as const;
export type OptionParam = keyof typeof OPTION_PARAMS;

/** letzter Wert eines Such-Parameters (Formulare schicken bei Schaltern „0“ und ggf. „1“) */
const last = (v: string | string[] | undefined) => (Array.isArray(v) ? v[v.length - 1] : v);
const bool = (v: string | undefined) => (v === "1" ? true : v === "0" ? false : undefined);
const hour = (v: string | undefined) => (v !== undefined && /^\d{1,2}$/.test(v) && Number(v) <= 24 ? Number(v) : undefined);

/** Überschreibungen aus der URL (z. B. Support-Modus oder geteilte Links). `cancelled` gilt für die aktuelle Ansicht. */
export type UrlOverrides = Partial<CalendarOptions>;
export function parseOptionParams(sp: Record<string, string | string[] | undefined>): UrlOverrides {
  const out: UrlOverrides = {};
  const b = (p: OptionParam) => bool(last(sp[p]));
  const set = <K extends keyof CalendarOptions>(k: K, v: CalendarOptions[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("holidays", b("feiertage"));
  set("schoolHolidays", b("ferien"));
  set("absences", b("abwesend"));
  set("blocks", b("sperr"));
  set("cancelled", b("abgesagt"));
  set("workHours", b("az"));
  set("weekNumbers", b("kw"));
  set("homeVisits", b("hb"));
  const we = last(sp.we);
  set("weekend", WEEKEND_MODES.includes(we as WeekendMode) ? (we as WeekendMode) : undefined);
  set("startHour", hour(last(sp.von)));
  set("endHour", hour(last(sp.bis)));
  return out;
}

/** Zeitachse in sinnvollen Grenzen halten (Beginn 0–12 Uhr, Ende 12–24 Uhr, mindestens 4 Stunden). */
export function clampTimeAxis(startHour: number, endHour: number, fallback = { startHour: 7, endHour: 20 }) {
  let s = Number.isInteger(startHour) ? Math.min(TIME_BOUNDS.maxStart, Math.max(TIME_BOUNDS.minStart, startHour)) : fallback.startHour;
  const e = Number.isInteger(endHour) ? Math.min(TIME_BOUNDS.maxEnd, Math.max(TIME_BOUNDS.minEnd, endHour)) : fallback.endHour;
  if (e - s < TIME_BOUNDS.minSpan) s = Math.max(TIME_BOUNDS.minStart, e - TIME_BOUNDS.minSpan);
  return { startHour: s, endHour: e };
}

/** Wirksame Optionen: Standard (je Ansicht) ← gespeichert ← URL. */
export function resolveCalendarOptions(mode: CalendarMode, stored: StoredCalendarOptions, url: UrlOverrides = {}): CalendarOptions {
  const d = defaultCalendarOptions(mode);
  const { cancelledSimple, cancelledFull, ...rest } = stored;
  const storedCancelled = mode === "simple" ? cancelledSimple : cancelledFull;
  const merged: CalendarOptions = { ...d, ...rest, ...(storedCancelled !== undefined ? { cancelled: storedCancelled } : {}), ...url };
  return { ...merged, ...clampTimeAxis(merged.startHour, merged.endHour, d) };
}

/** Optionen → gespeicherte Form (nur Abweichungen vom Standard; `cancelled` je Ansicht). */
export function toStoredOptions(mode: CalendarMode, o: CalendarOptions, prev: StoredCalendarOptions = {}): StoredCalendarOptions {
  const d = defaultCalendarOptions(mode);
  const out: StoredCalendarOptions = {};
  // Abgesagte der jeweils anderen Ansicht bleiben erhalten
  const otherKey = mode === "simple" ? "cancelledFull" : "cancelledSimple";
  if (prev[otherKey] !== undefined) out[otherKey] = prev[otherKey];
  if (o.cancelled !== d.cancelled) out[mode === "simple" ? "cancelledSimple" : "cancelledFull"] = o.cancelled;
  for (const k of ["holidays", "schoolHolidays", "absences", "blocks", "workHours", "weekNumbers", "weekend", "homeVisits"] as const) {
    if (o[k] !== d[k]) (out as Record<string, unknown>)[k] = o[k];
  }
  const t = clampTimeAxis(o.startHour, o.endHour, d);
  if (t.startHour !== d.startHour) out.startHour = t.startHour;
  if (t.endHour !== d.endHour) out.endHour = t.endHour;
  const hidden = sanitizeIdList(o.hiddenTherapists);
  if (hidden.length) out.hiddenTherapists = hidden;
  return out;
}

/**
 * Anzeige-Filter (Behandler:innen, Hausbesuche) auf einen Termin anwenden – nur Darstellung. Termine ohne
 * Behandler:in bleiben immer sichtbar (sonst gingen Online-/Telefon-Buchungen ohne Zuordnung unter).
 */
export function passesDisplayFilter(o: Pick<CalendarOptions, "homeVisits" | "hiddenTherapists">, a: { therapistId?: string | null; homeVisit: boolean }): boolean {
  if (!o.homeVisits && a.homeVisit) return false;
  if (a.therapistId && o.hiddenTherapists.includes(a.therapistId.toLowerCase())) return false;
  return true;
}

/** Behandler:innen-Filter auf das aktuelle Team beschränken (gemerkte IDs ehemaliger bzw. praxisfremder Personen fallen weg). */
export function withTeamFilter<T extends Pick<CalendarOptions, "hiddenTherapists">>(o: T, teamIds: Iterable<string>): T {
  const team = new Set([...teamIds].map((id) => id.toLowerCase()));
  return { ...o, hiddenTherapists: o.hiddenTherapists.filter((id) => team.has(id)) };
}

/**
 * Hinweis „x Termine ausgeblendet“: Anzahl der durch den Anzeige-Filter ausgeblendeten Termine – abgesagte zählen
 * nie mit (gleiche Zählung in einfacher und vollständiger Ansicht) – und die aktiven Filter als Text.
 */
export function displayFilterSummary(
  o: Pick<CalendarOptions, "homeVisits" | "hiddenTherapists">,
  rows: readonly { status: string; therapistId?: string | null; homeVisit: boolean }[],
): { hidden: number; reasons: string } {
  const hidden = rows.filter((a) => a.status !== "cancelled" && !passesDisplayFilter(o, a)).length;
  const reasons = [o.hiddenTherapists.length ? "Behandler:innen" : null, o.homeVisits ? null : "Hausbesuche"].filter(Boolean).join(", ");
  return { hidden, reasons };
}

/** URL-Parameter der Optionen, die in der aktuellen URL gesetzt sind – für Links innerhalb des Kalenders („&feiertage=0…“). */
export function keepOptionParams(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(OPTION_PARAMS) as OptionParam[]) {
    const v = last(sp[k]);
    if (v !== undefined && /^[a-z0-9]{1,5}$/.test(v)) p.set(k, v);
  }
  return p.size ? `&${p}` : "";
}

/**
 * Welche Tage einer Woche (Mo–So, 7 ISO-Daten) angezeigt werden.
 * `hasEntries(iso)`: Termine an diesem Tag; der heutige Tag wird bei „auto“ immer gezeigt.
 */
export function visibleWeekDays(dates: readonly string[], weekend: WeekendMode, hasEntries: (iso: string) => boolean, today?: string): string[] {
  return dates.filter((iso) => {
    const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) return true;
    if (weekend === "alle") return true;
    if (weekend === "keine") return false;
    return wd === 6 || hasEntries(iso) || iso === today;
  });
}

/** Kalenderwoche nach ISO 8601 */
export function isoWeek(iso: string): number {
  const d = new Date(`${iso}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd + 3); // Donnerstag dieser Woche
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400_000));
}
