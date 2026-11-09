/**
 * Kleiner, robuster iCalendar-Leser (RFC 5545) für das Kalender-Abo (Import z. B. aus Google Kalender,
 * Docal.io oder CalMedi). Bewusst ohne Abhängigkeiten.
 *
 * Unterstützt: Zeilenfaltung, Parameter (auch in Anführungszeichen), Text-Escaping, VEVENT mit UID,
 * DTSTART/DTEND/DURATION (UTC „Z“, TZID inkl. Europe/Berlin und Windows-Zonennamen, ganztägig, „floating“
 * = Europe/Berlin), SUMMARY, DESCRIPTION, LOCATION, STATUS, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY mit
 * INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH), EXDATE und RECURRENCE-ID (geänderte Einzeltermine).
 * Nicht unterstützte Regeln (z. B. BYSETPOS, stündlich) werden übersprungen und gezählt.
 *
 * Ergebnis: nur Vorkommen, die das Zeitfenster [from, to) berühren.
 */

export type IcsStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";

export interface ParsedIcsEvent {
  uid: string;
  /** Schlüssel des Vorkommens bei Serien (ISO-Zeitpunkt bzw. YYYY-MM-DD), sonst null */
  recurrenceKey: string | null;
  start: Date;
  end: Date;
  allDay: boolean;
  summary: string;
  description: string | null;
  location: string | null;
  status: IcsStatus;
}

export interface IcsWarnings {
  /** Serien mit nicht unterstützter Regel (übersprungen) */
  rruleSkipped: number;
  /** VEVENTs ohne UID/DTSTART oder mit unlesbarem Datum */
  invalid: number;
  /** unbekannte TZID → als Europe/Berlin gelesen */
  unknownTz: number;
  /** Vorkommen jenseits der Obergrenzen (abgeschnitten) */
  truncated: number;
}

export interface IcsParseResult {
  calendarName: string | null;
  events: ParsedIcsEvent[];
  warnings: IcsWarnings;
}

export const ICS_LIMITS = { maxEvents: 5000, maxInstancesPerSeries: 1000, maxSeriesDays: 366 * 100 } as const;

const DEFAULT_TZ = "Europe/Berlin";

/** Häufige Windows-/Outlook-Zonennamen → IANA */
const WINDOWS_TZ: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
};

