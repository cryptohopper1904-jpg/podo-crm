import { Card, CardTitle, Empty, PageHeader, Stat } from "@/components/ui";
import { SOURCE } from "@/components/appointment-row";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe } from "@/lib/format";
import {
  MIN_SLOT_BOOKINGS,
  ONLINE_SOURCES,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  buildHeatmap,
  formatLead,
  formatLeadShort,
  pctDe,
  periodQuery,
  rankWeekdays,
  rate,
  resolvePeriod,
} from "@/lib/stats";
import { statsDetailsOpen } from "@/lib/view-level";
import { appointmentStats, statsTherapists } from "@/server/stats";
import { currentViewLevel } from "@/server/view-level";
import { Columns, HBars, HeatmapTable, KeyValue, ValuesTable, Weekday } from "../charts";
import { StatsFilter, StatsTabs, yearOfPeriod } from "../stats-nav";

export const metadata = { title: "Auswertung – Termine" };

const num = (v: number, digits = 0) => v.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const slotName = (isodow: number, hour: number) => `${WEEKDAYS[isodow - 1]}, ${hour}–${hour + 1} Uhr`;
/** kurz für schmale Ranglisten (iPad) */
const slotShort = (isodow: number, hour: number) => `${WEEKDAYS_SHORT[isodow - 1]} ${hour}–${hour + 1} Uhr`;

