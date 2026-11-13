/**
 * Öffnungszeiten der Praxis je Wochentag – EINE Quelle der Wahrheit für Verfügbarkeits-Fallback (Kalender,
 * Online-Buchung, KI-Telefon, KI-Antwortvorschläge) und die Praxis-Website (sofern dort nicht abweichend gepflegt).
 * Rein (ohne DB/Request), auch im Browser nutzbar.
 *
 * Gespeichert in organizations.settings.practiceHours als Liste
 *   [{ weekday: 1 (Mo) … 7 (So), from: "08:00", to: "12:00" }, { weekday: 1, from: "13:00", to: "18:00" }, …]
 * Ein Tag ohne Eintrag ist geschlossen; mehrere Einträge je Tag = mehrere Zeitfenster (z. B. Mittagspause).
 *
 * Altdaten (vor Migration 0046): Website-Zeiten settings.openingHours bzw. settings.opening = { from, to } für Mo–Fr.
 * Ohne jede Angabe gilt intern Mo–Fr 08:00–18:00 (nur Verfügbarkeit, nie öffentlich angezeigt).
 * Gesetzliche Feiertage regelt weiterhin das Bundesland (src/lib/holidays.ts) – keine eigenen Ausnahmetage hier.
 */

/** Zeitfenster HH:MM–HH:MM (auch von src/lib/availability.ts genutzt) */
export type TimeRange = { start: string; end: string };

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WEEKDAY_NUMBERS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAY_LONG: Record<Weekday, string> = { 1: "Montag", 2: "Dienstag", 3: "Mittwoch", 4: "Donnerstag", 5: "Freitag", 6: "Samstag", 7: "Sonntag" };
export const WEEKDAY_SHORT: Record<Weekday, string> = { 1: "Mo", 2: "Di", 3: "Mi", 4: "Do", 5: "Fr", 6: "Sa", 7: "So" };

/** Zeitfenster je Wochentag (leer = geschlossen), je Tag sortiert und überschneidungsfrei */
export type WeekHours = Record<Weekday, TimeRange[]>;
/** Speicherform (wie settings.openingHours der Website) */
export type StoredOpeningHour = { weekday: number; from: string; to: string };

export const MAX_WINDOWS_PER_DAY = 4;
/** Zeiten im 5-Minuten-Raster */
export const GRID_MINUTES = 5;
export const DEFAULT_RANGE: TimeRange = { start: "08:00", end: "18:00" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const isWeekday = (n: unknown): n is Weekday => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 7;

export const emptyWeek = (): WeekHours => ({ 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] });

/** Gleiche Zeit an allen Werktagen Mo–Fr, Sa/So geschlossen (Form der Altdaten). */
export function weekdaysWeek(range: TimeRange): WeekHours {
  const w = emptyWeek();
  for (const d of [1, 2, 3, 4, 5] as const) w[d] = [{ ...range }];
  return w;
}

export const DEFAULT_WEEK: WeekHours = weekdaysWeek(DEFAULT_RANGE);

const toHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const LAST_MINUTE = 23 * 60 + 55;

/**
 * Altzeiten außerhalb des 5-Minuten-Rasters (z. B. 08:03) tolerant einrasten: „von“ nach unten, „bis“ nach oben
 * (höchstens 23:55) – so lässt sich alles ohne Fehlermeldung wieder speichern. Ungültiges bleibt ungültig.
 */
function snap(r: TimeRange): TimeRange {
  if (!HHMM.test(r.start) || !HHMM.test(r.end)) return r;
  const start = Math.floor(toMin(r.start) / GRID_MINUTES) * GRID_MINUTES;
  const end = Math.min(Math.ceil(toMin(r.end) / GRID_MINUTES) * GRID_MINUTES, LAST_MINUTE);
  return { start: toHhmm(start), end: toHhmm(end) };
}