// ───────────── Zeilen und Eigenschaften ─────────────

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unfold(text: string): string[] {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Prop | null {
  // Name und Parameter bis zum ersten Doppelpunkt außerhalb von Anführungszeichen
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let cur = "";
  inQuote = false;
  for (const c of head) {
    if (c === '"') inQuote = !inQuote;
    if (c === ";" && !inQuote) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ───────────── Zeitzonen ─────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset der Zone zum Zeitpunkt `utcMs` in Millisekunden. */
function tzOffsetMs(utcMs: number, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Lokale Wandzeit in `tz` → UTC. Nicht existierende Zeiten (Sommerzeit-Lücke) werden nach vorn verschoben. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === "UTC") return new Date(local);
  const off1 = tzOffsetMs(local - tzOffsetMs(local, tz), tz);
  let t = local - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = local - off2;
  return new Date(t);
}

/** UTC-Zeitpunkt → lokale Kalenderdaten in `tz`. */
function utcToZoned(date: Date, tz: string): LocalDateTime {
  const off = tzOffsetMs(date.getTime(), tz);
  const l = new Date(date.getTime() + off);
  return { y: l.getUTCFullYear(), mo: l.getUTCMonth() + 1, d: l.getUTCDate(), h: l.getUTCHours(), mi: l.getUTCMinutes(), s: l.getUTCSeconds() };
}

// ───────────── Datum/Zeit-Werte ─────────────

interface LocalDateTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

interface IcsTime {
  local: LocalDateTime;
  /** IANA-Zone („UTC“ bei …Z) */
  tz: string;
  allDay: boolean;
  utc: Date;
}

function resolveTz(tzid: string | undefined, warnings: IcsWarnings, calTz: string): string {
  if (!tzid) return calTz;
  const clean = tzid.replace(/^\/+/, "").trim();
  if (WINDOWS_TZ[clean]) return WINDOWS_TZ[clean];
  if (isValidTimeZone(clean)) return clean;
  // z. B. „/mozilla.org/20050126_1/Europe/Berlin“
  const m = clean.match(/([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/);
  if (m && isValidTimeZone(m[1])) return m[1];
  warnings.unknownTz++;
  return DEFAULT_TZ;
}

function parseTimeValue(raw: string, params: Record<string, string>, warnings: IcsWarnings, calTz: string): IcsTime | null {
  const v = raw.trim();
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || params.VALUE === "DATE") {
    const m = dateOnly ?? v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const local = { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
    if (!validLocal(local)) return null;
    return { local, tz: DEFAULT_TZ, allDay: true, utc: zonedToUtc(local.y, local.mo, local.d, 0, 0, 0, DEFAULT_TZ) };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!m) return null;
  const local = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0 };
  if (!validLocal(local)) return null;
  const tz = m[7] ? "UTC" : resolveTz(params.TZID, warnings, calTz);
  return { local, tz, allDay: false, utc: zonedToUtc(local.y, local.mo, local.d, local.h, local.mi, local.s, tz) };
}

function validLocal(l: LocalDateTime): boolean {
  if (l.mo < 1 || l.mo > 12 || l.d < 1 || l.d > 31 || l.h > 23 || l.mi > 59 || l.s > 60) return false;
  const t = new Date(Date.UTC(l.y, l.mo - 1, l.d));
  return t.getUTCMonth() === l.mo - 1;
}

/** ISO-8601-Dauer (P1D, PT1H30M, -PT15M) → Millisekunden; null bei ungültig. */
export function parseDuration(raw: string): number | null {
  const m = raw.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || raw.trim().length < 3) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ───────────── Wiederholungen ─────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: { utc: Date; dateOnly: string | null } | null;
  byDay: { n: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
  wkst: number;
}

function parseRRule(raw: string, warnings: IcsWarnings, calTz: string): RRule | null {
  const parts = Object.fromEntries(
    raw
      .split(";")
      .map((p) => p.split("="))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k.trim().toUpperCase(), v.trim().toUpperCase()]),
  );
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const supported = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);
  if (Object.keys(parts).some((k) => !supported.has(k))) return null;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return null;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until: RRule["until"] = null;
  if (parts.UNTIL) {
    const t = parseTimeValue(parts.UNTIL, {}, warnings, calTz);
    if (!t) return null;
    until = { utc: t.utc, dateOnly: t.allDay ? isoDate(t.local) : null };
  }
  const byDay: RRule["byDay"] = [];
  for (const x of (parts.BYDAY ?? "").split(",").filter(Boolean)) {
    const m = x.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!m) return null;
    byDay.push({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) });
  }
  const nums = (s: string | undefined, min: number, max: number) => {
    const out: number[] = [];
    for (const x of (s ?? "").split(",").filter(Boolean)) {
      const n = Number(x);
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > max || (n > 0 && n < min)) return null;
      out.push(n);
    }
    return out;
  };
  const byMonthDay = nums(parts.BYMONTHDAY, 1, 31);
  const byMonth = nums(parts.BYMONTH, 1, 12);
  if (!byMonthDay || !byMonth || byMonth.some((m) => m < 0)) return null;
  // Ordinalzahlen bei BYDAY nur monatlich sinnvoll unterstützt
  if (byDay.some((b) => b.n !== 0) && freq !== "MONTHLY") return null;
  if (freq === "YEARLY" && byDay.length) return null;
  const wkst = parts.WKST ? WEEKDAYS.indexOf(parts.WKST) : 1;
  if (wkst < 0) return null;
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst };
}

