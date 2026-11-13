import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Badge } from "@/components/ui";
import { absentOn, addDaysIso, berlinParts, dayInterval, gridRange, isBusy, layoutLanes, monthWeeks, outsideRanges, SLOT_MIN, toHhmm, type FullView } from "@/lib/calendar-grid";
import { isoWeek, visibleWeekDays, type CalendarOptions } from "@/lib/calendar-options";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { SCHOOL_HOLIDAYS_META, schoolHolidayOn, schoolHolidaysCovered } from "@/lib/school-holidays";
import type { listAppointments } from "@/server/appointments";
import type { calendarBoard } from "@/server/calendar-board";
import { BLOCK_HATCH, BlockOverlays, MonthBlockHints } from "./calendar-blocks-view";

type Row = Awaited<ReturnType<typeof listAppointments>>[number];
type Board = Awaited<ReturnType<typeof calendarBoard>>;
type Interval = { startMin: number; endMin: number };

/** 16 px je 15 Minuten (64 px je Stunde) */
const PX_PER_MIN = 16 / SLOT_MIN;
const px = (min: number) => `${Math.round(min * PX_PER_MIN)}px`;

const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dm = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
const fmtDe = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const wdIndex = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7;

const GRID_BG: CSSProperties = {
  // Stundenlinien kräftiger, Viertelstunden zart – beides aus den Farb-Tokens (hell/dunkel)
  backgroundImage:
    "repeating-linear-gradient(to bottom, var(--border-strong) 0 1px, transparent 1px 64px), repeating-linear-gradient(to bottom, color-mix(in srgb, var(--border) 85%, transparent) 0 1px, transparent 1px 16px)",
  backgroundBlendMode: "normal",
};
const HATCH: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--muted) 22%, transparent) 0 4px, transparent 4px 9px)",
};

