import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { AppointmentRow } from "@/components/appointment-row";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { getSession, requireAuth } from "@/lib/auth/session";
import { addDaysIso, modeParam, mondayOfIso, monthWeeks, parseFullView, parseMode, shiftMonthIso, type CalendarMode, type FullView } from "@/lib/calendar-grid";
import { berlinDateIso, weekdayLong } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { listAppointments, therapists } from "@/server/appointments";
import { calendarBoard, calendarModeOf } from "@/server/calendar-board";
import { setCalendarModeAction } from "./actions";
import { FreeSlotFinder } from "./free-slot-finder";
import { FullCalendar } from "./full-calendar";

export const metadata = { title: "Kalender" };

const addDays = addDaysIso;
const mondayOf = mondayOfIso;

/** Umschalter „Einfach“ / „Vollständig“ – speichert die Wahl je Person (im Support-Modus nur per Link, ohne Speichern). */
function ModeSwitch({ mode, day, ansicht, persist }: { mode: CalendarMode; day: string; ansicht: string; persist: boolean }) {
  const cls = (m: CalendarMode) => `rounded-lg px-3 py-2 text-sm font-semibold ${mode === m ? "bg-primary text-on-primary" : "hover:bg-surface-2"}`;
  const label = { simple: "Einfach", full: "Vollständig" } as const;
  if (!persist) {
    return (
      <div className="flex rounded-xl border border-border bg-surface p-1" role="group" aria-label="Kalenderansicht">
        {(["simple", "full"] as const).map((m) => (
          <Link key={m} href={`/kalender?datum=${day}&ansicht=${m === "simple" && ansicht === "monat" ? "woche" : ansicht}&modus=${modeParam(m)}`} className={cls(m)} aria-current={mode === m ? "true" : undefined}>
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
  const keep = urlMode && urlMode !== prefMode ? `&modus=${modeParam(urlMode)}` : "";
  const persist = !auth.support;

  if (mode === "full") return <FullPage auth={auth} sp={sp} day={day} keep={keep} persist={persist} />;

  const view = sp.ansicht === "woche" ? "woche" : "tag";
  const start = view === "woche" ? mondayOf(day) : day;
  const days = view === "woche" ? 6 : 1;
  const rows = await listAppointments(auth, start, days);
  const overlaps = feedOverlapIds(rows);
  const step = view === "woche" ? 7 : 1;
  const state = auth.organization.state as StateCode;
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const byDay = (iso: string) => rows.filter((r) => berlinDateIso(r.a.startsAt) === iso);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={view === "woche" ? `Woche ab ${weekdayLong(`${start}T12:00:00Z`)}` : weekdayLong(`${day}T12:00:00Z`)}
        subtitle="Kalender"
        actions={
          <>
            <ModeSwitch mode="simple" day={day} ansicht={view} persist={persist} />
            <div className="flex rounded-xl border border-border bg-surface p-1">
              <Link href={`/kalender?datum=${day}${keep}`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "tag" ? "bg-primary text-on-primary" : ""}`}>Tag</Link>
              <Link href={`/kalender?datum=${day}&ansicht=woche${keep}`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "woche" ? "bg-primary text-on-primary" : ""}`}>Woche</Link>
            </div>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, -step)}${view === "woche" ? "&ansicht=woche" : ""}${keep}`} aria-label="Zurück"><ChevronLeft size={18} aria-hidden /></LinkButton>
            <LinkButton variant="secondary" href={view === "woche" ? `/kalender?ansicht=woche${keep}` : keep ? `/kalender?${keep.slice(1)}` : "/kalender"}>Heute</LinkButton>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, step)}${view === "woche" ? "&ansicht=woche" : ""}${keep}`} aria-label="Weiter"><ChevronRight size={18} aria-hidden /></LinkButton>
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
        {dates.map((iso) => {
          const list = byDay(iso);
          const holiday = holidayOn(iso, state);
          return (
            <Card key={iso}>
              {view === "woche" ? (
                <div className="mb-2 flex items-center gap-2">
                  <Link href={`/kalender?datum=${iso}${keep}`} className="font-display text-lg font-semibold hover:text-primary">{weekdayLong(`${iso}T12:00:00Z`)}</Link>
                  <span className="text-sm text-muted">{list.filter((r) => r.a.status !== "cancelled").length} Termine</span>
                </div>
              ) : null}
              {holiday ? <p className="mb-2"><Badge tone="warn">Feiertag: {holiday}</Badge></p> : null}
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
async function FullPage({ auth, sp, day, keep, persist }: { auth: Awaited<ReturnType<typeof requireAuth>>; sp: Record<string, string | string[] | undefined>; day: string; keep: string; persist: boolean }) {
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
  const title = view === "tag" ? weekdayLong(`${day}T12:00:00Z`) : view === "woche" ? `${shortDate(start)} – ${shortDate(addDays(start, 6))}` : monthTitle(day);
  const tabs: [FullView, string][] = [["tag", "Tag"], ["woche", "Woche"], ["monat", "Monat"]];
  const canWrite = auth.can("appointments.write");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={title}
        subtitle="Kalender"
        actions={
          <>
            <ModeSwitch mode="full" day={day} ansicht={view} persist={persist} />
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
      />
    </div>
  );
}
