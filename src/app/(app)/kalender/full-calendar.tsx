import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Badge } from "@/components/ui";
import { absentOn, addDaysIso, berlinParts, dayInterval, gridRange, initials, isBusy, layoutLanes, monthWeeks, outsideRanges, SLOT_MIN, toHhmm, type FullView } from "@/lib/calendar-grid";
import { isoWeek, visibleWeekDays, type CalendarOptions } from "@/lib/calendar-options";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { SCHOOL_HOLIDAYS_META, schoolHolidayOn, schoolHolidaysCovered } from "@/lib/school-holidays";
import { dotStyle, colorVar, type TherapistColor } from "@/lib/therapist-colors";
import { dragLock } from "@/lib/calendar-dnd";
import type { listAppointments } from "@/server/appointments";
import type { calendarBoard } from "@/server/calendar-board";
import { BLOCK_HATCH, BlockOverlays, DayBlockLine, MonthBlockHints } from "./calendar-blocks-view";
import { DndSurface } from "./calendar-dnd";
import { ScrollToColumn } from "./calendar-scroll";

type Row = Awaited<ReturnType<typeof listAppointments>>[number];
type Board = Awaited<ReturnType<typeof calendarBoard>>;
type Interval = { startMin: number; endMin: number };

/** 16 px je 15 Minuten (64 px je Stunde) */
const PX_PER_MIN = 16 / SLOT_MIN;
const px = (min: number) => `${Math.round(min * PX_PER_MIN)}px`;

const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
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

const personName = (r: Row) => (r.patient ? [r.patient.firstName, r.patient.lastName].filter(Boolean).join(" ") : r.a.title ?? "Termin");

export type FullCalendarProps = {
  view: FullView;
  day: string;
  /** gewählter Tag (Woche: Spalte, die auf dem Handy zuerst sichtbar ist; Monat: Tagesliste auf dem Handy) */
  focusDay?: string;
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
  /** Termine per Ziehen verschieben (Schreibrecht, kein Support-/Nur-Lesen-Modus) */
  canMove: boolean;
  /** abgerechnete Termine (kein Griff zum Verschieben) */
  billed: Set<string>;
};

/**
 * data-Attribute für das Ziehen (calendar-dnd.tsx) und der Hinweis, warum ein Termin nicht verschiebbar ist.
 * Ohne Verschiebe-Recht: keine Attribute, kein Hinweis.
 */
function moveAttrs(r: Row, canMove: boolean, billed: Set<string>): { attrs: Record<string, string>; lock: string | null; movable: boolean } {
  if (!canMove) return { attrs: {}, lock: null, movable: false };
  const lock = dragLock({ ...r.a, fromCalendarFeed: !!r.feed, billed: billed.has(r.a.id) });
  return {
    attrs: {
      "data-appt": r.a.id,
      "data-start": r.a.startsAt.toISOString(),
      "data-end": r.a.endsAt.toISOString(),
      "data-therapist": r.a.therapistId ?? "",
      "data-name": personName(r),
      ...(lock ? { "data-lock": "1" } : { "data-movable": "1" }),
    },
    lock,
    movable: !lock,
  };
}

/** Farbe der Behandler:in eines Termins (null = ohne Zuordnung/unbekannt) */
const colorOf = (board: Board, therapistId: string | null): TherapistColor | null => board.team.find((t) => t.id === therapistId)?.color ?? null;

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
        {props.canMove && props.view !== "monat" ? <span>Termin ziehen = verschieben (Touch: lange drücken), unteren Rand ziehen = Dauer ändern</span> : null}
        {props.canMove && props.view === "monat" ? <span className="max-sm:hidden">Termin auf einen anderen Tag ziehen = verschieben (Uhrzeit bleibt; Touch: lange drücken)</span> : null}
        {props.board.team.length > 1 ? (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Farben der Behandler:innen">
            {props.board.team.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-full" style={dotStyle(t.color)} aria-hidden />
                {t.name}
              </span>
            ))}
          </span>
        ) : null}
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

