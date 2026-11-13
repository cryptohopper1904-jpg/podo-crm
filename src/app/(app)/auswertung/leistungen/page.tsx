import Link from "next/link";
import { Badge, Card, CardTitle, Empty, PageHeader, Stat, Table, cx } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, money } from "@/lib/format";
import { WEEKDAYS, monthLabel, periodQuery, rankWeekdays, resolvePeriod } from "@/lib/stats";
import { statsDetailsOpen } from "@/lib/view-level";
import { salesStats } from "@/server/stats";
import { currentViewLevel } from "@/server/view-level";
import { Columns, HBars, KeyValue, ValuesTable } from "../charts";
import { StatsFilter, StatsTabs, yearOfPeriod } from "../stats-nav";

export const metadata = { title: "Auswertung – Leistungen & Produkte" };

const num = (v: number, digits = 0) => v.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
/** Euro für CSV (Komma, ohne Währungszeichen) */
const eur = (cents: number) => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
const TOP = 10;

export default async function StatsSalesPage(props: PageProps<"/auswertung/leistungen">) {
  const auth = await requireAuth("finance.read");
  const sp = await props.searchParams;
  const period = resolvePeriod(sp, berlinDateIso());
  const [s, level] = await Promise.all([salesStats(auth, period), currentViewLevel()]);
  const open = statsDetailsOpen(level);
  const csvOk = !auth.support;
  const file = (name: string) => `${name}-${period.from}-bis-${period.to}.csv`;

  const byQty = [...s.services].filter((x) => x.quantity > 0).sort((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents).slice(0, TOP);
  const byRevenue = s.services.filter((x) => x.totalCents > 0).slice(0, TOP);
  const sold = s.products.filter((p) => p.soldQty > 0).sort((a, b) => b.soldCents - a.soldCents || b.soldQty - a.soldQty);
  const used = s.products.filter((p) => p.usedQty > 0).sort((a, b) => b.usedQty - a.usedQty || b.usedCents - a.usedCents);
  const productCents = s.products.reduce((sum, p) => sum + p.soldCents + p.usedCents, 0);
  const serviceCents = s.services.reduce((sum, x) => sum + x.totalCents, 0);
  const days = rankWeekdays(s.revenueWeekdays, s.weekdayOccurrences);
  const bestDay = days[0];
  const reorder = s.stock.filter((x) => x.reorder);
  const bestMonthIdx = s.revenueMonths.reduce((best, v, i, arr) => (v > arr[best] ? i : best), 0);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Auswertung" subtitle="Leistungen, Produkte und Umsatz im Zeitraum" />
      <StatsTabs active="leistungen" statsQuery={periodQuery(period)} year={yearOfPeriod(period)} />
      <StatsFilter action="/auswertung/leistungen" period={period} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Umsatz (Zahlungseingang)" value={money(s.revenueTotal)} tone="primary" sub="wie unter „Finanzen“ (Zuflussprinzip)" />
        <Stat label="Leistungen abgerechnet" value={money(serviceCents)} tone="info" sub={`${num(s.services.reduce((sum, x) => sum + x.quantity, 0), 1)} Positionen`} />
        <Stat label="Produkte abgerechnet" value={money(productCents)} tone="neutral" sub={`${num(sold.length)} verkauft · ${num(used.length)} angewendet (Artikel)`} />
        <Stat
          label="Nachbestellen"
          value={num(reorder.length)}
          tone={reorder.length ? "warn" : "neutral"}
          sub={
            reorder.length ? (
              <Link href="/produkte/nachbestellen" className="underline">
                Artikel unter Mindestbestand
              </Link>
            ) : (
              "kein Artikel unter Mindestbestand"
            )
          }
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Umsatz je Wochentag</CardTitle>
          <p className="mb-3 text-sm text-muted">Ø Zahlungseingang je Kalendertag (Berliner Ortszeit). Überweisungen zählen am Tag des Eingangs.</p>
          <Columns
            label="Durchschnittlicher Umsatz je Wochentag"
            items={days
              .slice()
              .sort((a, b) => a.index - b.index)
              .map((d) => ({ label: d.label.slice(0, 2), value: d.perDay, display: money(Math.round(d.perDay)), strong: d === bestDay }))}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <KeyValue label="Stärkster Umsatztag" value={bestDay?.total ? bestDay.label : "–"} hint={bestDay?.total ? `Ø ${money(Math.round(bestDay.perDay))}` : undefined} />
            <KeyValue label="Summe im Zeitraum" value={money(s.revenueTotal)} />
          </div>
          <ValuesTable
            caption="Umsatz je Wochentag"
            open={open}
            head={["Wochentag", "Umsatz", "Tage im Zeitraum", "Ø je Tag"]}
            rows={WEEKDAYS.map((w, i) => [w, money(s.revenueWeekdays[i]), num(s.weekdayOccurrences[i]), money(s.weekdayOccurrences[i] ? Math.round(s.revenueWeekdays[i] / s.weekdayOccurrences[i]) : 0)])}
            csv={csvOk ? { filename: file("umsatz-wochentage"), rows: WEEKDAYS.map((w, i) => [w, eur(s.revenueWeekdays[i]), s.weekdayOccurrences[i], eur(s.weekdayOccurrences[i] ? Math.round(s.revenueWeekdays[i] / s.weekdayOccurrences[i]) : 0)]) } : null}
          />
        </Card>
        <Card>
          <CardTitle>Umsatz je Monat</CardTitle>
          <p className="mb-3 text-sm text-muted">Zahlungseingänge; auf Sammelrechnungen angerechnete Quittungen und Anzahlungen zählen nur einmal.</p>
          <Columns
            label="Umsatz je Monat"
            items={s.months.map((m, i) => ({ label: monthLabel(m), value: s.revenueMonths[i], display: money(s.revenueMonths[i]), strong: i === bestMonthIdx && s.revenueMonths[i] > 0 }))}
          />
          <ValuesTable
            caption="Umsatz je Monat"
            open={open}
            head={["Monat", "Umsatz"]}
            rows={s.months.map((m, i) => [monthLabel(m), money(s.revenueMonths[i])])}
            csv={csvOk ? { filename: file("umsatz-monate"), rows: s.months.map((m, i) => [m, eur(s.revenueMonths[i])]) } : null}
          />
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Top-Leistungen nach Umsatz</CardTitle>
          <p className="mb-3 text-sm text-muted">Rechnungspositionen brutto nach Rechnungsdatum, ohne Entwürfe, Stornos und Anzahlungen; angerechnete Quittungen nur einmal.</p>
          <HBars items={byRevenue.map((x) => ({ label: x.name, value: x.totalCents, display: money(x.totalCents), sub: `${num(x.quantity, 1)}×` }))} />
        </Card>
        <Card>
          <CardTitle>Top-Leistungen nach Anzahl</CardTitle>
          <p className="mb-3 text-sm text-muted">Abgerechnete Menge; dahinter, wie oft die Leistung in Terminen (ohne Absagen) gebucht war.</p>
          <HBars items={byQty.map((x) => ({ label: x.name, value: x.quantity, display: `${num(x.quantity, 1)}×`, sub: `${num(x.bookedCount, 1)}× gebucht` }))} />
        </Card>
      </div>
      {s.services.length ? (
        <Card className="mb-6">
          <CardTitle>Alle Leistungen</CardTitle>
          <ValuesTable
            caption="Leistungen im Zeitraum"
            open={open}
            head={["Leistung", "abgerechnet (Menge)", "Umsatz", "in Terminen gebucht"]}
            rows={s.services.map((x) => [x.name, num(x.quantity, 2), money(x.totalCents), num(x.bookedCount, 2)])}
            csv={csvOk ? { filename: file("leistungen"), rows: s.services.map((x) => [x.name, num(x.quantity, 2), eur(x.totalCents), num(x.bookedCount, 2)]) } : null}
          />
        </Card>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Produkte verkauft</CardTitle>
          <p className="mb-3 text-sm text-muted">Verkaufte Produkte (Rechnung/Quittung), Umsatz brutto.</p>
          <HBars items={sold.slice(0, TOP).map((p) => ({ label: p.name, value: p.soldCents, display: money(p.soldCents), sub: `${num(p.soldQty, 1)} Stk.` }))} empty="Keine Produktverkäufe im Zeitraum" />
        </Card>
        <Card>
          <CardTitle>In der Behandlung angewendet</CardTitle>
          <p className="mb-3 text-sm text-muted">Produkte, die als Teil der Behandlung abgerechnet wurden (nach Menge).</p>
          <HBars items={used.slice(0, TOP).map((p) => ({ label: p.name, value: p.usedQty, display: `${num(p.usedQty, 1)} Stk.`, sub: money(p.usedCents) }))} empty="Keine angewendeten Produkte im Zeitraum" />
        </Card>
      </div>
      {s.products.length ? (
        <Card className="mb-6">
          <CardTitle>Alle Produkte</CardTitle>
          <ValuesTable
            caption="Produkte im Zeitraum"
            open={open}
            head={["Produkt", "verkauft (Menge)", "Umsatz verkauft", "angewendet (Menge)", "Umsatz angewendet"]}
            rows={s.products.map((p) => [p.name, num(p.soldQty, 2), money(p.soldCents), num(p.usedQty, 2), money(p.usedCents)])}
            csv={csvOk ? { filename: file("produkte"), rows: s.products.map((p) => [p.name, num(p.soldQty, 2), eur(p.soldCents), num(p.usedQty, 2), eur(p.usedCents)]) } : null}
          />
        </Card>
      ) : null}

      <Card>
        <CardTitle action={<Link href="/produkte/bestand" className="inline-flex min-h-11 items-center text-sm font-semibold text-primary">Zum Bestand</Link>}>Lager: Reichweite und Umschlag</CardTitle>
        <p className="mb-3 text-sm text-muted">
          Artikel mit Bestandsführung. Abgang = Verkauf (abzgl. Storno), Eigenverbrauch und Bruch im Zeitraum. Reichweite = Tage, bis der heutige Bestand beim bisherigen
          Tempo aufgebraucht ist; Umschlag = Abgang aufs Jahr gerechnet ÷ heutiger Bestand.
        </p>
        {s.stock.length === 0 ? (
          <Empty title="Keine Artikel mit Bestandsführung">Bestandsführung lässt sich je Produkt unter „Produkte“ einschalten.</Empty>
        ) : (
          <details open={open || reorder.length > 0}>
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">{`${num(s.stock.length)} Artikel anzeigen`}</summary>
            <Table>
              <caption className="sr-only">Lager: Bestand, Abgang, Reichweite und Umschlag</caption>
              <thead>
                <tr>
                  <th scope="col">Artikel</th>
                  <th scope="col" className="text-right">Bestand</th>
                  <th scope="col" className="text-right">Mindestbestand</th>
                  <th scope="col" className="text-right">Abgang</th>
                  <th scope="col" className="text-right">Reichweite</th>
                  <th scope="col" className="text-right">Umschlag/Jahr</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {s.stock.map((x) => (
                  <tr key={`${x.name}-${x.unit}-${x.minStock}`}>
                    <th scope="row" className="!bg-transparent !text-[15px] !font-normal !normal-case !tracking-normal !text-text">{x.name}</th>
                    <td className={cx("text-right tabular-nums", x.stock < 0 && "text-danger")}>{`${num(x.stock)} ${x.unit}`}</td>
                    <td className="text-right tabular-nums">{num(x.minStock)}</td>
                    <td className="text-right tabular-nums">{num(x.outflow)}</td>
                    <td className="text-right tabular-nums">{x.coverageDays === null ? "–" : `${num(x.coverageDays)} Tage`}</td>
                    <td className="text-right tabular-nums">{x.turnoverPerYear === null ? "–" : `${num(x.turnoverPerYear, 1)}×`}</td>
                    <td>{x.reorder ? <Badge tone="warn">nachbestellen</Badge> : <Badge>ok</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        )}
      </Card>
    </div>
  );
}