const isoDate = (l: { y: number; mo: number; d: number }) => `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
const dayNumber = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86400_000);
const fromDayNumber = (n: number) => {
  const t = new Date(n * 86400_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
};
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function matchesDay(rule: RRule, start: { y: number; mo: number; d: number; wd: number; dn: number }, c: { y: number; mo: number; d: number; wd: number; dn: number }): boolean {
  if (rule.byMonth.length && !rule.byMonth.includes(c.mo)) return false;
  const dim = daysInMonth(c.y, c.mo);
  const monthDayOk = (list: number[]) => list.some((n) => (n > 0 ? n === c.d : dim + n + 1 === c.d));
  switch (rule.freq) {
    case "DAILY":
      if ((c.dn - start.dn) % rule.interval !== 0) return false;
      if (rule.byDay.length && !rule.byDay.some((b) => b.wd === c.wd)) return false;
      if (rule.byMonthDay.length && !monthDayOk(rule.byMonthDay)) return false;
      return true;
    case "WEEKLY": {
      const weekStart = (dn: number, wd: number) => dn - ((wd - rule.wkst + 7) % 7);
      const weeks = Math.round((weekStart(c.dn, c.wd) - weekStart(start.dn, start.wd)) / 7);
      if (weeks % rule.interval !== 0) return false;
      const days = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [start.wd];
      return days.includes(c.wd);
    }
    case "MONTHLY": {
      const months = (c.y - start.y) * 12 + (c.mo - start.mo);
      if (months % rule.interval !== 0) return false;
      if (rule.byMonthDay.length) {
        if (!monthDayOk(rule.byMonthDay)) return false;
        return rule.byDay.length ? rule.byDay.some((b) => b.wd === c.wd) : true;
      }
      if (rule.byDay.length) {
        return rule.byDay.some((b) => {
          if (b.wd !== c.wd) return false;
          if (b.n === 0) return true;
          const nth = Math.floor((c.d - 1) / 7) + 1;
          const nthFromEnd = Math.floor((dim - c.d) / 7) + 1;
          return b.n > 0 ? nth === b.n : nthFromEnd === -b.n;
        });
      }
      return c.d === start.d;
    }
    case "YEARLY": {
      if ((c.y - start.y) % rule.interval !== 0) return false;
      const months = rule.byMonth.length ? rule.byMonth : [start.mo];
      if (!months.includes(c.mo)) return false;
      return rule.byMonthDay.length ? monthDayOk(rule.byMonthDay) : c.d === start.d;
    }
  }
}

/**
 * Erzeugt die Startzeitpunkte einer Serie (in lokaler Wandzeit der DTSTART-Zone, damit Sommer-/Winterzeit
 * stimmt) bis `toUtc`. COUNT zählt ab DTSTART (wie RFC 5545, EXDATE erst danach abgezogen).
 */
function expand(rule: RRule, dtstart: IcsTime, toUtc: Date): IcsTime[] {
  const s = dtstart.local;
  const startDn = dayNumber(s.y, s.mo, s.d);
  const startInfo = { ...fromDayNumber(startDn), dn: startDn };
  const out: IcsTime[] = [];
  let n = 0;
  for (let dn = startDn; dn - startDn <= ICS_LIMITS.maxSeriesDays; dn++) {
    const c = { ...fromDayNumber(dn), dn };
    if (!matchesDay(rule, startInfo, c)) continue;
    const local = { y: c.y, mo: c.mo, d: c.d, h: s.h, mi: s.mi, s: s.s };
    const utc = dtstart.allDay ? zonedToUtc(c.y, c.mo, c.d, 0, 0, 0, DEFAULT_TZ) : zonedToUtc(c.y, c.mo, c.d, s.h, s.mi, s.s, dtstart.tz);
    if (rule.until) {
      if (rule.until.dateOnly ? isoDate(c) > rule.until.dateOnly : utc.getTime() > rule.until.utc.getTime()) break;
    }
    if (utc.getTime() >= toUtc.getTime()) break;
    n++;
    out.push({ local, tz: dtstart.tz, allDay: dtstart.allDay, utc });
    if (rule.count !== null && n >= rule.count) break;
  }
  return out;
}

/** Schlüssel eines Vorkommens: ganztägig „YYYY-MM-DD“, sonst ISO-Zeitpunkt in UTC (ohne Millisekunden). */
export function occurrenceKey(t: { allDay: boolean; local: { y: number; mo: number; d: number }; utc: Date }): string {
  return t.allDay ? isoDate(t.local) : t.utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ───────────── VEVENT ─────────────

interface RawEvent {
  props: Prop[];
}

function first(e: RawEvent, name: string): Prop | undefined {
  return e.props.find((p) => p.name === name);
}

function textOf(e: RawEvent, name: string, max: number): string | null {
  const p = first(e, name);
  if (!p) return null;
  const v = unescapeText(p.value).replace(/\u0000/g, "").trim();
  return v ? v.slice(0, max) : null;
}

function statusOf(e: RawEvent): IcsStatus {
  const v = first(e, "STATUS")?.value.trim().toUpperCase();
  return v === "CANCELLED" || v === "TENTATIVE" ? v : "CONFIRMED";
}

/**
 * Liest eine ICS-Datei und liefert alle Termine bzw. Serien-Vorkommen, die das Fenster [from, to) berühren.
 */
export function parseIcs(text: string, window: { from: Date; to: Date }): IcsParseResult {
  const warnings: IcsWarnings = { rruleSkipped: 0, invalid: 0, unknownTz: 0, truncated: 0 };
  const lines = unfold(text);
  const raw: RawEvent[] = [];
  let calendarName: string | null = null;
  let calTz = DEFAULT_TZ;
  let depth: string[] = [];
  let cur: RawEvent | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const what = p.value.trim().toUpperCase();
      depth.push(what);
      if (what === "VEVENT" && depth.length === 2 && depth[0] === "VCALENDAR") cur = { props: [] };
      continue;
    }
    if (p.name === "END") {
      const what = p.value.trim().toUpperCase();
      const idx = depth.lastIndexOf(what);
      if (idx >= 0) depth = depth.slice(0, idx);
      if (what === "VEVENT" && cur) {
        raw.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && depth.length === 2 && depth[1] === "VEVENT") cur.props.push(p);
    else if (depth.length === 1 && depth[0] === "VCALENDAR") {
      if (p.name === "X-WR-CALNAME") calendarName = unescapeText(p.value).trim().slice(0, 200) || null;
      if (p.name === "X-WR-TIMEZONE" && isValidTimeZone(p.value.trim())) calTz = p.value.trim();
    }
  }

  type Inst = ParsedIcsEvent;
  const masters = new Map<string, Inst[]>();
  const overrides = new Map<string, Map<string, Inst | null>>();
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();

  for (const e of raw) {
    const uid = first(e, "UID")?.value.trim().slice(0, 500);
    const dtstartProp = first(e, "DTSTART");
    if (!uid || !dtstartProp) {
      warnings.invalid++;
      continue;
    }
    const start = parseTimeValue(dtstartProp.value, dtstartProp.params, warnings, calTz);
    if (!start) {
      warnings.invalid++;
      continue;
    }
    let durationMs: number;
    const dtendProp = first(e, "DTEND");
    const durProp = first(e, "DURATION");
    if (dtendProp) {
      const end = parseTimeValue(dtendProp.value, dtendProp.params, warnings, calTz);
      if (!end) {
        warnings.invalid++;
        continue;
      }
      durationMs = end.utc.getTime() - start.utc.getTime();
    } else if (durProp) {
      durationMs = parseDuration(durProp.value) ?? 0;
    } else {
      durationMs = start.allDay ? 86400_000 : 0;
    }
    if (durationMs < 0) durationMs = 0;
    // ganztägig: Anzahl Kalendertage (DST-fest)
    const allDayDays = start.allDay ? Math.max(1, Math.round(durationMs / 86400_000)) : 0;
    const base = {
      uid,
      allDay: start.allDay,
      summary: textOf(e, "SUMMARY", 300) ?? "(ohne Titel)",
      description: textOf(e, "DESCRIPTION", 4000),
      location: textOf(e, "LOCATION", 500),
      status: statusOf(e),
    };
    const make = (t: IcsTime, key: string | null): Inst => {
      const end = t.allDay
        ? zonedToUtc(t.local.y, t.local.mo, t.local.d + allDayDays, 0, 0, 0, DEFAULT_TZ)
        : new Date(t.utc.getTime() + durationMs);
      return { ...base, recurrenceKey: key, start: t.utc, end };
    };

    const ridProp = first(e, "RECURRENCE-ID");
    if (ridProp) {
      const rid = parseTimeValue(ridProp.value, ridProp.params, warnings, calTz);
      if (!rid) {
        warnings.invalid++;
        continue;
      }
      const key = occurrenceKey(rid);
      if (!overrides.has(uid)) overrides.set(uid, new Map());
      overrides.get(uid)!.set(key, make(start, key));
      continue;
    }

    const rruleProp = first(e, "RRULE");
    if (!rruleProp) {
      masters.set(uid, [make(start, null)]);
      continue;
    }
    const rule = parseRRule(rruleProp.value, warnings, calTz);
    if (!rule) {
      warnings.rruleSkipped++;
      continue;
    }
    const exdates = new Set<string>();
    for (const ex of e.props.filter((p) => p.name === "EXDATE")) {
      for (const v of ex.value.split(",")) {
        const t = parseTimeValue(v, ex.params, warnings, calTz);
        if (t) {
          exdates.add(occurrenceKey(t));
          // EXDATE ganztägig bei zeitgebundener Serie: ganzen Tag ausschließen
          if (t.allDay) exdates.add(`day:${isoDate(t.local)}`);
        }
      }
    }
    const span = start.allDay ? allDayDays * 86400_000 : durationMs;
    const list = expand(rule, start, window.to)
      .filter((t) => !exdates.has(occurrenceKey(t)) && !exdates.has(`day:${isoDate(t.local)}`))
      .filter((t) => t.utc.getTime() + span > fromMs);
    if (list.length > ICS_LIMITS.maxInstancesPerSeries) warnings.truncated++;
    masters.set(
      uid,
      list.slice(0, ICS_LIMITS.maxInstancesPerSeries).map((t) => make(t, occurrenceKey(t))),
    );
  }

  const events: Inst[] = [];
  for (const [uid, list] of masters) {
    const ov = overrides.get(uid);
    for (const inst of list) {
      const o = inst.recurrenceKey && ov?.get(inst.recurrenceKey);
      if (o) {
        ov!.delete(inst.recurrenceKey!);
        events.push(o);
      } else events.push(inst);
    }
    // Überschreibungen von Vorkommen außerhalb der Expansion (z. B. in das Fenster verschoben)
    if (ov) for (const o of ov.values()) if (o) events.push(o);
    overrides.delete(uid);
  }
  // Überschreibungen ohne Serie (Google exportiert manchmal nur Einzeltermine): als eigene Termine
  for (const ov of overrides.values()) for (const o of ov.values()) if (o) events.push(o);

  const inWindow = events.filter((ev) => ev.start.getTime() < toMs && Math.max(ev.end.getTime(), ev.start.getTime() + 1) > fromMs);
  inWindow.sort((a, b) => a.start.getTime() - b.start.getTime());
  if (inWindow.length > ICS_LIMITS.maxEvents) warnings.truncated++;
  return { calendarName, events: inWindow.slice(0, ICS_LIMITS.maxEvents), warnings };
}

/** Stabiler Schlüssel je Vorkommen für die Zuordnung (UID + Vorkommen). */
export function eventKey(e: { uid: string; recurrenceKey: string | null }): string {
  return e.recurrenceKey ? `${e.uid}#${e.recurrenceKey}` : e.uid;
}

/** Lokale Kalenderdaten eines Zeitpunkts in Europe/Berlin (für Anzeige/Tests). */
export function berlinLocal(d: Date): LocalDateTime {
  return utcToZoned(d, DEFAULT_TZ);
}