function TimeGridView({ view, day, focusDay, today, now, rows, board, state, overlaps, canWrite, calHref, options, canMove, billed }: FullCalendarProps) {
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
  // Arbeitszeit ohne Abzug der Sperrzeiten (hoursRanges): Pausen sind keine „außerhalb der Arbeitszeit“, sie zeichnet BlockOverlays
  const outsideOf = (av: { reason: string | null; ranges: Parameters<typeof outsideRanges>[0]; hoursRanges?: Parameters<typeof outsideRanges>[0] }) =>
    av.reason === "holiday" ? [{ startMin: 0, endMin: 24 * 60 }] : options.workHours ? outsideRanges(av.hoursRanges ?? av.ranges, 0, 24 * 60) : [];
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
          <span className="flex min-w-0 flex-col items-center" title={t.name}>
            <span className="flex max-w-full items-center gap-1.5 font-semibold">
              {/* schmal: Initialen in der Farbe der Behandler:in + Vorname; ganzer Name im Tooltip */}
              <span
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold sm:hidden"
                style={{ background: colorVar(t.color, "soft"), color: colorVar(t.color, "text"), boxShadow: `inset 0 0 0 2px ${colorVar(t.color)}` }}
                aria-hidden
              >
                {initials(t.name)}
              </span>
              <span className="inline-block size-2.5 shrink-0 rounded-full max-sm:hidden" style={dotStyle(t.color)} aria-hidden />
              <span className="truncate sm:hidden">{t.name.split(" ")[0]}</span>
              <span className="truncate max-sm:hidden">{t.name}</span>
            </span>
            {av.reason === "absence" && options.absences ? <span className="text-xs font-semibold text-accent-soft-text">abwesend</span> : null}
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
            {holiday ? <span className="max-w-full truncate text-xs font-semibold text-warn-soft-text" title={`Feiertag: ${holiday}`}>{holiday}</span> : null}
            {school ? <span className="max-w-full truncate rounded bg-info-soft px-1 text-xs text-info-soft-text" title={`Schulferien: ${school}`}>{school}</span> : null}
            {absent.length ? (
              <span className="max-w-full truncate text-xs text-muted" title={`Abwesend – nicht verfügbar: ${absent.map((a) => a.name).join(", ")}`}>
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
  // Handy: Woche als 3-Tage-Fenster, Tag mit höchstens 2 Behandler:innen nebeneinander – weitere per Wischen
  // (seitlich einrastend, ganze Spalten); ab sm wie bisher (Mindestbreite je Spalte, sonst Scrollbalken).
  const visible = Math.max(1, Math.min(columns.length, view === "tag" ? 2 : 3));
  const gridVars = {
    "--cal-cols": `3.25rem repeat(${columns.length}, minmax(${colMin}, 1fr))`,
    "--cal-cols-narrow": `3.25rem repeat(${columns.length}, calc((100cqw - 3.25rem) / ${visible}))`,
  } as CSSProperties;
  const nowP = berlinParts(now);
  const focusCol = view === "woche" ? [today, focusDay].find((d) => d && columns.some((c) => c.dateIso === d)) : undefined;

  return (
    <div className="flex flex-col gap-2">
      {dayHoliday || daySchool ? (
        <p className="flex flex-wrap gap-2">
          {dayHoliday ? <Badge tone="warn">Feiertag: {dayHoliday}</Badge> : null}
          {daySchool ? <Badge tone="info">Schulferien: {daySchool}</Badge> : null}
        </p>
      ) : null}
      <DndSurface
        view={view === "tag" ? "tag" : "woche"}
        enabled={canMove}
        pxPerMin={PX_PER_MIN}
        className="@container max-h-[calc(100dvh-13rem)] min-h-[26rem] scroll-pl-[3.25rem] overflow-auto rounded-[var(--radius-card)] border border-border bg-surface max-sm:snap-x max-sm:snap-mandatory data-[dnd-active]:snap-none"
        ariaLabel={view === "tag" ? "Tagesplan" : "Wochenplan"}
      >
        {focusCol ? <ScrollToColumn date={focusCol} /> : null}
        <div className="grid min-w-fit grid-cols-[var(--cal-cols-narrow)] sm:grid-cols-[var(--cal-cols)]" style={gridVars}>
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
              <div
                key={c.key}
                className={`relative snap-start border-l border-border ${c.today ? "bg-primary-soft/25" : ""}`}
                style={{ height: px(height), ...GRID_BG }}
                data-dnd-col=""
                data-date={c.dateIso}
                data-therapist={c.therapistId ?? ""}
                data-range-start={range.startMin}
                data-range-end={range.endMin}
                {...(view === "tag" && !c.therapistId ? { "data-drop": "0" } : {})}
              >
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
                    // touch-compact: Viertelstunden sind 16 px hoch – mit der 44-px-Regel für Touch überlappten sie,
                    // ein Tipp auf 11:00 traf dann 11:15 (der spätere Slot liegt oben)
                    return (
                      <Link
                        key={m}
                        href={newHref(c.dateIso, m, c.withTherapist)}
                        tabIndex={-1}
                        aria-label={`Neuer Termin am ${dm(c.dateIso)} um ${toHhmm(m)} Uhr`}
                        title={c.note ? `${toHhmm(m)} – ${c.note}; neuer Termin trotzdem möglich` : `${toHhmm(m)} – neuer Termin`}
                        className="touch-compact absolute inset-x-0 z-[1] hover:bg-primary-soft/70"
                        style={{ top, height: px(SLOT_MIN) }}
                      />
                    );
                  })
                )}
                {/* Sperrzeiten (Pause, Schulung …) */}
                {options.blocks ? <BlockOverlays board={board} target={c.key === "ohne" ? "none" : (c.therapistId ?? "all")} dateIso={c.dateIso} range={range} showPerson={view === "woche" && team.length > 1} /> : null}
                {/* Termine */}
                {blocks.map((b) => (
                  <Block key={b.row.a.id} b={b} rangeStart={range.startMin} overlap={overlaps.has(b.row.a.id)} showTherapist={view === "woche"} color={colorOf(board, b.row.a.therapistId)} move={moveAttrs(b.row, canMove, billed)} />
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
      </DndSurface>
    </div>
  );
}

function Block({
  b,
  rangeStart,
  overlap,
  showTherapist,
  color,
  move,
}: {
  b: Interval & { row: Row; lane: number; lanes: number };
  rangeStart: number;
  overlap: boolean;
  showTherapist: boolean;
  color: TherapistColor | null;
  move: ReturnType<typeof moveAttrs>;
}) {
  const { a, therapist } = b.row;
  const h = (b.endMin - b.startMin) * PX_PER_MIN;
  const name = personName(b.row);
  const sub = b.row.patient ? a.title : null;
  const time = `${toHhmm(b.startMin)}–${toHhmm(b.endMin)}`;
  // Behandler:in-Farbe: getönte Fläche + kräftiger linker Rand; Status bleibt erkennbar (abgesagt blass/durchgestrichen,
  // erledigt blasser mit ✓, nicht erschienen in Koralle) – der Name steht immer dabei (Farbe nie alleiniger Hinweis)
  // ohne Deckkraft-Abschwächung: Text bleibt ≥ 4,5:1 (erledigt erkennbar an ✓ und gestricheltem Rand)
  const tone =
    a.status === "cancelled"
      ? "bg-surface-2 text-muted line-through"
      : a.status === "no_show"
        ? "bg-accent-soft text-accent-soft-text"
        : color
          ? a.status === "done" ? "[border-left-style:dashed]" : ""
          : a.status === "done"
            ? "bg-surface-2 text-text [border-left-style:dashed]"
            : "bg-primary-soft text-primary-soft-text";
  const tint = color && a.status !== "cancelled" && a.status !== "no_show" ? { background: colorVar(color, "soft"), color: colorVar(color, "text") } : {};
  const done = a.status === "done" ? "✓ " : "";
  const title = [
    `${time} Uhr`,
    name,
    sub,
    a.homeVisit ? "Hausbesuch" : null,
    therapist,
    a.status === "done" ? "erledigt" : a.status === "no_show" ? "nicht erschienen" : a.status === "cancelled" ? "abgesagt" : a.status === "confirmed" ? "bestätigt" : null,
    b.row.feed ? `aus Kalender-Abo „${b.row.feed.label}“` : null,
    move.movable ? "Ziehen zum Verschieben (Touch: lange drücken)" : move.lock ? `Nicht verschiebbar: ${move.lock}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      href={`/kalender/termin/${a.id}`}
      title={title}
      draggable={false}
      {...move.attrs}
      className={`group absolute z-[2] flex flex-col overflow-hidden rounded-md border-l-[3px] border-primary px-1.5 py-0.5 text-xs leading-tight shadow-sm outline-offset-1 hover:brightness-95 focus-visible:z-[4] dark:hover:brightness-110 ${tone} ${overlap ? "ring-2 ring-accent" : ""} ${move.movable ? "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]" : ""}`}
      style={{
        top: px(b.startMin - rangeStart),
        height: `${Math.max(14, Math.round(h) - 1)}px`,
        left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`,
        width: `calc(${100 / b.lanes}% - 4px)`,
        borderLeftColor: color ? colorVar(color) : undefined,
        ...tint,
      }}
    >
      {h < 30 ? (
        <span className="truncate"><span className="tabular-nums">{done}{toHhmm(b.startMin)}</span> <strong>{name}</strong></span>
      ) : (
        <>
          <span className="truncate text-xs tabular-nums">{done}{time}{a.homeVisit ? " · HB" : ""}</span>
          <strong className="truncate">{name}</strong>
          {sub && h >= 46 ? <span className="truncate">{sub}</span> : null}
          {showTherapist && therapist && h >= 62 ? <span className="truncate">{therapist}</span> : null}
        </>
      )}
      {move.movable && h >= 22 ? (
        <span data-resize="" className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" title="Ziehen = Dauer ändern" aria-hidden>
          <span className="mx-auto mt-[3px] block h-0.5 w-6 rounded-full bg-current opacity-0 group-hover:opacity-40" />
        </span>
      ) : null}
    </Link>
  );
}

