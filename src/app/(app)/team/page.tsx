import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, Input, PageHeader, Select, Table, cx } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { ABSENCE_KINDS, ABSENCE_LABELS, WEEKDAYS, computeAvailability, formatRanges, mergeRanges, type AbsenceKind } from "@/lib/availability";
import { berlinDateIso, dateDe, dateTimeDe, fullName } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { addDaysIso } from "@/lib/hygiene-rules";
import { appointmentsInAbsences, canEditTeam, canViewTeam, teamOverview } from "@/server/staff";
import { addAbsenceAction, deleteAbsenceAction, saveWorkingHoursAction } from "./actions";

export const metadata = { title: "Team-Planung" };

const DAYS = 28;
const WD_SHORT = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export default async function TeamPlanningPage() {
  const auth = await requireAuth();
  if (!canViewTeam(auth)) redirect("/kein-zugriff");
  const org = auth.organization.id;
  const edit = canEditTeam(auth);
  const today = berlinDateIso();
  const until = addDaysIso(today, DAYS - 1);
  const [{ staff, hours, absences }, conflicts, past] = await Promise.all([
    teamOverview(org, today, until),
    appointmentsInAbsences(org, today),
    teamOverview(org, addDaysIso(today, -60), addDaysIso(today, -1)),
  ]);
  const state = auth.organization.state as StateCode;
  const days = Array.from({ length: DAYS }, (_, i) => addDaysIso(today, i));
  // Art der Abwesenheit (z. B. Krankheit) ist Beschäftigtendatum → nur für Personalverantwortliche sichtbar
  const kindLabel = (k: string) => (edit ? (ABSENCE_LABELS[k as AbsenceKind] ?? k) : "abwesend");
  const hoursOf = (userId: string) => hours.filter((h) => h.userId === userId);
  const absOf = (userId: string) => absences.filter((a) => a.a.userId === userId).map((a) => a.a);
  const upcoming = absences;
  const recent = past.absences.filter((a) => a.a.endsOn < today).reverse().slice(0, 10);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Team-Planung" subtitle="Arbeitszeiten, Urlaub, Krankheit und Fortbildung" />

      {conflicts.length ? (
        <Card className="mb-6 border-accent">
          <CardTitle>
            <span className="inline-flex items-center gap-2"><AlertTriangle size={20} aria-hidden className="text-accent" /> Termine während Abwesenheit ({conflicts.length})</span>
          </CardTitle>
          <ul className="flex flex-col gap-1 text-[15px]">
            {conflicts.map((c) => (
              <li key={c.id}>
                <Link href={`/kalender?datum=${berlinDateIso(c.startsAt)}`} className="font-semibold hover:underline">{dateTimeDe(c.startsAt)}</Link>
                {" · "}{c.therapist ?? "–"} ({kindLabel(c.absenceKind)})
                {" · "}{c.patientId ? fullName({ firstName: c.firstName, lastName: c.lastName ?? "" }) : (c.title ?? "Termin")}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-muted">Bitte umplanen oder einer anderen Person zuweisen.</p>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardTitle>Nächste 4 Wochen</CardTitle>
        {staff.length === 0 ? (
          <Empty title="Noch keine Teammitglieder" />
        ) : (
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <caption className="sr-only">Anwesenheit je Person und Tag</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 bg-surface pr-3 text-left font-semibold">Person</th>
                  {days.map((d) => {
                    const hol = holidayOn(d, state);
                    return (
                      <th key={d} scope="col" title={hol ?? undefined} className={cx("min-w-8 px-0.5 text-center font-medium", hol ? "text-accent" : "text-muted")}>
                        <span className="block">{WD_SHORT[new Date(`${d}T12:00:00Z`).getUTCDay() || 7]}</span>
                        <span className="block tabular-nums">{d.slice(8, 10)}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <th scope="row" className="sticky left-0 whitespace-nowrap bg-surface py-1 pr-3 text-left text-sm font-semibold">{s.name}</th>
                    {days.map((d) => {
                      const av = computeAvailability({ dateIso: d, hours: hoursOf(s.id), absences: absOf(s.id), holiday: holidayOn(d, state) });
                      const label = av.available
                        ? formatRanges(av.ranges)
                        : av.reason === "absence"
                          ? kindLabel(av.absenceKind ?? "other")
                          : av.reason === "holiday"
                            ? `Feiertag: ${av.holiday}`
                            : "frei";
                      return (
                        <td key={d} className="p-0.5" title={`${s.name}, ${dateDe(d)}: ${label}`}>
                          <span
                            className={cx(
                              "block h-7 rounded",
                              av.available ? "bg-primary-soft" : av.reason === "absence" ? "bg-accent-soft ring-1 ring-inset ring-accent" : "bg-surface-2",
                            )}
                          >
                            <span className="sr-only">{label}</span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 flex flex-wrap gap-4 text-sm text-muted">
              <span className="inline-flex items-center gap-2"><span className="size-3 rounded bg-primary-soft" aria-hidden /> arbeitet</span>
              <span className="inline-flex items-center gap-2"><span className="size-3 rounded bg-accent-soft ring-1 ring-accent" aria-hidden /> abwesend</span>
              <span className="inline-flex items-center gap-2"><span className="size-3 rounded bg-surface-2" aria-hidden /> frei / Feiertag</span>
              <span>Ohne gepflegte Arbeitszeiten gelten Mo–Fr die Öffnungszeiten.</span>
            </p>
          </div>
        )}
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Abwesenheiten</CardTitle>
          {upcoming.length === 0 ? (
            <Empty title="Keine Abwesenheiten in den nächsten 4 Wochen" />
          ) : (
            <ul className="flex flex-col gap-2">
              {upcoming.map(({ a, name }) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
                  <span>
                    <span className="font-semibold">{name}</span> · {dateDe(a.startsOn)}{a.endsOn !== a.startsOn ? ` – ${dateDe(a.endsOn)}` : ""}
                    {" "}<Badge tone={a.kind === "vacation" ? "info" : a.kind === "sick" && edit ? "accent" : "neutral"}>{kindLabel(a.kind)}</Badge>
                    {edit && a.note ? <span className="block text-sm text-muted">{a.note}</span> : null}
                  </span>
                  {edit ? (
                    <form action={deleteAbsenceAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <button className="min-h-11 px-2 text-sm font-semibold text-danger">entfernen</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {recent.length ? (
            <details className="mt-4">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">Vergangene (60 Tage)</summary>
              <ul className="flex flex-col gap-1 text-sm">
                {recent.map(({ a, name }) => (
                  <li key={a.id}>{name} · {dateDe(a.startsOn)}{a.endsOn !== a.startsOn ? ` – ${dateDe(a.endsOn)}` : ""} · {kindLabel(a.kind)}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>

        {edit ? (
          <Card>
            <CardTitle>Abwesenheit eintragen</CardTitle>
            <ActionForm key={upcoming.length} action={addAbsenceAction} submit="Eintragen">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Person *">
                  <Select name="userId" required defaultValue="">
                    <option value="" disabled>– wählen –</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Art">
                  <Select name="kind" defaultValue="vacation">
                    {ABSENCE_KINDS.map((k) => <option key={k} value={k}>{ABSENCE_LABELS[k]}</option>)}
                  </Select>
                </Field>
                <Field label="Von *"><Input type="date" name="startsOn" defaultValue={today} required /></Field>
                <Field label="Bis" hint="leer = nur ein Tag"><Input type="date" name="endsOn" /></Field>
                <Field label="Notiz" className="sm:col-span-2" hint="Keine Diagnosen eintragen.">
                  <Input name="note" maxLength={300} />
                </Field>
              </div>
            </ActionForm>
          </Card>
        ) : null}
      </div>

      <section>
        <h2 className="mb-3 font-display text-xl font-semibold">Arbeitszeiten</h2>
        {edit ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {staff.map((s) => {
              const own = hoursOf(s.id);
              return (
                <Card key={s.id}>
                  <CardTitle>{s.name} <span className="text-sm font-normal text-muted">· {ROLE_LABELS[s.role]}</span></CardTitle>
                  <ActionForm action={saveWorkingHoursAction} submit="Arbeitszeiten speichern">
                    <input type="hidden" name="userId" value={s.id} />
                    <div className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:items-center">
                      {WEEKDAYS.map(([wd, label]) => (
                        <label key={wd} className="contents">
                          <span className="text-sm font-medium">{label}</span>
                          <Input
                            name={`wd${wd}`}
                            defaultValue={formatRanges(mergeRanges(own.filter((h) => h.weekday === wd).map((h) => ({ start: h.startTime, end: h.endTime }))))}
                            placeholder="frei – z. B. 08:00-12:00, 13:00-17:00"
                            maxLength={200}
                          />
                        </label>
                      ))}
                    </div>
                  </ActionForm>
                </Card>
              );
            })}
          </div>
        ) : (
          <Table>
            <thead><tr><th>Person</th>{WEEKDAYS.map(([wd, l]) => <th key={wd}>{l.slice(0, 2)}</th>)}</tr></thead>
            <tbody>
              {staff.map((s) => {
                const own = hoursOf(s.id);
                return (
                  <tr key={s.id}>
                    <td className="font-semibold">{s.name}</td>
                    {WEEKDAYS.map(([wd]) => (
                      <td key={wd} className="text-sm">
                        {own.length === 0 ? "–" : formatRanges(mergeRanges(own.filter((h) => h.weekday === wd).map((h) => ({ start: h.startTime, end: h.endTime })))) || "frei"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