/** Je Tag ins Raster einrasten, sortieren und überlappende/angrenzende Fenster verschmelzen; Ungültiges verwerfen. */
function normalizeDay(ranges: TimeRange[]): TimeRange[] {
  const valid = ranges
    .filter((r) => HHMM.test(r.start) && HHMM.test(r.end) && toMin(r.end) > toMin(r.start))
    .map(snap)
    .filter((r) => toMin(r.end) > toMin(r.start))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  const out: TimeRange[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && toMin(r.start) <= toMin(last.end)) {
      if (toMin(r.end) > toMin(last.end)) last.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

/** Gespeicherte Liste → Woche (tolerant: ungültige Einträge verworfen, Zeiten ins 5-Minuten-Raster eingerastet). */
export function weekFromList(raw: unknown): WeekHours {
  const w = emptyWeek();
  if (!Array.isArray(raw)) return w;
  for (const item of raw) {
    const h = (item ?? {}) as Partial<StoredOpeningHour>;
    if (!isWeekday(h.weekday) || typeof h.from !== "string" || typeof h.to !== "string") continue;
    w[h.weekday].push({ start: h.from, end: h.to });
  }
  for (const d of WEEKDAY_NUMBERS) w[d] = normalizeDay(w[d]);
  return w;
}

export function weekToList(week: WeekHours): StoredOpeningHour[] {
  return WEEKDAY_NUMBERS.flatMap((d) => week[d].map((r) => ({ weekday: d, from: r.start, to: r.end })));
}

/**
 * Von der Praxis gepflegte Öffnungszeiten – oder null, wenn es keine gibt (dann keine Zeiten öffentlich zeigen).
 * Rückwärtskompatibel (wie Migration 0046): ohne practiceHours gelten die bisherigen Website-Zeiten
 * (settings.openingHours, z. B. aus dem Bootstrap), sonst der alte Mo–Fr-Bereich settings.opening.
 */
export function storedPracticeHours(settings: Record<string, unknown> | null | undefined): WeekHours | null {
  if (Array.isArray(settings?.practiceHours)) return weekFromList(settings.practiceHours);
  const site = weekFromList(settings?.openingHours);
  if (!isClosedWeek(site)) return site;
  const o = settings?.opening;
  if (o && typeof o === "object") {
    const { from, to } = o as { from?: unknown; to?: unknown };
    const range = { start: typeof from === "string" ? from : DEFAULT_RANGE.start, end: typeof to === "string" ? to : DEFAULT_RANGE.end };
    const day = normalizeDay([range]);
    return day.length ? weekdaysWeek(day[0]) : emptyWeek();
  }
  return null;
}

/**
 * Öffnungszeiten für die Verfügbarkeit (intern): gepflegte Zeiten, ohne Angaben Mo–Fr 08:00–18:00.
 * Öffentlich (Website, Telefon-Ansage) stattdessen storedPracticeHours verwenden – keine erfundenen Zeiten.
 */
export function practiceHours(settings: Record<string, unknown> | null | undefined): WeekHours {
  return storedPracticeHours(settings) ?? weekdaysWeek(DEFAULT_RANGE);
}

/** Zeitfenster der Praxis an einem Wochentag (1 = Mo … 7 = So) */
export const hoursOnWeekday = (week: WeekHours, weekday: number): TimeRange[] => (isWeekday(weekday) ? week[weekday] : []);

export const isClosedWeek = (week: WeekHours) => WEEKDAY_NUMBERS.every((d) => week[d].length === 0);

export function sameWeek(a: WeekHours, b: WeekHours): boolean {
  return WEEKDAY_NUMBERS.every((d) => a[d].length === b[d].length && a[d].every((r, i) => r.start === b[d][i].start && r.end === b[d][i].end));
}

/**
 * Strenge Prüfung einer Eingabe (Formular → JSON-Liste): Uhrzeit HH:MM im 5-Minuten-Raster, „von“ vor „bis“,
 * höchstens MAX_WINDOWS_PER_DAY Fenster je Tag, keine Überschneidungen. Angrenzende Fenster (12:00–12:00) sind erlaubt.
 */
export function validateWeek(raw: unknown): { week: WeekHours; error?: undefined } | { week?: undefined; error: string } {
  if (!Array.isArray(raw)) return { error: "Öffnungszeiten konnten nicht gelesen werden." };
  if (raw.length > MAX_WINDOWS_PER_DAY * 7) return { error: `Höchstens ${MAX_WINDOWS_PER_DAY} Zeitfenster je Tag.` };
  const week = emptyWeek();
  for (const item of raw) {
    const h = (item ?? {}) as Partial<Record<keyof StoredOpeningHour, unknown>>;
    if (!isWeekday(h.weekday)) return { error: "Öffnungszeiten: ungültiger Wochentag." };
    const day = WEEKDAY_LONG[h.weekday];
    const from = typeof h.from === "string" ? h.from.trim() : "";
    const to = typeof h.to === "string" ? h.to.trim() : "";
    if (!HHMM.test(from) || !HHMM.test(to)) return { error: `${day}: bitte „von“ und „bis“ als Uhrzeit angeben (z. B. 08:00).` };
    if (toMin(from) % GRID_MINUTES || toMin(to) % GRID_MINUTES) return { error: `${day}: bitte Uhrzeiten im ${GRID_MINUTES}-Minuten-Raster angeben (z. B. 08:05, 12:30).` };
    if (toMin(to) <= toMin(from)) return { error: `${day}: „bis“ (${to}) muss nach „von“ (${from}) liegen.` };
    week[h.weekday].push({ start: from, end: to });
  }
  for (const d of WEEKDAY_NUMBERS) {
    const r = week[d].sort((a, b) => toMin(a.start) - toMin(b.start));
    if (r.length > MAX_WINDOWS_PER_DAY) return { error: `${WEEKDAY_LONG[d]}: höchstens ${MAX_WINDOWS_PER_DAY} Zeitfenster.` };
    for (let i = 1; i < r.length; i++) {
      if (toMin(r[i].start) < toMin(r[i - 1].end))
        return { error: `${WEEKDAY_LONG[d]}: ${r[i - 1].start}–${r[i - 1].end} und ${r[i].start}–${r[i].end} überschneiden sich.` };
    }
  }
  return { week };
}

/** Aufeinanderfolgende Tage mit gleichen Zeiten zusammenfassen (Mo–Fr …) */
export function groupWeek(week: WeekHours): { from: Weekday; to: Weekday; ranges: TimeRange[] }[] {
  const out: { from: Weekday; to: Weekday; ranges: TimeRange[] }[] = [];
  for (const d of WEEKDAY_NUMBERS) {
    const last = out[out.length - 1];
    const same = last && last.ranges.length === week[d].length && last.ranges.every((r, i) => r.start === week[d][i].start && r.end === week[d][i].end);
    if (same) last.to = d;
    else out.push({ from: d, to: d, ranges: week[d] });
  }
  return out;
}

const dayRangeLabel = (g: { from: Weekday; to: Weekday }, names: Record<Weekday, string>, joiner: string) =>
  g.from === g.to ? names[g.from] : g.to === g.from + 1 && joiner !== "–" ? `${names[g.from]} und ${names[g.to]}` : `${names[g.from]}${joiner}${names[g.to]}`;

/** Kurzform, z. B. „Mo–Fr 08:00–12:00, 13:00–18:00 · Sa 09:00–12:00 · So geschlossen“ */
export function weekSummary(week: WeekHours): string {
  if (isClosedWeek(week)) return "keine Öffnungszeiten hinterlegt";
  return groupWeek(week)
    .map((g) => `${dayRangeLabel(g, WEEKDAY_SHORT, "–")} ${g.ranges.length ? g.ranges.map((r) => `${r.start}–${r.end}`).join(", ") : "geschlossen"}`)
    .join(" · ");
}

/** Gesprochene Form für den KI-Telefonassistenten, z. B. „Montag bis Freitag 08:00 bis 12:00 Uhr und 13:00 bis 18:00 Uhr; Samstag und Sonntag geschlossen“ */
export function weekSpeech(week: WeekHours): string {
  if (isClosedWeek(week)) return "derzeit keine festen Öffnungszeiten hinterlegt";
  return groupWeek(week)
    .map((g) => `${dayRangeLabel(g, WEEKDAY_LONG, " bis ")} ${g.ranges.length ? g.ranges.map((r) => `${r.start} bis ${r.end} Uhr`).join(" und ") : "geschlossen"}`)
    .join("; ");
}

export const NO_HOURS_NOTE = "Noch keine Öffnungszeiten gespeichert – intern gelten Mo–Fr 8–18 Uhr";

/** Ansage für den KI-Telefonassistenten – ohne gepflegte Zeiten nichts erfinden (auch keinen Feiertagssatz). */
export function openingSpeech(settings: Record<string, unknown> | null | undefined): string {
  const stored = storedPracticeHours(settings);
  if (!stored || isClosedWeek(stored)) return "Feste Öffnungszeiten sind derzeit nicht hinterlegt.";
  return `${weekSpeech(stored)}; an gesetzlichen Feiertagen geschlossen`;
}

/** Kurzform für Einstellungs-/Telefonseite; null = keine Zeiten gepflegt (dann NO_HOURS_NOTE zeigen) */
export function openingSummary(settings: Record<string, unknown> | null | undefined): string | null {
  const stored = storedPracticeHours(settings);
  return stored ? weekSummary(stored) : null;
}
