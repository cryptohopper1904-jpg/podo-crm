import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { AppointmentRow } from "@/components/appointment-row";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { Badge, Card, cx, Empty, LinkButton, segmentGroupCls, segmentItemCls } from "@/components/ui";
import { getSession, requireAuth } from "@/lib/auth/session";
import {
  addDaysIso,
  defaultFullView,
  isNarrowCookie,
  modeParam,
  mondayOfIso,
  monthWeeks,
  NARROW_COOKIE,
  parseFullView,
  parseMode,
  shiftMonthIso,
  shortCalendarTitle,
  type CalendarMode,
  type FullView,
} from "@/lib/calendar-grid";
import { berlinDateIso, weekdayLong } from "@/lib/format";
import { holidayOn, STATES, type StateCode } from "@/lib/holidays";
import { isoWeek, keepOptionParams, parseOptionParams, visibleWeekDays, type CalendarOptions } from "@/lib/calendar-options";
import { SCHOOL_HOLIDAYS_META, schoolHolidayOn, schoolHolidaysCovered } from "@/lib/school-holidays";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { billedAppointmentIds, listAppointments, therapists } from "@/server/appointments";
import { teamColors } from "@/server/therapist-colors";
import { calendarBoard, calendarModeOf, calendarOptionsOf } from "@/server/calendar-board";
import { setCalendarModeAction } from "./actions";
import { CalendarOptionsPanel } from "./calendar-options-panel";
import { FreeSlotFinder } from "./free-slot-finder";
import { FullCalendar } from "./full-calendar";
import { DayBlockLine } from "./calendar-blocks-view";
import { canCreateBlocks } from "@/server/calendar-blocks";
import { CalendarHeader } from "./calendar-header";
import { DATE_SLOT, ViewportDefault } from "./calendar-header-parts";
import { NewAppointmentHost } from "./new-appointment-dialog";

export const metadata = { title: "Kalender" };

const addDays = addDaysIso;
const mondayOf = mondayOfIso;

/**
 * Umschalter „Einfach“ / „Vollständig“ – speichert die Wahl je Person (im Support-Modus nur per Link, ohne Speichern).
 * `wide`: volle Breite (im „⋯“-Menü auf dem Handy).
 */
