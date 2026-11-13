/**
 * Kalender-Sperrzeiten (rein, ohne DB): Pausen, Schulungen, früher Feierabend, Wartung, Reinigung …
 * je Person oder für die ganze Praxis (userId null). Eine zentrale Expansion (expandBlocks) liefert die
 * Vorkommen in Berliner Ortszeit; Verfügbarkeit (computeAvailability), freie Zeiten, Online-/Portal-Buchung,
 * KI-Telefon, Konfliktprüfung und Kalenderanzeige nutzen dieselben Vorkommen.
 * Zeiten sind Wanduhrzeiten (Europe/Berlin): „12:00–12:30“ bleibt auch nach der Zeitumstellung 12:00–12:30,
 * die Umrechnung in UTC (occurrenceUtc) berücksichtigt die Sommerzeit des jeweiligen Tages.
 */
import { z } from "zod";
import { addDaysIso, mondayOfIso, toHhmm } from "./calendar-grid";
import { berlinToUtc } from "./format";

export const BLOCK_KINDS = ["pause", "schulung", "feierabend", "wartung", "reinigung", "sonstiges"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  pause: "Pause",
  schulung: "Schulung",
  feierabend: "Früher Feierabend",
  wartung: "Wartung",
  reinigung: "Reinigung",
  sonstiges: "Sonstiges",
};

export const BLOCK_REPEATS = ["none", "daily", "weekly"] as const;
export type BlockRepeat = (typeof BLOCK_REPEATS)[number];
export const BLOCK_REPEAT_LABELS: Record<BlockRepeat, string> = {
  none: "einmalig",
  daily: "täglich (Mo–Fr)",
  weekly: "wöchentlich",
};

/** Gespeicherte Regel (Zeile aus calendar_blocks, nur die für die Expansion nötigen Felder) */
export type BlockRule = {
  id: string;
  userId: string | null;
  kind: string;
  title: string | null;
  startsOn: string;
  endsOn: string | null;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  repeat: string;
  weekdays: number[];
  intervalWeeks: number;
  exceptions: string[];
};

/** Ein Vorkommen an einem Tag (Minuten ab Mitternacht, Berliner Ortszeit; endMin bis 1440) */
export type BlockOccurrence = {
  blockId: string;
  userId: string | null;
  dateIso: string;
  startMin: number;
  endMin: number;
  allDay: boolean;
  kind: string;
  label: string;
  /** gehört zu einer Serie (Wiederholung) */
  series: boolean;
};

const DAY_MIN = 24 * 60;
const hhmmToMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const wdOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

export const blockLabel = (b: { kind: string; title: string | null }) =>
  b.title?.trim() || BLOCK_KIND_LABELS[b.kind as BlockKind] || "Sperrzeit";

/** Findet an `dateIso` ein Vorkommen der Regel statt? (Beginn/Ende, Ausnahmen, Wochentage, Wochenabstand) */
export function occursOn(rule: Pick<BlockRule, "startsOn" | "endsOn" | "repeat" | "weekdays" | "intervalWeeks" | "exceptions">, dateIso: string): boolean {
  if (dateIso < rule.startsOn) return false;
  if (rule.endsOn && dateIso > rule.endsOn) return false;
  if (rule.exceptions.includes(dateIso)) return false;
  if (rule.repeat === "none") return dateIso === rule.startsOn;
  const wd = wdOf(dateIso);
  if (rule.repeat === "daily") return wd <= 5;
  if (rule.repeat === "weekly") {
    if (!rule.weekdays.includes(wd)) return false;
    const n = Math.max(1, Math.floor(rule.intervalWeeks || 1));
    const weeks = Math.floor(daysBetween(mondayOfIso(rule.startsOn), mondayOfIso(dateIso)) / 7);
    return weeks % n === 0;
  }
  return false;
}

/** Zeitfenster eines Vorkommens in Minuten (ganztägig = 0–1440); null bei ungültigen Zeiten */
function minutesOf(rule: Pick<BlockRule, "allDay" | "startTime" | "endTime">): { startMin: number; endMin: number } | null {
  if (rule.allDay) return { startMin: 0, endMin: DAY_MIN };
  if (!rule.startTime || !rule.endTime) return null;
  const s = hhmmToMin(rule.startTime);
  const e = rule.endTime === "24:00" ? DAY_MIN : hhmmToMin(rule.endTime);
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? { startMin: s, endMin: e } : null;
}

