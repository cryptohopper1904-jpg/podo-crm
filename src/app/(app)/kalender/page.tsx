import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { AppointmentRow } from "@/components/appointment-row";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { Badge, Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, weekdayLong } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { listAppointments } from "@/server/appointments";

export const metadata = { title: "Kalender" };

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};

export default async function CalendarPage(props: PageProps<"/kalender">) {
  const auth = await requireAuth("appointments.read");
  const sp = await props.searchParams;
  const view = sp.ansicht === "woche" ? "woche" : "tag";
  const day = typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? sp.datum : berlinDateIso();
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
            <div className="flex rounded-xl border border-border bg-surface p-1">
              <Link href={`/kalender?datum=${day}`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "tag" ? "bg-primary text-on-primary" : ""}`}>Tag</Link>
              <Link href={`/kalender?datum=${day}&ansicht=woche`} className={`rounded-lg px-3 py-2 text-sm font-semibold ${view === "woche" ? "bg-primary text-on-primary" : ""}`}>Woche</Link>
            </div>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, -step)}${view === "woche" ? "&ansicht=woche" : ""}`} aria-label="Zurück"><ChevronLeft size={18} aria-hidden /></LinkButton>
            <LinkButton variant="secondary" href={`/kalender${view === "woche" ? "?ansicht=woche" : ""}`}>Heute</LinkButton>
            <LinkButton variant="secondary" href={`/kalender?datum=${addDays(day, step)}${view === "woche" ? "&ansicht=woche" : ""}`} aria-label="Weiter"><ChevronRight size={18} aria-hidden /></LinkButton>
            {auth.can("appointments.write") ? <LinkButton href={`/kalender/neu?datum=${day}`}><Plus size={18} aria-hidden /> Termin</LinkButton> : null}
          </>
        }
      />
      <div className="flex flex-col gap-4">
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
                  <Link href={`/kalender?datum=${iso}`} className="font-display text-lg font-semibold hover:text-primary">{weekdayLong(`${iso}T12:00:00Z`)}</Link>
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