export default async function StatsAppointmentsPage(props: PageProps<"/auswertung/termine">) {
  const auth = await requireAuth("finance.read");
  const sp = await props.searchParams;
  const period = resolvePeriod(sp, berlinDateIso());
  const therapists = await statsTherapists(auth);
  const wanted = typeof sp.behandler === "string" ? sp.behandler : "";
  const therapistId = therapists.some((t) => t.id === wanted) ? wanted : null;
  const [s, level] = await Promise.all([appointmentStats(auth, period, therapistId), currentViewLevel()]);
  const open = statsDetailsOpen(level);
  const csvOk = !auth.support;
  const q = periodQuery(period);
  const file = (name: string) => `${name}-${period.from}-bis-${period.to}.csv`;

  const occupancy = buildHeatmap(s.slots);
  const leadHeat = buildHeatmap(s.slots.filter((x) => x.lead !== null && x.leadCount > 0).map((x) => ({ isodow: x.isodow, hour: x.hour, value: x.lead! })));
  const ranked = rankWeekdays(s.weekdayCounts, s.weekdayOccurrences);
  const strongest = ranked[0];
  const weakest = ranked.filter((d) => d.total > 0).at(-1);
  const rankedSlots = s.slots.filter((x) => x.lead !== null && x.leadCount >= MIN_SLOT_BOOKINGS);
  const earliest = [...rankedSlots].sort((a, b) => b.lead! - a.lead! || b.value - a.value).slice(0, 5);
  const shortNotice = [...rankedSlots].sort((a, b) => a.lead! - b.lead! || b.value - a.value).slice(0, 5);
  const resolved = s.done + s.noShow;
  const therapistName = therapistId ? therapists.find((t) => t.id === therapistId)?.name : null;
  const onlineLabels = ONLINE_SOURCES.map((x) => SOURCE[x] ?? x).join(", ");

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Auswertung" subtitle={`Termine nach Terminbeginn${therapistName ? ` · ${therapistName}` : ""}`} />
      <StatsTabs active="termine" statsQuery={q} year={yearOfPeriod(period)} />
      <StatsFilter action="/auswertung/termine" period={period} therapists={therapists} therapistId={therapistId} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Termine (ohne Absagen)" value={num(s.booked)} tone="primary" sub={`${num(s.total)} insgesamt gebucht`} />
        <Stat label="Absagequote" value={pctDe(rate(s.cancelled, s.total))} tone="neutral" sub={`${num(s.cancelled)} abgesagt von ${num(s.total)}`} />
        <Stat
          label="No-Show-Quote"
          value={pctDe(rate(s.noShow, resolved))}
          tone={s.noShow ? "accent" : "neutral"}
          sub={`${num(s.noShow)} nicht erschienen von ${num(resolved)} abgeschlossenen`}
        />
        <Stat label="Online gebucht" value={pctDe(rate(s.online, s.booked))} tone="info" sub={`${num(s.online)} über ${onlineLabels}`} />
        <Stat label="Neue Patient:innen" value={num(s.patients.new)} tone="primary" sub={`${num(s.patients.returning)} wiederkehrend · ${pctDe(rate(s.patients.new, s.patients.total))} neu`} />
        <Stat label="Median-Vorlauf" value={formatLead(s.leadMedian)} tone="neutral" sub={`Buchung bis Termin, aus ${num(s.leadCount)} Terminen`} />
      </div>

      {s.total === 0 ? (
        <Empty title="Keine Termine in diesem Zeitraum">Bitte einen anderen Zeitraum oder alle Behandler:innen wählen.</Empty>
      ) : (
        <>
          <Card className="mb-6">
            <CardTitle>Belegung nach Wochentag und Uhrzeit</CardTitle>
            <p className="mb-3 text-sm text-muted">Anzahl Termine (ohne Absagen) je Wochentag und Stunde des Terminbeginns, Berliner Ortszeit. Dunkler = mehr Termine.</p>
            <HeatmapTable
              heat={occupancy}
              caption={`Termine je Wochentag und Stunde, ${period.label}`}
              cell={(v) => num(v)}
              title={(v, d, h) => `${WEEKDAYS[d]}, ${h}–${h + 1} Uhr: ${v === null ? "keine Termine" : `${num(v)} Termine`}`}
              legend={["weniger", "mehr"]}
            />
            <ValuesTable
              caption="Termine und Median-Vorlauf je Wochentag und Stunde"
              summary="Alle Slots als Tabelle"
              head={["Slot", "Termine", "Median-Vorlauf", "Termine mit Vorlauf"]}
              rows={[...s.slots]
                .sort((a, b) => a.isodow - b.isodow || a.hour - b.hour)
                .map((x) => [slotName(x.isodow, x.hour), num(x.value), formatLead(x.lead), num(x.leadCount)])}
              csv={
                csvOk
                  ? {
                      filename: file("termine-slots"),
                      rows: [...s.slots]
                        .sort((a, b) => a.isodow - b.isodow || a.hour - b.hour)
                        .map((x) => [slotName(x.isodow, x.hour), x.value, x.lead === null ? "" : num(x.lead / 24, 1), x.leadCount]),
                    }
                  : null
              }
            />
            {csvOk ? <p className="mt-1 text-xs text-muted">CSV: Median-Vorlauf in Tagen.</p> : null}
          </Card>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>Stärkste und schwächste Tage</CardTitle>
              <p className="mb-3 text-sm text-muted">Ø Termine je Kalendertag (Termine des Wochentags ÷ wie oft er im Zeitraum vorkam).</p>
              <Columns
                label="Durchschnittliche Termine je Wochentag"
                items={ranked
                  .slice()
                  .sort((a, b) => a.index - b.index)
                  .map((d) => ({ label: d.label.slice(0, 2), value: d.perDay, display: num(d.perDay, 1), strong: d === strongest }))}
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <KeyValue label="Stärkster Tag" value={strongest?.total ? strongest.label : "–"} hint={strongest?.total ? `Ø ${num(strongest.perDay, 1)} Termine` : undefined} />
                <KeyValue label="Schwächster Tag (mit Terminen)" value={weakest ? weakest.label : "–"} hint={weakest ? `Ø ${num(weakest.perDay, 1)} Termine` : undefined} />
              </div>
              <ValuesTable
                caption="Termine je Wochentag"
                open={open}
                head={["Tag", "Termine", "Tage", "Ø/Tag", "Vorlauf"]}
                rows={WEEKDAYS.map((_, i) => [<Weekday key="d" index={i} />, num(s.weekdayCounts[i]), num(s.weekdayOccurrences[i]), num(s.weekdayOccurrences[i] ? s.weekdayCounts[i] / s.weekdayOccurrences[i] : 0, 1), formatLead(s.weekdayLead[i])])}
                csv={
                  csvOk
                    ? {
                        filename: file("termine-wochentage"),
                        head: ["Wochentag", "Termine", "Tage im Zeitraum", "Ø je Tag", "Median-Vorlauf (Tage)"],
                        rows: WEEKDAYS.map((w, i) => [w, s.weekdayCounts[i], s.weekdayOccurrences[i], num(s.weekdayOccurrences[i] ? s.weekdayCounts[i] / s.weekdayOccurrences[i] : 0, 2), s.weekdayLead[i] === null ? "" : num(s.weekdayLead[i]! / 24, 1)]),
                      }
                    : null
                }
              />
              {s.topDates.length ? (
                <div className="mt-4">
                  <h3 className="mb-2 font-semibold">Spitzentage</h3>
                  <HBars items={s.topDates.map((d) => ({ label: `${WEEKDAYS[(new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7].slice(0, 2)}, ${dateDe(`${d.date}T12:00:00Z`)}`, value: d.count, display: `${num(d.count)} Termine` }))} />
                </div>
              ) : null}
            </Card>

            <Card>
              <CardTitle>Am schnellsten vergeben</CardTitle>
              <p className="mb-3 text-sm text-muted">
                <strong className="text-text">Vorlauf</strong> = Zeit zwischen Buchung (Anlage des Termins) und Terminbeginn, als Median. Langer Vorlauf heißt: dieser Slot ist
                früh ausgebucht – er ist am schnellsten weg. Kurzer Vorlauf heißt: er wird erst kurzfristig gebucht und ist oft noch frei. Ohne Absagen, nachgetragene
                Termine und Kalender-Abo-Importe; Ranglisten ab {MIN_SLOT_BOOKINGS} Terminen je Slot. Importierte Doctolib-Termine zählen ab ihrer Übernahme.
              </p>
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <KeyValue label="Median-Vorlauf insgesamt" value={formatLead(s.leadMedian)} hint={`aus ${num(s.leadCount)} Terminen`} />
                <KeyValue
                  label="Am frühesten ausgebucht"
                  value={earliest[0] ? `${WEEKDAYS[earliest[0].isodow - 1].slice(0, 2)}, ${earliest[0].hour} Uhr` : "–"}
                  hint={earliest[0] ? `Median-Vorlauf ${formatLead(earliest[0].lead)}` : undefined}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 font-semibold">Früh ausgebucht</h3>
                  <HBars
                    items={earliest.map((x) => ({ label: slotShort(x.isodow, x.hour), value: x.lead!, display: formatLead(x.lead), sub: `${num(x.leadCount)}×` }))}
                    empty={`Noch kein Slot mit mindestens ${MIN_SLOT_BOOKINGS} Terminen.`}
                  />
                </div>
                <div>
                  <h3 className="mb-2 font-semibold">Kurzfristig gebucht</h3>
                  <HBars
                    items={shortNotice.map((x) => ({ label: slotShort(x.isodow, x.hour), value: x.lead!, display: formatLead(x.lead), sub: `${num(x.leadCount)}×` }))}
                    empty={`Noch kein Slot mit mindestens ${MIN_SLOT_BOOKINGS} Terminen.`}
                  />
                </div>
              </div>
            </Card>
          </div>

          <Card className="mb-6">
            <CardTitle>Vorlauf nach Wochentag und Uhrzeit</CardTitle>
            <p className="mb-3 text-sm text-muted">Median-Vorlauf je Slot (h = Stunden, T = Tage, W = Wochen). Dunkler = früher ausgebucht.</p>
            <HeatmapTable
              heat={leadHeat}
              caption={`Median-Vorlauf je Wochentag und Stunde, ${period.label}`}
              cell={(v) => formatLeadShort(v)}
              title={(v, d, h) => `${WEEKDAYS[d]}, ${h}–${h + 1} Uhr: ${v === null ? "keine Daten" : `Median-Vorlauf ${formatLead(v)}`}`}
              legend={["kurzfristig", "früh ausgebucht"]}
            />
          </Card>

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardTitle>Buchungswege</CardTitle>
              <p className="mb-3 text-sm text-muted">Termine ohne Absagen nach Quelle.</p>
              <HBars items={s.bySource.map((x) => ({ label: SOURCE[x.source] ?? x.source, value: x.count, display: `${num(x.count)} · ${pctDe(rate(x.count, s.booked))}` }))} />
              <ValuesTable
                caption="Termine nach Buchungsweg"
                open={open}
                head={["Buchungsweg", "Termine", "Anteil"]}
                rows={s.bySource.map((x) => [SOURCE[x.source] ?? x.source, num(x.count), pctDe(rate(x.count, s.booked))])}
                csv={csvOk ? { filename: file("termine-buchungswege"), rows: s.bySource.map((x) => [SOURCE[x.source] ?? x.source, x.count, num(rate(x.count, s.booked) ?? 0, 1)]) } : null}
              />
            </Card>
            <Card>
              <CardTitle>Absagen, No-Shows, Patient:innen</CardTitle>
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[15px]">
                <dt>Termine insgesamt gebucht</dt>
                <dd className="text-right tabular-nums">{num(s.total)}</dd>
                <dt>davon abgesagt</dt>
                <dd className="text-right tabular-nums">{num(s.cancelled)}</dd>
                <dt>erledigt</dt>
                <dd className="text-right tabular-nums">{num(s.done)}</dd>
                <dt>nicht erschienen</dt>
                <dd className="text-right tabular-nums">{num(s.noShow)}</dd>
                <dt>noch offen (geplant/bestätigt)</dt>
                <dd className="text-right tabular-nums">{num(s.booked - s.done - s.noShow)}</dd>
                <dt className="mt-2 border-t border-border pt-2">Patient:innen mit Termin</dt>
                <dd className="mt-2 border-t border-border pt-2 text-right tabular-nums">{num(s.patients.total)}</dd>
                <dt>davon neu (erster Termin/erste Behandlung der ganzen Praxis im Zeitraum)</dt>
                <dd className="text-right tabular-nums">{num(s.patients.new)}</dd>
                <dt>wiederkehrend</dt>
                <dd className="text-right tabular-nums">{num(s.patients.returning)}</dd>
              </dl>
              <p className="mt-3 text-sm text-muted">
                Absagequote = abgesagt ÷ alle gebuchten Termine. No-Show-Quote = nicht erschienen ÷ (erledigt + nicht erschienen). „Neu“ bezieht sich
                auf die ganze Praxis (auch beim Filter nach Behandler:in): erster nicht abgesagter Termin – auch ein nicht wahrgenommener – oder erste
                Behandlung liegt im Zeitraum. Nur Anzahlen – keine Namen.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