// ───────────── Monat ─────────────

function MonthView(props: FullCalendarProps) {
  return (
    <>
      <div className="max-sm:hidden">
        <MonthGrid {...props} />
      </div>
      <div className="sm:hidden">
        <MonthCompact {...props} />
      </div>
    </>
  );
}

/** Einträge eines Monats je Tag (Berliner Datum) */
function groupByDay(rows: Row[]) {
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const iso = berlinParts(r.a.startsAt).dateIso;
    byDay.set(iso, [...(byDay.get(iso) ?? []), r]);
  }
  return byDay;
}

const statusText = (s: string) => (s === "cancelled" ? "abgesagt" : s === "done" ? "erledigt" : s === "no_show" ? "nicht erschienen" : null);

/** Monatsraster ab sm (Tablet/Desktop): Einträge je Tag, ziehen = verschieben */
function MonthGrid({ day, today, rows, board, state, canWrite, calHref, options, canMove, billed }: FullCalendarProps) {
  const weeks = monthWeeks(day);
  const month = day.slice(0, 7);
  // einmal nach Tag gruppieren (statt je Zelle alle Termine zu formatieren)
  const byDay = groupByDay(rows);
  // Wochenend-Spalten laut Optionen (bei „auto“: Sa immer, So nur, wenn in den angezeigten Wochen ein Sonntag Termine hat)
  const shownCols = WD_SHORT.map((_, i) => i).filter((i) => {
    if (i < 5 || options.weekend === "alle") return true;
    if (options.weekend === "keine") return false;
    return i === 5 || weeks.some((w) => (byDay.get(w[i])?.length ?? 0) > 0 || w[i] === today);
  });
  const kw = options.weekNumbers;
  const template = `${kw ? "2.25rem " : ""}repeat(${shownCols.length}, minmax(0, 1fr))`;
  return (
    <DndSurface view="monat" enabled={canMove} pxPerMin={PX_PER_MIN} className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface" ariaLabel="Monatsübersicht">
      <div className="grid min-w-[32rem]" style={{ gridTemplateColumns: template }}>
        {kw ? <div className="border-b border-border px-1 py-2 text-center text-xs font-semibold text-muted" title="Kalenderwoche">KW</div> : null}
        {shownCols.map((i) => (
          <div key={i} className={`border-b border-border px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted ${kw || i !== shownCols[0] ? "border-l" : ""}`}>{WD_SHORT[i]}</div>
        ))}
        {weeks.map((week) => [
          kw ? (
            <div key={`kw-${week[0]}`} className="border-b border-border px-1 pt-2 text-center text-xs font-semibold tabular-nums text-muted" title={`Kalenderwoche ${isoWeek(week[0])}`}>
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
                data-dnd-day={iso}
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
                      className={`touch-compact touch-target pointer-events-auto inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums hover:ring-2 hover:ring-primary ${isToday ? "bg-primary text-on-primary" : inMonth ? "" : "text-muted"}`}
                      title="Tagesansicht öffnen"
                    >
                      {Number(iso.slice(8, 10))}
                    </Link>
                    {absent.length ? (
                      <span className="truncate text-xs text-muted" title={`Abwesend – nicht verfügbar: ${absent.map((a) => a.name).join(", ")}`}>{absent.length} abw.</span>
                    ) : null}
                  </div>
                  {holiday ? <span className="truncate text-xs font-semibold text-warn-soft-text" title={`Feiertag: ${holiday}`}>{holiday}</span> : null}
                  {school ? <span className="truncate text-xs text-info-soft-text" title={`Schulferien: ${school}`}>{school}</span> : null}
                  {options.blocks ? <MonthBlockHints board={board} dateIso={iso} dayHref={calHref({ ansicht: "tag", datum: iso })} /> : null}
                  {list.slice(0, 3).map((r) => {
                    const mv = moveAttrs(r, canMove, billed);
                    const c = colorOf(board, r.a.therapistId);
                    const plain = r.a.status === "cancelled" || r.a.status === "no_show" || !c;
                    return (
                      <Link
                        key={r.a.id}
                        href={`/kalender/termin/${r.a.id}`}
                        draggable={false}
                        {...mv.attrs}
                        className={`pointer-events-auto truncate rounded border-l-[3px] border-transparent px-1 text-xs leading-5 hover:brightness-95 ${
                          r.a.status === "cancelled" ? "bg-surface-2 text-muted line-through" : r.a.status === "no_show" ? "bg-accent-soft text-accent-soft-text" : plain ? "bg-primary-soft text-primary-soft-text" : ""
                        } ${r.a.status === "done" ? "[border-left-style:dashed]" : ""} ${mv.movable ? "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]" : ""}`}
                        style={{ ...(c ? { borderLeftColor: colorVar(c) } : {}), ...(plain ? {} : { background: colorVar(c!, "soft"), color: colorVar(c!, "text") }) }}
                        title={[
                          `${toHhmm(berlinParts(r.a.startsAt).min)}–${toHhmm(berlinParts(r.a.endsAt).min)} Uhr · ${personName(r)}${r.therapist ? ` · ${r.therapist}` : ""}${r.a.status === "cancelled" ? " · abgesagt" : r.a.status === "done" ? " · erledigt" : r.a.status === "no_show" ? " · nicht erschienen" : ""}`,
                          mv.movable ? "Auf anderen Tag ziehen zum Verschieben" : mv.lock ? `Nicht verschiebbar: ${mv.lock}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      >
                        <span className="tabular-nums">{r.a.status === "done" ? "✓ " : ""}{toHhmm(berlinParts(r.a.startsAt).min)}</span> {personName(r)}
                      </Link>
                    );
                  })}
                  {list.length > 3 ? (
                    <Link href={calHref({ ansicht: "tag", datum: iso })} className="pointer-events-auto text-xs font-semibold text-primary hover:underline">
                      +{list.length - 3} weitere
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          }),
        ])}
      </div>
    </DndSurface>
  );
}

/**
 * Monat auf dem Handy: kompaktes Raster (Tageszahl + Punkte in den Farben der Behandler:innen, ab 5 Terminen Anzahl)
 * ohne seitliches Scrollen; Antippen eines Tages zeigt darunter dessen Termine (Server-Navigation, Monat bleibt).
 */
function MonthCompact({ day, focusDay, today, rows, board, state, canWrite, calHref, options }: FullCalendarProps) {
  const weeks = monthWeeks(day);
  const month = day.slice(0, 7);
  const selected = focusDay && focusDay.slice(0, 7) === month ? focusDay : today.slice(0, 7) === month ? today : `${month}-01`;
  const byDay = groupByDay(rows);
  const shownCols = WD_SHORT.map((_, i) => i).filter((i) => i < 5 || options.weekend !== "keine");
  const list = (byDay.get(selected) ?? []).slice().sort((a, b) => a.a.startsAt.getTime() - b.a.startsAt.getTime());
  const { holiday, school } = dayLabels(selected, state, options);
  const absent = options.absences ? board.team.filter((t) => absentOn(board.absences.filter((a) => a.userId === t.id), selected)) : [];
  const label = (iso: string) => `${WD_LONG[wdIndex(iso)]}, ${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-1">
        <div className="grid" style={{ gridTemplateColumns: `repeat(${shownCols.length}, minmax(0, 1fr))` }}>
          {shownCols.map((i) => (
            <div key={i} className="py-1.5 text-center text-xs font-semibold text-muted" aria-hidden>
              {WD_SHORT[i]}
            </div>
          ))}
          {weeks.flatMap((week) =>
            shownCols.map((ci) => {
              const iso = week[ci];
              const items = (byDay.get(iso) ?? []).filter((r) => r.a.status !== "cancelled");
              const inMonth = iso.slice(0, 7) === month;
              const isSel = iso === selected;
              const isToday = iso === today;
              const dots = items.slice(0, 4);
              const marks = [dayLabels(iso, state, options).holiday ? "Feiertag" : null].filter(Boolean);
              return (
                <Link
                  key={iso}
                  href={calHref({ ansicht: "monat", datum: iso })}
                  aria-current={isSel ? "date" : undefined}
                  aria-label={`${label(iso)}: ${items.length ? `${items.length} Termin${items.length === 1 ? "" : "e"}` : "keine Termine"}${marks.length ? ` · ${marks.join(", ")}` : ""}`}
                  scroll={false}
                  className={`flex h-12 flex-col items-center justify-start gap-1 rounded-lg pt-1 ${isSel ? "bg-primary-soft ring-2 ring-primary" : "hover:bg-surface-2"} ${inMonth ? "" : "text-muted"}`}
                >
                  <span className={`inline-flex size-6 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${isToday ? "bg-primary text-on-primary" : ""} ${marks.length && !isToday ? "text-warn-soft-text" : ""}`}>
                    {Number(iso.slice(8, 10))}
                  </span>
                  {items.length > 4 ? (
                    <span className="text-xs leading-3 font-semibold tabular-nums">{items.length}</span>
                  ) : (
                    <span className="flex h-3 items-center gap-0.5" aria-hidden>
                      {dots.map((r) => {
                        const c = colorOf(board, r.a.therapistId);
                        return <span key={r.a.id} className="inline-block size-1.5 rounded-full bg-primary" style={c ? dotStyle(c) : undefined} />;
                      })}
                    </span>
                  )}
                </Link>
              );
            }),
          )}
        </div>
      </div>
      <section aria-labelledby="monat-tag" className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="monat-tag" className="font-display text-lg font-semibold">
            {label(selected)}
          </h2>
          <Link href={calHref({ ansicht: "tag", datum: selected })} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline">
            Tagesansicht ›
          </Link>
        </div>
        {holiday || school || absent.length ? (
          <p className="mb-2 flex flex-wrap gap-2 text-sm">
            {holiday ? <Badge tone="warn">Feiertag: {holiday}</Badge> : null}
            {school ? <Badge tone="info">Schulferien: {school}</Badge> : null}
            {absent.length ? <span className="text-muted">Abwesend: {absent.map((a) => a.name).join(", ")}</span> : null}
          </p>
        ) : null}
        {options.blocks ? (
          <div className="mb-2">
            <DayBlockLine board={board} dateIso={selected} />
          </div>
        ) : null}
        {list.length ? (
          <ul className="flex flex-col">
            {list.map((r) => {
              const c = colorOf(board, r.a.therapistId);
              const st = statusText(r.a.status);
              return (
                <li key={r.a.id} className="border-t border-border first:border-t-0">
                  <Link href={`/kalender/termin/${r.a.id}`} className="flex min-h-12 items-center gap-3 py-2 hover:text-primary">
                    <span className="w-24 shrink-0 text-sm font-semibold tabular-nums">
                      {toHhmm(berlinParts(r.a.startsAt).min)}–{toHhmm(berlinParts(r.a.endsAt).min)}
                    </span>
                    <span className="inline-block h-8 w-1 shrink-0 rounded" style={c ? dotStyle(c) : undefined} aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className={`truncate font-semibold ${r.a.status === "cancelled" ? "text-muted line-through" : ""}`}>{personName(r)}</span>
                      <span className="truncate text-sm text-muted">{[r.therapist, st].filter(Boolean).join(" · ")}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">Keine Termine.</p>
        )}
        {canWrite ? (
          <Link href={newHref(selected, null, null)} className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary hover:underline">
            + Termin an diesem Tag
          </Link>
        ) : null}
      </section>
    </div>
  );
}