/** Höchstens so viele Tage auf einmal expandieren (Schutz vor sehr großen Zeiträumen) */
export const MAX_EXPAND_DAYS = 400;

/**
 * Zentrale Expansion: alle Vorkommen der Regeln zwischen `fromIso` und `toIso` (inklusive), sortiert nach
 * Datum und Beginn. Optional nur für bestimmte Personen (Regeln der ganzen Praxis gelten immer).
 */
export function expandBlocks(rules: readonly BlockRule[], fromIso: string, toIso: string, userIds?: readonly string[]): BlockOccurrence[] {
  const out: BlockOccurrence[] = [];
  const span = Math.min(MAX_EXPAND_DAYS, daysBetween(fromIso, toIso) + 1);
  const relevant = rules.filter((r) => r.userId === null || !userIds || userIds.includes(r.userId));
  for (const r of relevant) {
    const mins = minutesOf(r);
    if (!mins) continue;
    const first = r.startsOn > fromIso ? r.startsOn : fromIso;
    const lastBound = r.endsOn && r.endsOn < toIso ? r.endsOn : toIso;
    const offset = daysBetween(fromIso, first);
    for (let i = offset; i < span; i++) {
      const d = addDaysIso(fromIso, i);
      if (d > lastBound) break;
      if (!occursOn(r, d)) continue;
      out.push({ blockId: r.id, userId: r.userId, dateIso: d, ...mins, allDay: r.allDay, kind: r.kind, label: blockLabel(r), series: r.repeat !== "none" });
      if (r.repeat === "none") break;
    }
  }
  return out.sort((a, b) => a.dateIso.localeCompare(b.dateIso) || a.startMin - b.startMin || a.endMin - b.endMin);
}

/** Vorkommen, die eine Person an einem Tag betreffen (eigene + ganze Praxis) */
export function blocksFor(occ: readonly BlockOccurrence[], userId: string | null, dateIso: string): BlockOccurrence[] {
  return occ.filter((o) => o.dateIso === dateIso && (o.userId === null || o.userId === userId));
}

/** Vorkommen als UTC-Zeitraum (Sommerzeit des jeweiligen Tages; Ende 24:00 = Mitternacht des Folgetags) */
export function occurrenceUtc(o: Pick<BlockOccurrence, "dateIso" | "startMin" | "endMin">): { start: Date; end: Date } {
  const start = berlinToUtc(o.dateIso, toHhmm(o.startMin));
  const end = o.endMin >= DAY_MIN ? berlinToUtc(addDaysIso(o.dateIso, 1), "00:00") : berlinToUtc(o.dateIso, toHhmm(o.endMin));
  return { start, end };
}

/** Vorkommen (der Person bzw. der ganzen Praxis), die sich mit [start, end) überschneiden */
export function overlappingBlocks(occ: readonly BlockOccurrence[], userId: string | null, start: Date, end: Date): BlockOccurrence[] {
  return occ.filter((o) => {
    if (o.userId !== null && o.userId !== userId) return false;
    const u = occurrenceUtc(o);
    return u.start < end && u.end > start;
  });
}

/** „12:00–12:30“ bzw. „ganztägig“ */
export function blockTime(o: Pick<BlockOccurrence, "allDay" | "startMin" | "endMin">): string {
  return o.allDay ? "ganztägig" : `${toHhmm(o.startMin)}–${o.endMin >= DAY_MIN ? "24:00" : toHhmm(o.endMin)}`;
}

/** „Pause 12:00–12:30“ bzw. „Wartung (ganztägig)“ */
export function describeBlock(o: Pick<BlockOccurrence, "label" | "allDay" | "startMin" | "endMin">): string {
  return o.allDay ? `${o.label} (ganztägig)` : `${o.label} ${blockTime(o)}`;
}

