import Link from "next/link";
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardTitle, Empty, PageHeader, Stat, Table, cx } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { monthlyShare, percentChange } from "@/lib/invoice-math";
import { financeOverview } from "@/server/finance";
import { deleteFixedCostAction } from "./actions";
import { FixedCostForm, MaterialCostForm } from "./finance-forms";
import { StatsTabs, statsQueryForYear } from "./stats-nav";

export const metadata = { title: "Auswertung" };

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const INTERVAL: Record<string, string> = { monthly: "monatlich", quarterly: "vierteljährlich", yearly: "jährlich" };

function Change({ current, previous }: { current: number; previous: number }) {
  const pct = percentChange(current, previous);
  if (pct === null) return <>kein Vorjahreswert</>;
  return <>{pct >= 0 ? "+" : ""}{pct.toLocaleString("de-DE")} % zum Vorjahr</>;
}

/** Einfaches Balkendiagramm (CSS), Werte zusätzlich als Tabelle für Screenreader. */
function BarChart({
  label,
  current,
  previous,
  year,
  format,
}: {
  label: string;
  current: number[];
  previous: number[];
  year: number;
  format: (n: number) => string;
}) {
  const max = Math.max(1, ...current, ...previous);
  return (
    <figure>
      <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted" aria-hidden>
        <span className="inline-flex items-center gap-2"><span className="size-3 rounded-sm bg-primary" /> {year}</span>
        <span className="inline-flex items-center gap-2"><span className="size-3 rounded-sm bg-border-strong" /> {year - 1}</span>
      </div>
      <div className="flex h-52 items-end gap-1 overflow-x-auto sm:gap-2" aria-hidden>
        {MONTHS.map((m, i) => (
          <div key={m} className="flex h-full min-w-7 flex-1 flex-col items-center justify-end gap-1">
            <div className="flex h-full w-full items-end justify-center gap-0.5">
              <div
                className="w-1/2 max-w-5 rounded-t bg-border-strong"
                style={{ height: `${(previous[i] / max) * 100}%` }}
                title={`${m} ${year - 1}: ${format(previous[i])}`}
              />
              <div
                className="w-1/2 max-w-5 rounded-t bg-primary"
                style={{ height: `${(current[i] / max) * 100}%` }}
                title={`${m} ${year}: ${format(current[i])}`}
              />
            </div>
            <span className="text-[11px] text-muted">{m}</span>
          </div>
        ))}
      </div>
      <figcaption className="sr-only">{label}</figcaption>
      <details className="mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">Werte als Tabelle</summary>
        <Table>
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              <th scope="col">Monat</th>
              <th scope="col" className="text-right">{year}</th>
              <th scope="col" className="text-right">{year - 1}</th>
            </tr>
          </thead>
          <tbody>
            {MONTHS.map((m, i) => (
              <tr key={m}>
                <th scope="row" className="!bg-transparent !text-[15px] !font-normal !normal-case !tracking-normal !text-text">{m}</th>
                <td className="text-right tabular-nums">{format(current[i])}</td>
                <td className="text-right tabular-nums">{format(previous[i])}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </figure>
  );
}

export default async function FinancePage(props: PageProps<"/auswertung">) {
  const auth = await requireAuth("finance.read");
  const sp = await props.searchParams;
  const today = berlinDateIso();
  const currentYear = Number(today.slice(0, 4));
  const y = Number(sp.year);
  const year = Number.isInteger(y) && y >= 2000 && y <= currentYear + 1 ? y : currentYear;
  const editId = typeof sp.edit === "string" ? sp.edit : null;
  const d = await financeOverview(auth, year);
  const canManage = auth.can("settings.manage");
  const editCost = editId ? d.costs.find((c) => c.id === editId) : undefined;
  const serviceMax = Math.max(1, ...d.byService.map((s) => s.totalCents));
  const selfHref = { pathname: "/auswertung", query: { year } };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Auswertung"
        subtitle="Umsatz = eingegangene Zahlungen (Zuflussprinzip)"
        actions={
          <nav aria-label="Jahr wählen" className="flex items-center gap-1">
            <Link href={{ pathname: "/auswertung", query: { year: year - 1 } }} aria-label="Vorjahr" className="inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2">
              <ChevronLeft size={18} aria-hidden />
            </Link>
            <span className="min-w-16 text-center font-display text-xl font-semibold tabular-nums">{year}</span>
            {year < currentYear ? (
              <Link href={{ pathname: "/auswertung", query: { year: year + 1 } }} aria-label="Folgejahr" className="inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2">
                <ChevronRight size={18} aria-hidden />
              </Link>
            ) : (
              <span className="size-11" />
            )}
          </nav>
        }
      />
      <StatsTabs active="finanzen" statsQuery={statsQueryForYear(year, currentYear)} year={year} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Umsatz ${year}`} value={money(d.revenueYear)} tone="primary" sub={<Change current={d.revenueYear} previous={d.revenuePrev} />} />
        <Stat label={`Behandlungen ${year}`} value={d.treatmentsYear.toLocaleString("de-DE")} tone="info" sub={<Change current={d.treatmentsYear} previous={d.treatmentsPrev} />} />
        <Stat label="Ø Umsatz je Behandlung" value={money(d.avgRevenuePerTreatment)} tone="neutral" />
        <Stat
          label="Offene Forderungen"
          value={money(d.receivables.openCents)}
          tone={d.receivables.openCents > 0 ? "accent" : "neutral"}
          sub={
            <Link href="/rechnungen?filter=open" className="underline">
              {d.receivables.count} Rechnungen{d.receivables.overdueCents > 0 ? `, davon ${money(d.receivables.overdueCents)} überfällig` : ""}
            </Link>
          }
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Umsatz pro Monat</CardTitle>
          <BarChart label={`Umsatz pro Monat ${year} im Vergleich zu ${year - 1}`} current={d.revenueMonths} previous={d.revenuePrevMonths} year={year} format={money} />
        </Card>
        <Card>
          <CardTitle>Behandlungen pro Monat</CardTitle>
          <BarChart
            label={`Behandlungen pro Monat ${year} im Vergleich zu ${year - 1}`}
            current={d.treatmentMonths}
            previous={d.treatmentPrevMonths}
            year={year}
            format={(n) => n.toLocaleString("de-DE")}
          />
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardTitle>Umsatz nach Leistung ({year})</CardTitle>
          <p className="mb-3 text-sm text-muted">Rechnungsbeträge brutto nach Rechnungsdatum, ohne stornierte Rechnungen.</p>
          {d.byService.length === 0 ? (
            <Empty title="Noch keine Rechnungen in diesem Jahr" />
          ) : (
            <ul className="flex flex-col gap-3">
              {d.byService.map((s) => (
                <li key={s.name}>
                  <div className="flex justify-between gap-3 text-[15px]">
                    <span className="min-w-0 truncate">{s.name} <span className="text-sm text-muted">· {s.quantity.toLocaleString("de-DE")}×</span></span>
                    <span className="font-semibold tabular-nums">{money(s.totalCents)}</span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-surface-2" aria-hidden>
                    <div className="h-2 rounded-full bg-primary" style={{ width: `${(s.totalCents / serviceMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Break-even</CardTitle>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[15px]">
            <dt>Fixkosten pro Monat</dt>
            <dd className="text-right font-semibold tabular-nums">{money(d.fixedMonthlyCents)}</dd>
            <dt>Ø Umsatz je Behandlung</dt>
            <dd className="text-right tabular-nums">{money(d.avgRevenuePerTreatment)}</dd>
            <dt>− Materialkosten je Behandlung</dt>
            <dd className="text-right tabular-nums">{money(d.materialCostCents)}</dd>
            <dt>= Deckungsbeitrag je Behandlung</dt>
            <dd className="text-right tabular-nums">{money(d.avgRevenuePerTreatment - d.materialCostCents)}</dd>
          </dl>
          <div className="mt-4 rounded-xl bg-primary-soft p-4 text-primary-soft-text">
            {d.breakEven === null ? (
              <p className="font-semibold">Noch keine Berechnung möglich – es fehlen Umsätze/Behandlungen oder der Deckungsbeitrag ist nicht positiv.</p>
            ) : (
              <>
                <p className="text-sm">Benötigte Behandlungen pro Monat</p>
                <p className="font-display text-4xl font-bold tabular-nums">{d.breakEven.toLocaleString("de-DE")}</p>
                <p className="mt-1 text-sm">
                  Aktuell Ø {d.avgTreatmentsPerMonth.toLocaleString("de-DE")} pro Monat
                  {d.avgTreatmentsPerMonth ? (d.avgTreatmentsPerMonth >= d.breakEven ? " – Fixkosten gedeckt." : " – unter dem Break-even.") : "."}
                </p>
              </>
            )}
          </div>
          {canManage ? (
            <div className="mt-4">
              <MaterialCostForm cents={d.materialCostCents} />
            </div>
          ) : null}
        </Card>
      </div>

      <Card>
        <CardTitle>Fixkosten</CardTitle>
        {d.costs.length === 0 ? (
          <Empty title="Noch keine Fixkosten erfasst">Miete, Versicherungen, Software, Leasing … – für den Break-even.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th className="text-right">Betrag</th>
                <th>Intervall</th>
                <th className="text-right">pro Monat</th>
                <th>ab</th>
                <th>Status</th>
                {canManage ? <th><span className="sr-only">Aktionen</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {d.costs.map((c) => (
                <tr key={c.id} className={cx(!c.active && "text-muted")}>
                  <td>
                    <span className="font-semibold">{c.category}</span>
                    {c.note ? <span className="block text-sm text-muted">{c.note}</span> : null}
                  </td>
                  <td className="text-right tabular-nums">{money(c.amountCents)}</td>
                  <td className="text-sm">{INTERVAL[c.interval] ?? c.interval}</td>
                  <td className="text-right tabular-nums">{money(monthlyShare(c.amountCents, c.interval))}</td>
                  <td className="text-sm tabular-nums">{dateDe(c.startDate)}</td>
                  <td>{c.active ? <Badge tone="primary">aktiv</Badge> : <Badge>inaktiv</Badge>}</td>
                  {canManage ? (
                    <td>
                      <div className="flex justify-end gap-1">
                        <Link
                          href={{ pathname: "/auswertung", query: { year, edit: c.id } }}
                          aria-label={`${c.category} bearbeiten`}
                          className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-surface-2"
                        >
                          <Pencil size={18} aria-hidden />
                        </Link>
                        <form action={deleteFixedCostAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" variant="ghost" aria-label={`${c.category} löschen`} className="px-3">
                            <Trash2 size={18} aria-hidden />
                          </Button>
                        </form>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {canManage ? (
          <div className="mt-6 border-t border-border pt-5">
            <h3 className="mb-3 font-semibold">{editCost ? `„${editCost.category}“ bearbeiten` : "Neue Fixkosten"}</h3>
            <FixedCostForm cost={editCost} today={today} cancelHref={`/auswertung?year=${selfHref.query.year}`} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
