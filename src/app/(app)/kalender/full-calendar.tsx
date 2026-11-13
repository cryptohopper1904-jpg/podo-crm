import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Badge } from "@/components/ui";
import { absentOn, berlinParts, dayInterval, gridRange, isBusy, layoutLanes, monthWeeks, outsideRanges, SLOT_MIN, toHhmm, type FullView } from "@/lib/calendar-grid";
import { holidayOn, type StateCode } from "@/lib/holidays";
import type { listAppointments } from "@/server/appointments";
import type { calendarBoard } from "@/server/calendar-board";

type Row = Awaited<ReturnType<typeof listAppointments>>[number];
type Board = Awaited<ReturnType<typeof calendarBoard>>;
type Interval = { startMin: number; endMin: number };

/** 16 px je 15 Minuten (64 px je Stunde) */
const PX_PER_MIN = 16 / SLOT_MIN;
const px = (min: number) => `${Math.round(min * PX_PER_MIN)}px`;

const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dm = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.`;
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
};

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
  const live = props.rows.filter((r) => r.a.status !== "cancelled");
  const cancelled = props.rows.length - live.length;
  return (
    <div className="flex flex-col gap-3">
      {props.overlaps.size ? (
        <p className="rounded-xl bg-accent-soft p-4 text-sm text-accent-soft-text">
          <strong>Überschneidung:</strong> {props.overlaps.size} Termine überschneiden sich mit Terminen aus dem Kalender-Abo (gleiche Behandler:in). Bitte in PodoHero oder in der Quelle (z. B. Doctolib) verlegen.
        </p>
      ) : null}
      {props.view === "monat" ? <MonthView {...props} rows={live} /> : <TimeGridView {...props} rows={live} />}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {props.canWrite ? <span>Freie Zeit anklicken = neuer Termin</span> : null}
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-border" style={HATCH} aria-hidden /> belegt/abwesend – nicht verfügbar</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm border border-border bg-surface-2" aria-hidden /> außerhalb der Arbeitszeit</span>
        {cancelled ? <span>{cancelled} abgesagte{cancelled === 1 ? "r Termin wird" : " Termine werden"} hier nicht angezeigt (siehe Ansicht „Einfach“).</span> : null}
      </p>
    </div>
  );
}

// ───────────── Tag und Woche: Zeitachse mit Spalten ─────────────

function TimeGridView({ view, day, today, now, rows, board, state, overlaps, canWrite, calHref }: FullCalendarProps) {
  const team = board.team;
  const teamIds = new Set(team.map((t) => t.id));
  const busyFor = (therapistId: string, dateIso: string): Interval[] =>
    rows
      .filter((r) => r.a.therapistId === therapistId || r.a.therapistId === null)
      .map((r) => dayInterval(r.a.startsAt, r.a.endsAt, dateIso))
      .filter((x): x is Interval => !!x);
  const onDay = (dateIso: string) => rows.filter((r) => dayInterval(r.a.startsAt, r.a.endsAt, dateIso));
  const absentIds = (dateIso: string) => team.filter((t) => absentOn(board.absences.filter((a) => a.userId === t.id), dateIso));

  let columns: Column[];
  const holidays: string[] = [];

  if (view === "tag") {
    const dayRows = onDay(day);
    const holiday = holidayOn(day, state);
    if (holiday) holidays.push(holiday);
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
            {av.reason === "absence" ? <span className="text-[11px] font-semibold text-accent-soft-text">abwesend</span> : null}
          </span>
        ),
        dateIso: day,
        therapistId: t.id,
        rows: dayRows.filter((r) => r.a.therapistId === t.id),
        busy: busyFor(t.id, day),
        absent: av.reason === "absence",
        outside: av.reason === "absence" ? [] : outsideRanges(av.ranges, 0, 24 * 60),
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
    const sunday = dates[6];
    const shown = onDay(sunday).length || sunday === today ? dates : dates.slice(0, 6);
    // Nur eine Behandler:in in der Praxis → Belegung und Abwesenheit direkt in der Woche markieren
    const single = team.length === 1 ? team[0] : null;
    columns = shown.map((iso) => {
      const holiday = holidayOn(iso, state);
      const absent = absentIds(iso);
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
        outside: av && av.reason !== "absence" ? outsideRanges(av.ranges, 0, 24 * 60) : [],
        today: iso === today,
        withTherapist: single?.id ?? null,
      };
    });
  }

  const range: Interval = gridRange(columns.flatMap((c) => c.rows.map((r) => dayInterval(r.a.startsAt, r.a.endsAt, c.dateIso)).filter((x): x is Interval => !!x)));
  const height = range.endMin - range.startMin;
  const slots = Array.from({ length: height / SLOT_MIN }, (_, i) => range.startMin + i * SLOT_MIN);
  const hours = slots.filter((m) => m % 60 === 0);
  const colMin = view === "tag" ? "8rem" : "5.5rem";
  const template = `3.25rem repeat(${columns.length}, minmax(${colMin}, 1fr))`;
  const nowP = berlinParts(now);

  return (
    <div className="flex flex-col gap-2">
      {holidays.length ? <p><Badge tone="warn">Feiertag: {holidays.join(", ")}</Badge></p> : null}
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
            const blocks = layoutLanes(
              c.rows
                .map((r) => {
                  const iv = dayInterval(r.a.startsAt, r.a.endsAt, c.dateIso);
                  return iv ? { ...iv, row: r } : null;
                })
                .filter((x): x is Interval & { row: Row } => !!x),
            );
            const nowMin = c.today && nowP.dateIso === c.dateIso && nowP.min >= range.startMin && nowP.min <= range.endMin ? nowP.min : null;
            return (
              <div key={c.key} className={`relative border-l border-border ${c.today ? "bg-primary-soft/25" : ""}`} style={{ height: px(height), ...GRID_BG }}>
                {/* außerhalb der Arbeitszeit */}
                {c.outside.map((o, i) => {
                  const s = Math.max(o.startMin, range.startMin), e = Math.min(o.endMin, range.endMin);
                  return e > s ? <div key={`o${i}`} className="pointer-events-none absolute inset-x-0 bg-surface-2/70" style={{ top: px(s - range.startMin), height: px(e - s) }} title="außerhalb der Arbeitszeit" /> : null;
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
                        title={`${toHhmm(m)} – neuer Termin`}
                        className="absolute inset-x-0 z-[1] hover:bg-primary-soft/70"
                        style={{ top, height: px(SLOT_MIN) }}
                      />
                    );
                  })
                )}
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
    a.status === "done" ? "bg-surface-2 text-muted" : a.status === "no_show" ? "bg-accent-soft text-accent-soft-text" : "bg-primary-soft text-primary-soft-text";
  const title = [`${time} Uhr`, name, sub, a.homeVisit ? "Hausbesuch" : null, therapist, a.status === "done" ? "erledigt" : a.status === "no_show" ? "nicht erschienen" : null, b.row.feed ? `aus Kalender-Abo „${b.row.feed.label}“` : null]
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

function MonthView({ day, today, rows, board, state, canWrite, calHref }: FullCalendarProps) {
  const weeks = monthWeeks(day);
  const month = day.slice(0, 7);
  // einmal nach Tag gruppieren (statt je Zelle alle Termine zu formatieren)
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const iso = berlinParts(r.a.startsAt).dateIso;
    byDay.set(iso, [...(byDay.get(iso) ?? []), r]);
  }
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface" role="region" aria-label="Monatsübersicht">
      <div className="grid min-w-[40rem] grid-cols-7">
        {WD_SHORT.map((w) => (
          <div key={w} className="border-b border-border px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted">{w}</div>
        ))}
        {weeks.flat().map((iso) => {
          const list = byDay.get(iso) ?? [];
          const holiday = holidayOn(iso, state);
          const absent = board.team.filter((t) => absentOn(board.absences.filter((a) => a.userId === t.id), iso));
          const inMonth = iso.slice(0, 7) === month;
          const isToday = iso === today;
          return (
            <div key={iso} className={`relative min-h-[6.5rem] border-b border-l border-border p-1 [&:nth-child(7n+1)]:border-l-0 ${inMonth ? "" : "bg-surface-2/60"} ${isToday ? "bg-primary-soft/40" : ""}`}>
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
                {list.slice(0, 3).map((r) => (
                  <Link
                    key={r.a.id}
                    href={`/kalender/termin/${r.a.id}`}
                    className="pointer-events-auto truncate rounded bg-primary-soft px-1 text-[11px] leading-5 text-primary-soft-text hover:brightness-95"
                    title={`${toHhmm(berlinParts(r.a.startsAt).min)}–${toHhmm(berlinParts(r.a.endsAt).min)} Uhr · ${personName(r)}${r.therapist ? ` · ${r.therapist}` : ""}`}
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
        })}
      </div>
    </div>
  );
}