/** Text für Konfliktmeldungen, z. B. „Pause 12:00–12:30 (05.05.)“ – gleiche Vorkommen nur einmal */
export function describeBlockConflicts(occ: readonly BlockOccurrence[], withDate = true): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const o of occ) {
    const k = `${o.blockId}|${o.dateIso}`;
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(`${describeBlock(o)}${withDate ? ` (${o.dateIso.slice(8, 10)}.${o.dateIso.slice(5, 7)}.)` : ""}`);
  }
  return parts.join(", ");
}

/** Wiederholung lesbar: „wöchentlich Mo, Mi · alle 2 Wochen · bis 31.12.2026“ */
const WD = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
export function describeRepeat(r: Pick<BlockRule, "repeat" | "weekdays" | "intervalWeeks" | "endsOn">): string {
  if (r.repeat === "none") return "einmalig";
  const base =
    r.repeat === "daily"
      ? "täglich (Mo–Fr)"
      : `${r.intervalWeeks > 1 ? `alle ${r.intervalWeeks} Wochen` : "wöchentlich"} ${[...r.weekdays].sort((a, b) => a - b).map((d) => WD[d - 1]).join(", ")}`;
  return r.endsOn ? `${base} · bis ${r.endsOn.slice(8, 10)}.${r.endsOn.slice(5, 7)}.${r.endsOn.slice(0, 4)}` : base;
}

// ───────────── Eingabe prüfen (Formular → Regel) ─────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum ungültig").refine((v) => !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().startsWith(v), "Datum ungültig");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Uhrzeit ungültig");
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const blockInput = z
  .object({
    /** null = ganze Praxis */
    userId: z.string().uuid("Person wählen").nullable(),
    kind: z.enum(BLOCK_KINDS, { message: "Art wählen" }),
    title: z.preprocess(emptyToNull, z.string().trim().max(120, "Titel höchstens 120 Zeichen").nullable()),
    startsOn: isoDate,
    endsOn: z.preprocess(emptyToNull, isoDate.nullable()),
    allDay: z.boolean(),
    startTime: z.preprocess(emptyToNull, hhmm.nullable()),
    endTime: z.preprocess(emptyToNull, z.union([hhmm, z.literal("24:00")]).nullable()),
    repeat: z.enum(BLOCK_REPEATS),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7),
    intervalWeeks: z.number().int().min(1, "Abstand 1–12 Wochen").max(12, "Abstand 1–12 Wochen"),
    note: z.preprocess(emptyToNull, z.string().trim().max(1000, "Notiz höchstens 1000 Zeichen").nullable()),
  })
  .superRefine((d, ctx) => {
    if (d.startsOn < "2000-01-01" || d.startsOn > "2100-12-31") ctx.addIssue({ code: "custom", message: "Datum ungültig.", path: ["startsOn"] });
    if (d.endsOn && d.endsOn < d.startsOn) ctx.addIssue({ code: "custom", message: "Enddatum liegt vor dem Beginn.", path: ["endsOn"] });
    if (!d.allDay) {
      if (!d.startTime || !d.endTime) ctx.addIssue({ code: "custom", message: "Bitte Beginn und Ende angeben (oder „ganztägig“).", path: ["startTime"] });
      else if (d.endTime <= d.startTime) ctx.addIssue({ code: "custom", message: "Ende muss nach dem Beginn liegen.", path: ["endTime"] });
    }
    if (d.repeat === "weekly" && d.weekdays.length === 0) ctx.addIssue({ code: "custom", message: "Bitte mindestens einen Wochentag wählen.", path: ["weekdays"] });
  })
  .transform((d) => ({
    ...d,
    startTime: d.allDay ? null : d.startTime,
    // Zeitfelder im Browser kennen kein 24:00 – Ende 23:59 gilt als Tagesende (24:00, z. B. „früher Feierabend ab 15:00“)
    endTime: d.allDay ? null : d.endTime === "23:59" ? "24:00" : d.endTime,
    endsOn: d.repeat === "none" ? null : d.endsOn,
    weekdays: d.repeat === "weekly" ? [...new Set(d.weekdays)].sort((a, b) => a - b) : [],
    intervalWeeks: d.repeat === "weekly" ? d.intervalWeeks : 1,
  }));
export type BlockInput = z.output<typeof blockInput>;