const validColor = (c: string | null | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
const personName = (r: Row) => (r.patient ? [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" ") : r.a.title ?? "Termin");

export type FullCalendarProps = {
  view: FullView;
  day: string;
  today: string;
  now: Date;
  rows: Row[];
  board: Board;
  state: StateCode;
  overlaps: Set<string>;
  canWrite: boolean;
  /** Link innerhalb des Kalenders (Ansicht/Datum) */
  calHref: (p: { ansicht?: FullView; datum?: string }) => string;
  /** Anzeige-Optionen (nur Darstellung – Verfügbarkeit/Buchung bleiben unberührt) */
  options: CalendarOptions;
  /** Link „Wochenende einblenden“ (aktuelle Ansicht mit we=alle) */
  showWeekendHref: string;
};

/** Feiertag/Schulferien eines Tages laut Anzeige-Optionen */
const dayLabels = (iso: string, state: StateCode, o: CalendarOptions) => ({
  holiday: o.holidays ? holidayOn(iso, state) : null,
  school: o.schoolHolidays ? schoolHolidayOn(iso, state) : null,
});

type Column = {
  key: string;
  header: ReactNode;
  dateIso: string;
  therapistId: string | null;
  rows: Row[];
  /** belegte Zeiten (für „belegt – nicht verfügbar“); null = keine Prüfung in dieser Spalte */
  busy: Interval[] | null;
  absent: boolean;
  outside: Interval[];
  /** Hinweis für Tooltip (z. B. Feiertag – auch wenn die Feiertags-Anzeige aus ist) */
  note: string | null;
  today: boolean;
  /** Link für „Neuer Termin“ (Behandler:in-Spalte → vorbelegt) */
  withTherapist: string | null;
};

function newHref(dateIso: string, min: number | null, therapistId: string | null) {
  const p = new URLSearchParams({ datum: dateIso });
  if (min !== null) p.set("zeit", toHhmm(min));
  if (therapistId) p.set("behandler", therapistId);
  return `/kalender/neu?${p}`;
}

export function FullCalendar(props: FullCalendarProps) {
  const live = props.options.cancelled ? props.rows : props.rows.filter((r) => r.a.status !== "cancelled");
  const cancelled = props.rows.length - live.length;
  // Wochenende „nur Mo–Fr“: ausgeblendete Sa/So-Termine nicht stumm verschlucken
  const hiddenWeekend =
    props.view !== "tag" && props.options.weekend === "keine" ? live.filter((r) => wdIndex(berlinParts(r.a.startsAt).dateIso) >= 5).length : 0;
  const shownDates = props.view === "tag" ? [props.day] : props.view === "woche" ? Array.from({ length: 7 }, (_, i) => addDaysIso(props.day, i)) : monthWeeks(props.day).flat();
  const schoolUncovered = props.options.schoolHolidays && shownDates.some((d) => !schoolHolidaysCovered(d));
  return (
    <div className="flex flex-col gap-3">
      {props.overlaps.size ? (
        <p className="rounded-xl bg-accent-soft p-4 text-sm text-accent-soft-text">
          <strong>Überschneidung:</strong> {props.overlaps.size} Termine überschneiden sich mit Terminen aus dem Kalender-Abo (gleiche Behandler:in). Bitte in PodoHero oder in der Quelle (z. B. Doctolib) verlegen.
        </p>
      ) : null}
      {hiddenWeekend ? (
        <p className="rounded-xl bg-warn-soft px-4 py-2 text-sm text-warn-soft-text">
          {hiddenWeekend} Termin{hiddenWeekend === 1 ? "" : "e"} am Wochenende ausgeblendet (Anzeige „nur Mo–Fr“).{" "}
          <Link href={props.showWeekendHref} className="font-semibold underline">Wochenende einblenden</Link>
        </p>
      ) : null}
      {props.view === "monat" ? <MonthView {...props} rows={live} /> : <TimeGridView {...props} rows={live} />}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {props.canWrite ? <span>Freie Zeit anklicken = neuer Termin oder Sperrzeit</span> : null}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-border" style={HATCH} aria-hidden /> belegt/abwesend – nicht verfügbar</span>
        {props.options.workHours ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-border bg-surface-2" aria-hidden /> außerhalb der Arbeitszeit</span> : null}
        {props.options.blocks ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-dashed border-border-strong bg-surface-2" style={BLOCK_HATCH} aria-hidden /> Sperrzeit (Pause, Schulung …) – nicht verfügbar</span> : null}
        {props.options.schoolHolidays ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-5 rounded-sm bg-info-soft-text/60" aria-hidden /> Schulferien</span> : null}
        {props.options.cancelled ? <span className="inline-flex items-center gap-1.5"><span className="line-through">abgesagt</span> = abgesagter Termin</span> : null}
        {cancelled ? <span>{cancelled} abgesagte{cancelled === 1 ? "r Termin ist" : " Termine sind"} ausgeblendet (Anzeige).</span> : null}
        {schoolUncovered ? <span>Keine Schulferien-Daten für (Teile) dieses Zeitraums – vorhanden bis {fmtDe(SCHOOL_HOLIDAYS_META.coverage.to)}.</span> : null}
      </p>
    </div>
  );
}

// ───────────── Tag und Woche: Zeitachse mit Spalten ─────────────

function TimeGridView({ view, day, today, now, rows, board, state, overlaps, canWrite, calHref, options }: FullCalendarProps) {
  const team = board.team;
  const teamIds = new Set(team.map((t) => t.id));
  const busyFor = (therapistId: string, dateIso: string): Interval[] =>
    rows
      .filter((r) => r.a.status !== "cancelled" && (r.a.therapistId === therapistId || r.a.therapistId === null))
      .map((r) => dayInterval(r.a.startsAt, r.a.endsAt, dateIso))
      .filter((x): x is Interval => !!x);
  const onDay = (dateIso: string) => rows.filter((r) => dayInterval(r.a.startsAt, r.a.endsAt, dateIso));
  const absentIds = (dateIso: string) => team.filter((t) => absentOn(board.absences.filter((a) => a.userId === t.id), dateIso));

  let columns: Column[];
  const { holiday: dayHoliday, school: daySchool } = view === "tag" ? dayLabels(day, state, options) : { holiday: null, school: null };
  // Schattierung: Arbeitszeiten laut Option; Feiertag (Praxis geschlossen) immer ganztägig – das ist Verfügbarkeit, keine Anzeige-Option
  const outsideOf = (av: { reason: string | null; ranges: Parameters<typeof outsideRanges>[0] }) =>
    av.reason === "holiday" ? [{ startMin: 0, endMin: 24 * 60 }] : options.workHours ? outsideRanges(av.ranges, 0, 24 * 60) : [];
  const holidayNote = (iso: string) => {
    const h = holidayOn(iso, state);
    return h ? `Feiertag (${h}) – Praxis geschlossen` : null;
  };

  if (view === "tag") {
    const dayRows = onDay(day);
    columns = team.map((t) => {
      const av = board.availabilityOf(t.id, day);
      return {
        key: t.id,
        header: (
          <span className="flex min-w-0 flex-col items-center">
            <span className="flex max-w-full items-center gap-1.5 truncate font-semibold">
              {validColor(t.color) ? <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ background: validColor(t.color) }} aria-hidden /> : null}
              <span className="truncate">{t.name}</span>
            </span>
            {av.reason === "absence" && options.absences ? <span className="text-[11px] font-semibold text-accent-soft-text">abwesend</span> : null}
          </span>
        ),
        dateIso: day,
        therapistId: t.id,
        rows: dayRows.filter((r) => r.a.therapistId === t.id),
        busy: busyFor(t.id, day),
        absent: av.reason === "absence",
        outside: av.reason === "absence" ? [] : outsideOf(av),
        note: holidayNote(day),
        today: day === today,
        withTherapist: t.id,
      };
    });
    const rest = dayRows.filter((r) => !r.a.therapistId || !teamIds.has(r.a.therapistId));
    if (rest.length || columns.length === 0) {
      columns.push({
        key: "ohne",
        header: <span className="font-semibold text-muted">{columns.length ? "Ohne Zuordnung" : "Termine"}</span>,
        dateIso: day,
        therapistId: null,
        rows: rest,
        busy: null,
        absent: false,
        outside: [],
        note: holidayNote(day),
        today: day === today,
        withTherapist: null,
      });
    }
  } else {
    const monday = day;
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(`${monday}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const shown = visibleWeekDays(dates, options.weekend, (iso) => onDay(iso).length > 0, today);
    // Nur eine Behandler:in in der Praxis → Belegung und Abwesenheit direkt in der Woche markieren
    const single = team.length === 1 ? team[0] : null;
    columns = shown.map((iso) => {
      const { holiday, school } = dayLabels(iso, state, options);
      const absent = options.absences ? absentIds(iso) : [];
      const av = single ? board.availabilityOf(single.id, iso) : null;
      return {
        key: iso,
        header: (
          <Link href={calHref({ ansicht: "tag", datum: iso })} className="flex min-w-0 flex-col items-center rounded-lg px-1 hover:text-primary" title="Tagesansicht öffnen">
            <span className="flex items-center gap-1">
              <span className="text-xs text-muted">{WD_SHORT[wdIndex(iso)]}</span>
              <span className={`inline-flex min-w-7 justify-center rounded-full px-1.5 font-semibold tabular-nums ${iso === today ? "bg-primary text-on-primary" : ""}`}>{dm(iso)}</span>
            </span>
            {holiday ? <span className="max-w-full truncate text-[11px] font-semibold text-warn-soft-text" title={`Feiertag: ${holiday}`}>{holiday}</span> : null}
            {school ? <span className="max-w-full truncate rounded bg-info-soft px-1 text-[10px] text-info-soft-text" title={`Schulferien: ${school}`}>{school}</span> : null}
            {absent.length ? (
              <span className="max-w-full truncate text-[11px] text-muted" title={`Abwesend – nicht verfügbar: ${absent.map((a) => a.name).join(", ")}`}>
                abwesend: {absent.map((a) => a.name.split(" ")[0]).join(", ")}
              </span>
            ) : null}
          </Link>
        ),
        dateIso: iso,
        therapistId: single?.id ?? null,
        rows: onDay(iso),
        busy: single ? busyFor(single.id, iso) : null,
        absent: av?.reason === "absence",
        outside: av && av.reason !== "absence" ? outsideOf(av) : [],
        note: holidayNote(iso),
        today: iso === today,
        withTherapist: single?.id ?? null,
      };
    });
  }

  // Zeitachse laut Optionen; Termine außerhalb erweitern sie (nie ausblenden)
  const range: Interval = gridRange(
    columns.flatMap((c) => c.rows.map((r) => dayInterval(r.a.startsAt, r.a.endsAt, c.dateIso)).filter((x): x is Interval => !!x)),
    { startMin: options.startHour * 60, endMin: options.endHour * 60 },
  );
  const height = range.endMin - range.startMin;
  const slots = Array.from({ length: height / SLOT_MIN }, (_, i) => range.startMin + i * SLOT_MIN);
  const hours = slots.filter((m) => m % 60 === 0);
  const colMin = view === "tag" ? "8rem" : "5.5rem";
  const template = `3.25rem repeat(${columns.length}, minmax(${colMin}, 1fr))`;
  const nowP = berlinParts(now);

  return (
    <div className="flex flex-col gap-2">
      {dayHoliday || daySchool ? (
        <p className="flex flex-wrap gap-2">
          {dayHoliday ? <Badge tone="warn">Feiertag: {dayHoliday}</Badge> : null}
          {daySchool ? <Badge tone="info">Schulferien: {daySchool}</Badge> : null}
        </p>
      ) : null}
      <div className="max-h-[calc(100dvh-13rem)] min-h-[26rem] overflow-auto rounded-[var(--radius-card)] border border-border bg-surface" role="region" aria-label={view === "tag" ? "Tagesplan" : "Wochenplan"}>
        <div className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
          {/* Kopfzeile */}
          <div className="sticky left-0 top-0 z-30 border-b border-border bg-surface" />
          {columns.map((c) => (
            <div key={`h-${c.key}`} className={`sticky top-0 z-20 flex min-w-0 items-center justify-center border-b border-l border-border px-1 py-2 text-center text-sm ${c.today && view === "tag" ? "bg-primary-soft text-primary-soft-text" : "bg-surface"}`}>
              {c.header}
            </div>
          ))}

          {/* Zeitachse */}
          <div className="sticky left-0 z-10 border-r border-border bg-surface" style={{ height: px(height) }} aria-hidden>
            <div className="relative h-full">
              {hours.map((m) => (
                <span key={m} className="absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums text-muted first:translate-y-0.5" style={{ top: px(m - range.startMin) }}>
                  {toHhmm(m)}
                </span>
              ))}
            </div>
          </div>

          {/* Spalten */}
          {columns.map((c) => {
            const placed = c.rows
              .map((r) => {
                const iv = dayInterval(r.a.startsAt, r.a.endsAt, c.dateIso);
                return iv ? { ...iv, row: r } : null;
              })
              .filter((x): x is Interval & { row: Row } => !!x);
            // Abgesagte belegen keine eigene Spalte: halbtransparent über die volle Breite, aktive Termine liegen darüber
            const cancelledBlocks = placed.filter((p) => p.row.a.status === "cancelled").map((p) => ({ ...p, lane: 0, lanes: 1 }));
            const blocks = [...cancelledBlocks, ...layoutLanes(placed.filter((p) => p.row.a.status !== "cancelled"))];
            const nowMin = c.today && nowP.dateIso === c.dateIso && nowP.min >= range.startMin && nowP.min <= range.endMin ? nowP.min : null;
            return (
              <div key={c.key} className={`relative border-l border-border ${c.today ? "bg-primary-soft/25" : ""}`} style={{ height: px(height), ...GRID_BG }}>
                {/* außerhalb der Arbeitszeit */}
                {c.outside.map((o, i) => {
                  const s = Math.max(o.startMin, range.startMin), e = Math.min(o.endMin, range.endMin);
                  return e > s ? <div key={`o${i}`} className="pointer-events-none absolute inset-x-0 bg-surface-2/70" style={{ top: px(s - range.startMin), height: px(e - s) }} title={c.note ?? "außerhalb der Arbeitszeit"} /> : null;
                })}
                {/* Slots: frei → neuer Termin; belegt → nicht verfügbar */}
                {c.absent ? (
                  <div className="absolute inset-0 z-[1]" style={HATCH} title="Abwesend – nicht verfügbar">
                    <p className="sticky top-14 mx-1 mt-2 rounded-lg border border-border bg-surface px-2 py-1 text-center text-xs font-semibold text-muted">Abwesend – nicht verfügbar</p>
                  </div>
                ) : (
                  slots.map((m) => {
                    const top = px(m - range.startMin);
                    if (c.busy && isBusy(c.busy, m, m + SLOT_MIN)) {
                      return <div key={m} className="absolute inset-x-0 z-[1]" style={{ top, height: px(SLOT_MIN), ...HATCH }} title={`${toHhmm(m)} – belegt, nicht verfügbar`} />;
                    }
                    if (!canWrite) return null;
                    return (
                      <Link
                        key={m}
                        href={newHref(c.dateIso, m, c.withTherapist)}
                        tabIndex={-1}
                        aria-label={`Neuer Termin am ${dm(c.dateIso)} um ${toHhmm(m)} Uhr`}
                        title={c.note ? `${toHhmm(m)} – ${c.note}; neuer Termin trotzdem möglich` : `${toHhmm(m)} – neuer Termin`}
                        className="absolute inset-x-0 z-[1] hover:bg-primary-soft/70"
                        style={{ top, height: px(SLOT_MIN) }}
                      />
                    );
                  })
                )}
                {/* Sperrzeiten (Pause, Schulung …) */}
                {options.blocks ? <BlockOverlays board={board} target={c.key === "ohne" ? "none" : (c.therapistId ?? "all")} dateIso={c.dateIso} range={range} showPerson={view === "woche" && team.length > 1} /> : null}
                {/* Termine */}
                {blocks.map((b) => (
                  <Block key={b.row.a.id} b={b} rangeStart={range.startMin} overlap={overlaps.has(b.row.a.id)} showTherapist={view === "woche"} color={validColor(board.team.find((t) => t.id === b.row.a.therapistId)?.color)} />
                ))}
                {nowMin !== null ? (
                  <div className="pointer-events-none absolute inset-x-0 z-[3] h-0.5 bg-accent" style={{ top: px(nowMin - range.startMin) }} aria-hidden>
                    <span className="absolute -left-1 -top-1 size-2.5 rounded-full bg-accent" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Block({ b, rangeStart, overlap, showTherapist, color }: { b: Interval & { row: Row; lane: number; lanes: number }; rangeStart: number; overlap: boolean; showTherapist: boolean; color?: string }) {
  const { a, therapist } = b.row;
  const h = (b.endMin - b.startMin) * PX_PER_MIN;
  const name = personName(b.row);
  const sub = b.row.patient ? a.title : null;
  const time = `${toHhmm(b.startMin)}–${toHhmm(b.endMin)}`;
  const tone =
    a.status === "cancelled"
      ? "bg-surface-2 text-muted line-through opacity-70"
      : a.status === "done"
        ? "bg-surface-2 text-muted"
        : a.status === "no_show"
          ? "bg-accent-soft text-accent-soft-text"
          : "bg-primary-soft text-primary-soft-text";
  const title = [`${time} Uhr`, name, sub, a.homeVisit ? "Hausbesuch" : null, therapist, a.status === "done" ? "erledigt" : a.status === "no_show" ? "nicht erschienen" : a.status === "cancelled" ? "abgesagt" : null, b.row.feed ? `aus Kalender-Abo „${b.row.feed.label}“` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      href={`/kalender/termin/${a.id}`}
      title={title}
      className={`absolute z-[2] flex flex-col overflow-hidden rounded-md border-l-[3px] border-primary px-1.5 py-0.5 text-xs leading-tight shadow-sm outline-offset-1 hover:brightness-95 focus-visible:z-[4] dark:hover:brightness-110 ${tone} ${overlap ? "ring-2 ring-accent" : ""}`}
      style={{
        top: px(b.startMin - rangeStart),
        height: `${Math.max(14, Math.round(h) - 1)}px`,
        left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`,
        width: `calc(${100 / b.lanes}% - 4px)`,
        borderLeftColor: color,
      }}
    >
      {h < 30 ? (
        <span className="truncate"><span className="tabular-nums">{toHhmm(b.startMin)}</span> <strong>{name}</strong></span>
      ) : (
        <>
          <span className="truncate text-[11px] tabular-nums opacity-80">{time}{a.homeVisit ? " · HB" : ""}</span>
          <strong className="truncate">{name}</strong>
          {sub && h >= 46 ? <span className="truncate opacity-80">{sub}</span> : null}
          {showTherapist && therapist && h >= 62 ? <span className="truncate opacity-70">{therapist}</span> : null}
        </>
      )}
    </Link>
  );
}

// ───────────── Monat ─────────────

function MonthView({ day, today, rows, board, state, canWrite, calHref, options }: FullCalendarProps) {
  const weeks = monthWeeks(day);
  const month = day.slice(0, 7);
  // einmal nach Tag gruppieren (statt je Zelle alle Termine zu formatieren)
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const iso = berlinParts(r.a.startsAt).dateIso;
    byDay.set(iso, [...(byDay.get(iso) ?? []), r]);
  }
  // Wochenend-Spalten laut Optionen (bei „auto“: Sa immer, So nur, wenn in den angezeigten Wochen ein Sonntag Termine hat)
  const shownCols = WD_SHORT.map((_, i) => i).filter((i) => {
    if (i < 5 || options.weekend === "alle") return true;
    if (options.weekend === "keine") return false;
    return i === 5 || weeks.some((w) => (byDay.get(w[i])?.length ?? 0) > 0 || w[i] === today);
  });
  const kw = options.weekNumbers;
  const template = `${kw ? "2.25rem " : ""}repeat(${shownCols.length}, minmax(0, 1fr))`;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface" role="region" aria-label="Monatsübersicht">
      <div className={`grid ${shownCols.length > 5 ? "min-w-[40rem]" : "min-w-[32rem]"}`} style={{ gridTemplateColumns: template }}>
        {kw ? <div className="border-b border-border px-1 py-2 text-center text-xs font-semibold text-muted" title="Kalenderwoche">KW</div> : null}
        {shownCols.map((i) => (
          <div key={i} className={`border-b border-border px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted ${kw || i !== shownCols[0] ? "border-l" : ""}`}>{WD_SHORT[i]}</div>
        ))}
        {weeks.map((week) => [
          kw ? (
            <div key={`kw-${week[0]}`} className="border-b border-border px-1 pt-2 text-center text-[11px] font-semibold tabular-nums text-muted" title={`Kalenderwoche ${isoWeek(week[0])}`}>
              {isoWeek(week[0])}
            </div>
          ) : null,
          ...shownCols.map((ci) => {
            const iso = week[ci];
            const list = byDay.get(iso) ?? [];
            const { holiday, school } = dayLabels(iso, state, options);
            const absent = options.absences ? board.team.filter((t) => absentOn(board.absences.filter((a) => a.userId === t.id), iso)) : [];
            const inMonth = iso.slice(0, 7) === month;
            const isToday = iso === today;
            return (
              <div
                key={iso}
                className={`relative min-h-[6.5rem] border-b border-border p-1 ${kw || ci !== shownCols[0] ? "border-l" : ""} ${inMonth ? "" : "bg-surface-2/60"} ${isToday ? "bg-primary-soft/40" : ""}`}
              >
                {school ? <span className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-info-soft-text/50" title={`Schulferien: ${school}`} aria-hidden /> : null}
                {canWrite ? (
                  <Link href={newHref(iso, null, null)} tabIndex={-1} aria-label={`Neuer Termin am ${dm(iso)}`} title="Neuer Termin an diesem Tag" className="absolute inset-0 hover:bg-primary-soft/50" />
                ) : null}
                <div className="pointer-events-none relative flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-1">
                    <Link
                      href={calHref({ ansicht: "tag", datum: iso })}
                      className={`pointer-events-auto inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums hover:ring-2 hover:ring-primary ${isToday ? "bg-primary text-on-primary" : inMonth ? "" : "text-muted"}`}
                      title="Tagesansicht öffnen"
                    >
                      {Number(iso.slice(8, 10))}
                    </Link>
                    {absent.length ? (
                      <span className="truncate text-[10px] text-muted" title={`Abwesend – nicht verfügbar: ${absent.map((a) => a.name).join(", ")}`}>{absent.length} abw.</span>
                    ) : null}
                  </div>
                  {holiday ? <span className="truncate text-[10px] font-semibold text-warn-soft-text" title={`Feiertag: ${holiday}`}>{holiday}</span> : null}
                  {school ? <span className="truncate text-[10px] text-info-soft-text" title={`Schulferien: ${school}`}>{school}</span> : null}
                  {options.blocks ? <MonthBlockHints board={board} dateIso={iso} dayHref={calHref({ ansicht: "tag", datum: iso })} /> : null}
                  {list.slice(0, 3).map((r) => (
                    <Link
                      key={r.a.id}
                      href={`/kalender/termin/${r.a.id}`}
                      className={`pointer-events-auto truncate rounded px-1 text-[11px] leading-5 hover:brightness-95 ${r.a.status === "cancelled" ? "bg-surface-2 text-muted line-through" : "bg-primary-soft text-primary-soft-text"}`}
                      title={`${toHhmm(berlinParts(r.a.startsAt).min)}–${toHhmm(berlinParts(r.a.endsAt).min)} Uhr · ${personName(r)}${r.therapist ? ` · ${r.therapist}` : ""}${r.a.status === "cancelled" ? " · abgesagt" : ""}`}
                    >
                      <span className="tabular-nums">{toHhmm(berlinParts(r.a.startsAt).min)}</span> {personName(r)}
                    </Link>
                  ))}
                  {list.length > 3 ? (
                    <Link href={calHref({ ansicht: "tag", datum: iso })} className="pointer-events-auto text-[11px] font-semibold text-primary hover:underline">
                      +{list.length - 3} weitere
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}
