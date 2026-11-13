import Link from "next/link";
import type { ReactNode } from "react";
import { Ban, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { AppointmentRow } from "@/components/appointment-row";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { getSession, requireAuth } from "@/lib/auth/session";
import { addDaysIso, modeParam, mondayOfIso, monthWeeks, parseFullView, parseMode, shiftMonthIso, type CalendarMode, type FullView } from "@/lib/calendar-grid";
import { berlinDateIso, weekdayLong } from "@/lib/format";
import { holidayOn, STATES, type StateCode } from "@/lib/holidays";
import { isoWeek, keepOptionParams, parseOptionParams, visibleWeekDays, type CalendarOptions } from "@/lib/calendar-options";
import { SCHOOL_HOLIDAYS_META, schoolHolidayOn, schoolHolidaysCovered } from "@/lib/school-holidays";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { listAppointments, therapists } from "@/server/appointments";
import { calendarBoard, calendarModeOf, calendarOptionsOf } from "@/server/calendar-board";
import { setCalendarModeAction } from "./actions";
import { CalendarOptionsPanel } from "./calendar-options-panel";
import { FreeSlotFinder } from "./free-slot-finder";
import { FullCalendar } from "./full-calendar";
import { DayBlockLine } from "./calendar-blocks-view";
import { canCreateBlocks } from "@/server/calendar-blocks";

export const metadata = { title: "Kalender" };

const addDays = addDaysIso;
const mondayOf = mondayOfIso;

/** Umschalter „Einfach“ / „Vollständig“ – speichert die Wahl je Person (im Support-Modus nur per Link, ohne Speichern). */
function ModeSwitch({ mode, day, ansicht, persist, optKeep }: { mode: CalendarMode; day: string; ansicht: string; persist: boolean; optKeep: string }) {
  const cls = (m: CalendarMode) => `rounded-lg px-3 py-2 text-sm font-semibold ${mode === m ? "bg-primary text-on-primary" : "hover:bg-surface-2"}`;
  const label = { simple: "Einfach", full: "Vollständig" } as const;
  if (!persist) {
    return (
      <div className="flex rounded-xl border border-border bg-surface p-1" role="group" aria-label="Kalenderansicht">
        {(["simple", "full"] as const).map((m) => (
          <Link key={m} href={`/kalender?datum=${day}&ansicht=${m === "simple" && ansicht === "monat" ? "woche" : ansicht}&modus=${modeParam(m)}${optKeep}`} className={cls(m)} aria-current={mode === m ? "true" : undefined}>
            {label[m]}
          </Link>
        ))}
      </div>
    );
  }
  return (
    <form action={setCalendarModeAction} className="flex rounded-xl border border-border bg-surface p-1" role="group" aria-label="Kalenderansicht">
      <input type="hidden" name="datum" value={day} />
      <input type="hidden" name="ansicht" value={ansicht} />
      {(["simple", "full"] as const).map((m) => (
        <button key={m} type="submit" name="mode" value={m} className={`cursor-pointer ${cls(m)}`} aria-pressed={mode === m} title={m === "full" ? "Tag/Woche/Monat mit Zeitachse (wird gemerkt)" : "Terminliste (wird gemerkt)"}>
          {label[m]}
        </button>
      ))}
    </form>
  );
}

/** „Freien Termin finden“ – Team und Leistungen (Dauer) für die Suche */
async function Finder({ auth }: { auth: Awaited<ReturnType<typeof requireAuth>> }) {
  const org = auth.organization.id;
  const [team, svc] = await Promise.all([
    therapists(auth),
    withOrg(org, (tx) =>
      tx.select({ id: services.id, code: services.code, name: services.name, durationMin: services.durationMin }).from(services).where(and(eq(services.organizationId, org), eq(services.active, true))).orderBy(asc(services.code)),
    ),
  ]);
  team.sort((a, b) => a.name.localeCompare(b.name, "de"));
  return (
    <FreeSlotFinder
      todayIso={berlinDateIso()}
      team={team.map((t) => ({ id: t.id, name: t.name }))}
      defaultTherapistId={auth.user.id}
      services={svc}
      canCreate={auth.can("appointments.write")}
    />
  );
}

export default async function CalendarPage(props: PageProps<"/kalender">) {
  const auth = await requireAuth("appointments.read");
  const sp = await props.searchParams;
  const day = typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? sp.datum : berlinDateIso();

  // Ansicht: URL (?modus=einfach|voll) vor gemerkter Einstellung (users.prefs), Standard „Einfach“
  const session = await getSession();
  const prefMode = calendarModeOf(session?.user.prefs);
  const urlMode = parseMode(sp.modus);
  const mode = urlMode ?? prefMode;
  const modeKeep = urlMode && urlMode !== prefMode ? `&modus=${modeParam(urlMode)}` : "";
  // Anzeige-Optionen: URL-Parameter (z. B. Support-Modus) vor gemerkter Einstellung, sonst Standard je Ansicht
  const optKeep = keepOptionParams(sp);
  const keep = `${modeKeep}${optKeep}`;
  // Link „Wochenende einblenden“: aktuelle Optionen, Wochenende per URL auf „alle“
  const weekendKeep = `${modeKeep}${keepOptionParams({ ...sp, we: "alle" })}`;
  const persist = !auth.support;
  const options = calendarOptionsOf(session?.user.prefs, mode, parseOptionParams(sp));
  const state = auth.organization.state as StateCode;
  const panel = (ansicht: string) => (
    <CalendarOptionsPanel
      mode={mode}
      options={options}
      persist={persist}
      stateName={STATES[state] ?? state}
      hidden={{ datum: day, ansicht, ...(modeKeep ? { modus: modeParam(mode) } : {}) }}
    />
  );

  if (mode === "full") return <FullPage auth={auth} sp={sp} day={day} keep={keep} optKeep={optKeep} persist={persist} options={options} panel={panel} weekendKeep={weekendKeep} />;

  const view = sp.ansicht === "woche" ? "woche" : "tag";
  const start = view === "woche" ? mondayOf(day) : day;
  const days = view === "woche" ? 7 : 1;
  const today = berlinDateIso();
  const end = addDays(start, days - 1);
  const [allRows, board] = await Promise.all([listAppointments(auth, start, days), options.absences || options.blocks ? calendarBoard(auth, start, end) : null]);
  const rows = options.cancelled ? allRows : allRows.filter((r) => r.a.status !== "cancelled");
  const hiddenCancelled = allRows.length - rows.length;
  const overlaps = feedOverlapIds(rows);
  const step = view === "woche" ? 7 : 1;
  const byDay = (iso: string) => rows.filter((r) => berlinDateIso(r.a.startsAt) === iso);
  const allDates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const dates = view === "woche" ? visibleWeekDays(allDates, options.weekend, (iso) => byDay(iso).length > 0, today) : allDates;
  const hiddenWeekend = allDates.filter((d) => !dates.includes(d)).reduce((n, d) => n + byDay(d).length, 0);
  const schoolUncovered = options.schoolHolidays && allDates.some((d) => !schoolHolidaysCovered(d));
  const absentNames = (iso: string) =>
    board && options.absences ? board.team.filter((t) => board.absences.some((a) => a.userId === t.id && a.startsOn <= iso && iso <= a.endsOn)).map((t) => t.name) : [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={view === "woche" ? `Woche ab ${weekdayLong(`${start}T12:00:00Z`)}${options.weekNumbers ? ` · KW ${isoWeek(start)}` : ""}` : weekdayLong(`${day}T12:00:00Z`)}
        subtitle="Kalender"
        actions={
          <>
            <ModeSwitch mode="simple" day={day} ansicht={view} persist={persist} optKeep={optKeep} />
            {panel(view)}
            <div className="flex rounded-xl border border-border bg-surface p-1">
              <Link href={`/kalender?datum=${day}${keep}`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "tag" ? "bg-primary text-on-primary" : ""}`}>Tag</Link>
              <Link href={`/kalender?datum=${day}&ansicht=woche${keep}`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "woche" ? "bg-primary text-on-primary" : ""}`}>Woche</Link>
            </div>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, -step)}${view === "woche" ? "&ansicht=woche" : ""}${keep}`} aria-label="Zurück"><ChevronLeft size={18} aria-hidden /></LinkButton>
            <LinkButton variant="secondary" href={view === "woche" ? `/kalender?ansicht=woche${keep}` : keep ? `/kalender?${keep.slice(1)}` : "/kalender"}>Heute</LinkButton>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, step)}${view === "woche" ? "&ansicht=woche" : ""}${keep}`} aria-label="Weiter"><ChevronRight size={18} aria-hidden /></LinkButton>
            {canCreateBlocks(auth) ? <LinkButton variant="secondary" href={`/kalender/sperrzeit/neu?datum=${day}`} title="Sperrzeit eintragen: Pause, Schulung, früher Feierabend, Wartung, Reinigung …" aria-label="Sperrzeit eintragen"><Ban size={18} aria-hidden /><span className="max-2xl:sr-only">Sperrzeit</span></LinkButton> : null}
            {auth.can("appointments.write") ? <LinkButton href={`/kalender/neu?datum=${day}`}><Plus size={18} aria-hidden /> Termin</LinkButton> : null}
          </>
        }
      />
      <div className="flex flex-col gap-4">
        <Finder auth={auth} />
        {overlaps.size ? (
          <p className="rounded-xl bg-accent-soft p-4 text-sm text-accent-soft-text">
            <strong>Überschneidung:</strong> {overlaps.size} Termine überschneiden sich mit Terminen aus dem Kalender-Abo (gleiche Behandler:in). Bitte in PodoHero oder in der Quelle (z. B. Doctolib) verlegen.
          </p>
        ) : null}
        {hiddenCancelled ? (
          <p className="text-xs text-muted">{hiddenCancelled} abgesagte{hiddenCancelled === 1 ? "r Termin ist" : " Termine sind"} ausgeblendet (Anzeige).</p>
        ) : null}
        {hiddenWeekend ? (
          <p className="rounded-xl bg-warn-soft px-4 py-2 text-sm text-warn-soft-text">
            {hiddenWeekend} Termin{hiddenWeekend === 1 ? "" : "e"} am Wochenende ausgeblendet (Anzeige „nur Mo–Fr“).{" "}
            <Link href={`/kalender?datum=${day}&ansicht=woche${weekendKeep}`} className="font-semibold underline">Wochenende einblenden</Link>
          </p>
        ) : null}
        {schoolUncovered ? <p className="text-xs text-muted">Keine Schulferien-Daten für (Teile) dieses Zeitraums – vorhanden bis {SCHOOL_HOLIDAYS_META.coverage.to.split("-").reverse().join(".")}.</p> : null}
        {dates.map((iso) => {
          const list = byDay(iso);
          const holiday = options.holidays ? holidayOn(iso, state) : null;
          const school = options.schoolHolidays ? schoolHolidayOn(iso, state) : null;
          const absent = absentNames(iso);
          return (
            <Card key={iso}>
              {view === "woche" ? (
                <div className="mb-2 flex items-center gap-2">
                  <Link href={`/kalender?datum=${iso}${keep}`} className="font-display text-lg font-semibold hover:text-primary">{weekdayLong(`${iso}T12:00:00Z`)}</Link>
                  <span className="text-sm text-muted">{list.filter((r) => r.a.status !== "cancelled").length} Termine</span>
                </div>
              ) : null}
              {holiday || school || absent.length || (board && options.blocks && board.blocks.some((b) => b.dateIso === iso)) ? (
                <p className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {holiday ? <Badge tone="warn">Feiertag: {holiday}</Badge> : null}
                  {school ? <span className="text-xs text-info-soft-text"><span className="rounded bg-info-soft px-1.5 py-0.5">Schulferien</span> {school}</span> : null}
                  {absent.length ? <span className="text-xs text-muted">Abwesend: {absent.join(", ")}</span> : null}
                  {board && options.blocks ? <DayBlockLine board={board} dateIso={iso} /> : null}
                </p>
              ) : null}
              {list.length === 0 ? (
                <Empty title="Keine Termine" />
              ) : (
                list.map((r) => <AppointmentRow key={r.a.id} row={r} canDoc={auth.can("medical.write")} canEdit={auth.can("appointments.write")} overlap={overlaps.has(r.a.id)} />)
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const monthTitle = (iso: string) => new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const shortDate = (iso: string) => new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

/** Vollständige Ansicht: Tag (Spalten je Behandler:in), Woche, Monat – mit Zeitachse wie in Outlook. */
async function FullPage({
  auth,
  sp,
  day,
  keep,
  optKeep,
  weekendKeep,
  persist,
  options,
  panel,
}: {
  auth: Awaited<ReturnType<typeof requireAuth>>;
  sp: Record<string, string | string[] | undefined>;
  day: string;
  keep: string;
  optKeep: string;
  weekendKeep: string;
  persist: boolean;
  options: CalendarOptions;
  panel: (ansicht: string) => ReactNode;
}) {
  const view = parseFullView(sp.ansicht);
  const today = berlinDateIso();
  let start: string, days: number;
  if (view === "tag") [start, days] = [day, 1];
  else if (view === "woche") [start, days] = [mondayOf(day), 7];
  else {
    const weeks = monthWeeks(day);
    [start, days] = [weeks[0][0], weeks.length * 7];
  }
  const end = addDays(start, days - 1);
  const [rows, board] = await Promise.all([listAppointments(auth, start, days), calendarBoard(auth, start, end)]);
  const overlaps = feedOverlapIds(rows);
  const calHref = (p: { ansicht?: FullView; datum?: string }) => `/kalender?ansicht=${p.ansicht ?? view}&datum=${p.datum ?? day}${keep}`;
  const prev = view === "tag" ? addDays(day, -1) : view === "woche" ? addDays(day, -7) : shiftMonthIso(day, -1);
  const next = view === "tag" ? addDays(day, 1) : view === "woche" ? addDays(day, 7) : shiftMonthIso(day, 1);
  const kw = options.weekNumbers && view === "woche" ? ` · KW ${isoWeek(start)}` : "";
  const title = view === "tag" ? weekdayLong(`${day}T12:00:00Z`) : view === "woche" ? `${shortDate(start)} – ${shortDate(addDays(start, 6))}${kw}` : monthTitle(day);
  const tabs: [FullView, string][] = [["tag", "Tag"], ["woche", "Woche"], ["monat", "Monat"]];
  const canWrite = auth.can("appointments.write");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={title}
        subtitle="Kalender"
        actions={
          <>
            <ModeSwitch mode="full" day={day} ansicht={view} persist={persist} optKeep={optKeep} />
            {panel(view)}
            <div className="flex rounded-xl border border-border bg-surface p-1" role="group" aria-label="Zeitraum">
              {tabs.map(([v, label]) => (
                <Link key={v} href={calHref({ ansicht: v })} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === v ? "bg-primary text-on-primary" : "hover:bg-surface-2"}`} aria-current={view === v ? "true" : undefined}>
                  {label}
                </Link>
              ))}
            </div>
            <LinkButton variant="secondary" href={calHref({ datum: prev })} aria-label="Zurück"><ChevronLeft size={18} aria-hidden /></LinkButton>
            <LinkButton variant="secondary" href={calHref({ datum: today })}>Heute</LinkButton>
            <LinkButton variant="secondary" href={calHref({ datum: next })} aria-label="Weiter"><ChevronRight size={18} aria-hidden /></LinkButton>
            {canCreateBlocks(auth) ? <LinkButton variant="secondary" href={`/kalender/sperrzeit/neu?datum=${day}`} title="Sperrzeit eintragen: Pause, Schulung, früher Feierabend, Wartung, Reinigung …" aria-label="Sperrzeit eintragen"><Ban size={18} aria-hidden /><span className="max-2xl:sr-only">Sperrzeit</span></LinkButton> : null}
            {canWrite ? <LinkButton href={`/kalender/neu?datum=${day}`}><Plus size={18} aria-hidden /> Termin</LinkButton> : null}
          </>
        }
      />
      <div className="mb-3"><Finder auth={auth} /></div>
      <FullCalendar
        view={view}
        day={view === "woche" ? start : day}
        today={today}
        now={new Date()}
        rows={rows}
        board={board}
        state={auth.organization.state as StateCode}
        overlaps={overlaps}
        canWrite={canWrite}
        calHref={calHref}
        options={options}
        showWeekendHref={`/kalender?ansicht=${view}&datum=${day}${weekendKeep}`}
      />
    </div>
  );
}