function ModeSwitch({ mode, day, ansicht, persist, optKeep, wide = false }: { mode: CalendarMode; day: string; ansicht: string; persist: boolean; optKeep: string; wide?: boolean }) {
  const label = { simple: "Einfach", full: "Vollständig" } as const;
  const group = cx(segmentGroupCls, "flex-nowrap", wide && "flex w-full");
  const item = (m: CalendarMode) => cx(segmentItemCls(mode === m), wide && "flex-1");
  if (!persist) {
    return (
      <div className={group} role="group" aria-label="Kalenderansicht">
        {(["simple", "full"] as const).map((m) => (
          <Link key={m} href={`/kalender?datum=${day}&ansicht=${m === "simple" && ansicht === "monat" ? "woche" : ansicht}&modus=${modeParam(m)}${optKeep}`} className={item(m)} aria-current={mode === m ? "true" : undefined}>
            {label[m]}
          </Link>
        ))}
      </div>
    );
  }
  return (
    <form action={setCalendarModeAction} className={group} role="group" aria-label="Kalenderansicht">
      <input type="hidden" name="datum" value={day} />
      <input type="hidden" name="ansicht" value={ansicht} />
      {(["simple", "full"] as const).map((m) => (
        <button key={m} type="submit" name="mode" value={m} className={cx("cursor-pointer", item(m))} aria-pressed={mode === m} title={m === "full" ? "Tag/Woche/Monat mit Zeitachse (wird gemerkt)" : "Terminliste (wird gemerkt)"}>
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
  const panel = (ansicht: string, place: "menu" | "bar" = "bar") => (
    <CalendarOptionsPanel
      wide={place === "menu"}
      mode={mode}
      options={options}
      persist={persist}
      stateName={STATES[state] ?? state}
      hidden={{ datum: day, ansicht, ...(modeKeep ? { modus: modeParam(mode) } : {}) }}
    />
  );

  if (mode === "full") {
    const narrow = isNarrowCookie((await cookies()).get(NARROW_COOKIE)?.value);
    return <FullPage auth={auth} sp={sp} day={day} keep={keep} optKeep={optKeep} persist={persist} options={options} panel={panel} weekendKeep={weekendKeep} narrow={narrow} />;
  }

  const view = sp.ansicht === "woche" ? "woche" : "tag";
  const start = view === "woche" ? mondayOf(day) : day;
  const days = view === "woche" ? 7 : 1;
  const today = berlinDateIso();
  const end = addDays(start, days - 1);
  const [allRows, board, colors] = await Promise.all([listAppointments(auth, start, days), options.absences || options.blocks ? calendarBoard(auth, start, end) : null, teamColors(auth)]);
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
  // „Quittung“ direkt in der Zeile: erledigte, noch nicht abgerechnete Termine (nur mit Recht auf Belege)
  const doneIds = auth.can("invoices.write") ? rows.filter((r) => r.a.status === "done" && r.patient).map((r) => r.a.id) : [];
  const billed = doneIds.length ? await billedAppointmentIds(auth, doneIds) : new Set<string>();
  const canWrite = auth.can("appointments.write");
  const listHref = (p: { ansicht?: "tag" | "woche"; datum?: string }) => `/kalender?datum=${p.datum ?? day}${(p.ansicht ?? view) === "woche" ? "&ansicht=woche" : ""}${keep}`;
  const fullTitle = view === "woche" ? `Woche ab ${weekdayLong(`${start}T12:00:00Z`)}${options.weekNumbers ? ` · KW ${isoWeek(start)}` : ""}` : weekdayLong(`${day}T12:00:00Z`);

  return (
    <NewAppointmentHost enabled={canWrite} fallbackDate={day}>
      <div className="mx-auto max-w-6xl max-sm:pb-20">
        <CalendarHeader
          title={fullTitle}
          shortTitle={shortCalendarTitle(view, day)}
          dateValue={day}
          datePattern={listHref({ datum: DATE_SLOT })}
          prevHref={listHref({ datum: addDays(day, -step) })}
          nextHref={listHref({ datum: addDays(day, step) })}
          todayHref={view === "woche" ? `/kalender?ansicht=woche${keep}` : keep ? `/kalender?${keep.slice(1)}` : "/kalender"}
          prevLabel={view === "woche" ? "Vorige Woche" : "Vorheriger Tag"}
          nextLabel={view === "woche" ? "Nächste Woche" : "Nächster Tag"}
          tabs={[
            { href: listHref({ ansicht: "tag" }), label: "Tag", active: view === "tag" },
            { href: listHref({ ansicht: "woche" }), label: "Woche", active: view === "woche" },
          ]}
          modeSwitch={(place) => <ModeSwitch mode="simple" day={day} ansicht={view} persist={persist} optKeep={optKeep} wide={place === "menu"} />}
          panel={(place) => panel(view, place)}
          blockHref={canCreateBlocks(auth) ? `/kalender/sperrzeit/neu?datum=${day}` : null}
          newHref={canWrite ? `/kalender/neu?datum=${day}` : null}
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
                    <Link href={listHref({ ansicht: "tag", datum: iso })} className="font-display text-lg font-semibold hover:text-primary">{weekdayLong(`${iso}T12:00:00Z`)}</Link>
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
                  <Empty
                    title="Keine Termine"
                    action={
                      canWrite ? (
                        <LinkButton variant="secondary" href={`/kalender/neu?datum=${iso}`}>
                          <Plus size={18} aria-hidden /> Termin
                        </LinkButton>
                      ) : null
                    }
                  />
                ) : (
                  list.map((r) => (
                    <AppointmentRow
                      key={r.a.id}
                      row={r}
                      canDoc={auth.can("medical.write")}
                      canEdit={canWrite}
                      billable={doneIds.includes(r.a.id) && !billed.has(r.a.id)}
                      overlap={overlaps.has(r.a.id)}
                      from={`/kalender?datum=${day}${view === "woche" ? "&ansicht=woche" : ""}${keep}`}
                      color={r.a.therapistId ? colors.get(r.a.therapistId) : undefined}
                    />
                  ))
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </NewAppointmentHost>
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
  narrow,
}: {
  auth: Awaited<ReturnType<typeof requireAuth>>;
  sp: Record<string, string | string[] | undefined>;
  day: string;
  keep: string;
  optKeep: string;
  weekendKeep: string;
  persist: boolean;
  options: CalendarOptions;
  panel: (ansicht: string, place?: "menu" | "bar") => ReactNode;
  /** Handy (Cookie, siehe ViewportDefault): ohne Angabe Tag statt Woche */
  narrow: boolean;
}) {
  const view = parseFullView(sp.ansicht, defaultFullView(narrow));
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
  // Ziehen zum Verschieben: nur mit Schreibrecht, nicht im Support- oder Nur-Lesen-Modus (Abo abgelaufen)
  const canMove = auth.can("appointments.write") && !auth.support && !auth.readOnly;
  const billed = canMove ? await billedAppointmentIds(auth, rows.map((r) => r.a.id)) : new Set<string>();
  const calHref = (p: { ansicht?: FullView; datum?: string }) => `/kalender?ansicht=${p.ansicht ?? view}&datum=${p.datum ?? day}${keep}`;
  const prev = view === "tag" ? addDays(day, -1) : view === "woche" ? addDays(day, -7) : shiftMonthIso(day, -1);
  const next = view === "tag" ? addDays(day, 1) : view === "woche" ? addDays(day, 7) : shiftMonthIso(day, 1);
  const kw = options.weekNumbers && view === "woche" ? ` · KW ${isoWeek(start)}` : "";
  const title = view === "tag" ? weekdayLong(`${day}T12:00:00Z`) : view === "woche" ? `${shortDate(start)} – ${shortDate(addDays(start, 6))}${kw}` : monthTitle(day);
  const tabs: [FullView, string][] = [["tag", "Tag"], ["woche", "Woche"], ["monat", "Monat"]];
  const unit = { tag: ["Vorheriger Tag", "Nächster Tag"], woche: ["Vorige Woche", "Nächste Woche"], monat: ["Voriger Monat", "Nächster Monat"] }[view];
  const canWrite = auth.can("appointments.write");

  return (
    <NewAppointmentHost enabled={canWrite} fallbackDate={day}>
      <div className="mx-auto max-w-7xl max-sm:pb-20">
        <ViewportDefault narrow={narrow} explicitView={typeof sp.ansicht === "string"} />
        <CalendarHeader
          title={title}
          shortTitle={shortCalendarTitle(view, day)}
          dateValue={day}
          datePattern={calHref({ datum: DATE_SLOT })}
          prevHref={calHref({ datum: prev })}
          nextHref={calHref({ datum: next })}
          todayHref={calHref({ datum: today })}
          prevLabel={unit[0]}
          nextLabel={unit[1]}
          tabs={tabs.map(([v, label]) => ({ href: calHref({ ansicht: v }), label, active: view === v }))}
          modeSwitch={(place) => <ModeSwitch mode="full" day={day} ansicht={view} persist={persist} optKeep={optKeep} wide={place === "menu"} />}
          panel={(place) => panel(view, place)}
          blockHref={canCreateBlocks(auth) ? `/kalender/sperrzeit/neu?datum=${day}` : null}
          newHref={canWrite ? `/kalender/neu?datum=${day}` : null}
        />
        <div className="mb-3"><Finder auth={auth} /></div>
        <FullCalendar
          view={view}
          day={view === "woche" ? start : day}
          focusDay={day}
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
          canMove={canMove}
          billed={billed}
        />
      </div>
    </NewAppointmentHost>
  );
}
