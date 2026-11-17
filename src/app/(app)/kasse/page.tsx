import Link from "next/link";
import { FileDown, FileText } from "lucide-react";
import { Badge, Button, Card, CardTitle, Empty, Field, Input, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, dateTimeDe, money, timeDe } from "@/lib/format";
import { addDaysIso } from "@/lib/invoice-math";
import { PAYMENT_METHOD_LABEL } from "@/lib/invoice-labels";
import { MOVEMENT_LABEL } from "@/lib/kasse/labels";
import { exportRangeInput, externalRegisterEntries, kasseOverview, NO_TSE_NOTE } from "@/server/kasse";
import { fiscalLiveBlockedReason } from "@/integrations/tse";
import { CloseDayForm, ExternalRegisterForm, MovementForm } from "./kasse-forms";

export const metadata = { title: "Kasse" };

const METHODS = [
  ["cash", "Bar"],
  ["card", "Karte"],
  ["transfer", "Überweisung"],
  ["voucher", "Gutschein"],
] as const;

const VERMERK_METHODS = [
  ["cash", "Bar"],
  ["card", "Karte"],
  ["voucher", "Gutschein"],
] as const;

export default async function KassePage(props: PageProps<"/kasse">) {
  const auth = await requireAuth("cash.read");
  const data = await kasseOverview(auth);
  const ext = data.externalRegister;
  const { open, calc } = data;
  const canWrite = auth.can("cash.write");
  const by = calc.totals.byMethod;
  const other = by.payment_link ?? 0;
  const expectedWithoutOpening = calc.cashPaymentsCents + calc.movementsCents;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Kasse"
        subtitle={
          data.lastClosing
            ? `Letzter Abschluss: Z-Bon Nr. ${data.lastClosing.number} vom ${dateDe(data.lastClosing.businessDate)}`
            : "Noch kein Tagesabschluss"
        }
        actions={
          auth.can("cash.export") && !ext ? (
            <LinkButton href="/kasse/export" variant="secondary">
              <FileDown size={18} aria-hidden /> DSFinV-K-Export
            </LinkButton>
          ) : undefined
        }
      />

      <section aria-label="Kassensystem" className="mb-6 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
        {ext ? (
          <p>
            <strong>Eigene Praxiskasse aktiv{data.externalRegisterInfo ? ` (${data.externalRegisterInfo})` : ""}.</strong> Bar-, Karten- und
            Gutscheinzahlungen werden in PodoHero nur an der Rechnung vermerkt – ohne TSE-Signatur, ohne Kassenbeleg und ohne
            Tagesabschluss. Erfassen Sie jede Zahlung <strong>zuerst in der Praxiskasse</strong> und vermerken Sie sie danach in PodoHero
            (mit der Bon-Nr. der Praxiskasse). Beleg, TSE, Kassenbuch und Tagesabschluss kommen aus Ihrer Praxiskasse.
          </p>
        ) : (
          <p>
            <strong>Nutzen Sie bereits eine eigene Kasse mit TSE?</strong> Dann kann PodoHero Zahlungen nur vermerken; Beleg, TSE und
            Tagesabschluss bleiben in Ihrer Praxiskasse. Umschalten geht nur, wenn alle PodoHero-Kassenvorgänge abgeschlossen sind
            (Tagesabschluss).
          </p>
        )}
        {auth.can("settings.manage") && !auth.support ? <ExternalRegisterForm active={ext} /> : null}
      </section>

      {fiscalLiveBlockedReason() && !ext ? (
        <p className="mb-6 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
          <strong>Echtbetrieb der TSE gesperrt.</strong> {fiscalLiveBlockedReason()}
        </p>
      ) : null}
      {data.tseMode === "none" && !ext ? (
        <p className="mb-6 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text" role="note">
          <strong>Keine TSE angebunden.</strong> Abschlüsse werden als „{NO_TSE_NOTE}“ gekennzeichnet. Wer Bargeld mit einem
          elektronischen Aufzeichnungssystem erfasst, braucht eine zertifizierte TSE und muss die Kasse beim Finanzamt melden – bitte mit der
          Steuerberatung abstimmen (siehe Hilfe „Kasse“).
        </p>
      ) : null}

      {ext ? (
        <ExternalRegisterSection auth={auth} searchParams={await props.searchParams} active />
      ) : (
        <>
      <h2 className="mb-3 font-display text-xl font-semibold">Offene Einnahmen (noch nicht abgeschlossen)</h2>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {METHODS.map(([m, label]) => (
          <Stat key={m} label={label} value={money(by[m] ?? 0)} tone={m === "cash" ? "primary" : "info"} sub={m === "transfer" ? "nicht kassenrelevant" : undefined} />
        ))}
      </div>
      {other ? <p className="mb-6 text-sm text-muted">Zusätzlich per Zahlungslink: {money(other)} (nicht kassenrelevant).</p> : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Kassenbestand (Bargeld)</CardTitle>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[15px] tabular-nums">
            <dt>Anfangsbestand</dt>
            <dd className="text-right">{data.needsOpening ? "beim ersten Abschluss erfassen" : money(data.openingCents)}</dd>
            <dt>+ Bareinnahmen</dt>
            <dd className="text-right">{money(calc.cashPaymentsCents)}</dd>
            <dt>± Einlagen/Entnahmen</dt>
            <dd className="text-right">{money(calc.movementsCents)}</dd>
            <dt className="font-semibold">= Soll-Bestand</dt>
            <dd className="text-right font-semibold">{money(data.openingCents + expectedWithoutOpening)}</dd>
          </dl>
          {calc.totals.byVat.length ? (
            <div className="mt-4 text-sm text-muted">
              Umsätze an der Kasse je Steuersatz:{" "}
              {calc.totals.byVat.map((v) => `${v.rate} %: ${money(v.grossCents)} (USt ${money(v.vatCents)})`).join(" · ")}
            </div>
          ) : null}
        </Card>
        <Card>
          <CardTitle>Einlagen / Entnahmen</CardTitle>
          {open.movements.length ? (
            <ul className="mb-4 divide-y divide-border text-[15px]">
              {open.movements.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span className="font-medium">{MOVEMENT_LABEL[m.kind]}</span> <span className="text-muted">· {m.reason} · {timeDe(m.occurredAt)}</span>
                  </span>
                  <span className="tabular-nums">{money(m.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-muted">Noch keine Einlagen/Entnahmen seit dem letzten Abschluss.</p>
          )}
          {canWrite ? <MovementForm /> : null}
        </Card>
      </div>

      <h2 className="mb-3 font-display text-xl font-semibold">Zahlungen seit dem letzten Abschluss</h2>
      {open.payments.length ? (
        <div className="mb-6">
          <Table>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Rechnung</th>
                <th>Zahlart</th>
                <th>TSE</th>
                <th className="text-right">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {open.payments.map((p) => (
                <tr key={p.id}>
                  <td>{dateTimeDe(p.paidAt)}</td>
                  <td>{p.invoiceNumber ?? "–"}</td>
                  <td>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</td>
                  <td>{p.externalRef?.startsWith("tse:test:") ? <Badge tone="warn">Test</Badge> : p.externalRef?.startsWith("tse:") ? <Badge tone="primary">signiert</Badge> : "–"}</td>
                  <td className="text-right tabular-nums">{money(p.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : (
        <div className="mb-6">
          <Empty title="Keine offenen Zahlungen">Zahlungen entstehen in den Rechnungen (Bar, Karte, Gutschein, Überweisung).</Empty>
        </div>
      )}

        </>
      )}

      {!ext && data.firstExternalDate ? (
        <details className="mb-8 rounded-xl border border-border bg-surface px-4 py-3">
          <summary className="cursor-pointer font-display text-lg font-semibold">Frühere Kassenvermerke (eigene Praxiskasse)</summary>
          <div className="mt-4">
            <ExternalRegisterSection auth={auth} searchParams={await props.searchParams} active={false} defaultFrom={data.firstExternalDate} />
          </div>
        </details>
      ) : null}

      {canWrite && !ext ? (
        <section className="mb-8" aria-labelledby="abschluss">
          <h2 id="abschluss" className="mb-3 font-display text-xl font-semibold">Tagesabschluss</h2>
          {data.closedToday ? (
            <p className="mb-4 rounded-xl bg-primary-soft px-4 py-3 text-sm text-primary-soft-text">
              Heute ist bereits abgeschlossen. Spätere Zahlungen gehen in den nächsten Abschluss.
            </p>
          ) : (
            <CloseDayForm
              today={data.today}
              minDate={data.lastClosing?.businessDate ?? null}
              expectedWithoutOpeningCents={expectedWithoutOpening}
              openingCents={data.openingCents}
              needsOpening={data.needsOpening}
            />
          )}
        </section>
      ) : null}

      <h2 className="mb-3 font-display text-xl font-semibold">{ext ? "Frühere PodoHero-Abschlüsse" : "Abschlüsse"}</h2>
      {ext && data.recent.length && auth.can("cash.export") ? (
        <p className="mb-3 text-sm text-muted">
          Aufbewahrungspflichtig wie bisher – Export früherer PodoHero-Abschlüsse: <Link href="/kasse/export" className="font-semibold text-primary hover:underline">DSFinV-K-Export</Link>
        </p>
      ) : null}
      {data.recent.length ? (
        <Table>
          <thead>
            <tr>
              <th>Z-Nr.</th>
              <th>Buchungstag</th>
              <th className="text-right">Bar</th>
              <th className="text-right">Karte</th>
              <th className="text-right">Gezählt</th>
              <th className="text-right">Differenz</th>
              <th>TSE</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.recent.map((z) => (
              <tr key={z.id}>
                <td className="font-semibold">
                  <Link href={`/kasse/abschluss/${z.id}`} className="hover:underline">{z.number}</Link>
                </td>
                <td>{dateDe(z.businessDate)}</td>
                <td className="text-right tabular-nums">{money(z.totals.byMethod.cash ?? 0)}</td>
                <td className="text-right tabular-nums">{money(z.totals.byMethod.card ?? 0)}</td>
                <td className="text-right tabular-nums">{money(z.countedCashCents)}</td>
                <td className="text-right tabular-nums">{z.differenceCents ? <Badge tone="accent">{money(z.differenceCents)}</Badge> : money(0)}</td>
                <td>{z.tse.mode === "fiskaly" ? <Badge tone="primary">TSE</Badge> : <Badge tone="warn">ohne TSE</Badge>}</td>
                <td>
                  <a href={`/api/kasse/z-bon/${z.id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline" target="_blank" rel="noopener">
                    <FileText size={16} aria-hidden /> PDF
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <Empty title="Noch keine Abschlüsse" />
      )}
    </div>
  );
}

/**
 * Eigene Praxiskasse: keine zweite Kasse in PodoHero – stattdessen die Kassenvermerke (in PodoHero vermerkte Zahlungen
 * der Praxiskasse) mit Tagessumme je Zahlart als Abgleichhilfe zum Z-Bon der Praxiskasse, plus CSV.
 */
async function ExternalRegisterSection({
  auth,
  searchParams,
  active,
  defaultFrom,
}: {
  auth: Awaited<ReturnType<typeof requireAuth>>;
  searchParams: Record<string, string | string[] | undefined>;
  /** eigene Praxiskasse aktiv (sonst: frühere Vermerke nach dem Zurückschalten, ohne SumUp-Hinweis) */
  active: boolean;
  /** Vorgabe „Von“ (frühere Vermerke: erster Vermerk, höchstens drei Jahre zurück) */
  defaultFrom?: string;
}) {
  const today = berlinDateIso();
  const earliest = addDaysIso(today, -3 * 365);
  const fallbackFrom = defaultFrom ? (defaultFrom < earliest ? earliest : defaultFrom) : today;
  const from = typeof searchParams.from === "string" ? searchParams.from : fallbackFrom;
  const to = typeof searchParams.to === "string" ? searchParams.to : today;
  const range = exportRangeInput.safeParse({ from, to });
  const list = range.success ? await externalRegisterEntries(auth, range.data.from, range.data.to) : null;
  const csvHref = range.success ? `/api/kasse/kassenvermerke?from=${range.data.from}&to=${range.data.to}` : null;
  return (
    <section className={active ? "mb-8" : ""} aria-labelledby={active ? "kassenvermerke" : undefined} aria-label={active ? undefined : "Frühere Kassenvermerke"}>
      {active ? (
        <p className="mb-6 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text" role="note">
          <strong>SumUp:</strong> Kartenzahlungen am SumUp-Terminal über die PodoHero-Anbindung bucht PodoHero nur als Vermerk. Sie müssen <strong>zusätzlich in der Praxiskasse</strong> als Kartenzahlung erfasst werden – für jeden Eingang erscheint eine
          Meldung im Posteingang.
        </p>
      ) : null}
      {active ? <h2 id="kassenvermerke" className="mb-3 font-display text-xl font-semibold">Kassenvermerke</h2> : null}
      <p className="mb-4 text-sm text-muted">
        In PodoHero vermerkte Bar-, Karten- und Gutscheinzahlungen, die in der Praxiskasse erfasst sind. Die Tagessummen je Zahlart helfen
        beim Abgleich mit dem Z-Bon der Praxiskasse.
      </p>
      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <Field label="Von">
          <Input type="date" name="from" defaultValue={from} max={today} required />
        </Field>
        <Field label="Bis">
          <Input type="date" name="to" defaultValue={to} max={today} required />
        </Field>
        <Button type="submit" variant="secondary">Anzeigen</Button>
        {csvHref && auth.can("cash.export") && list?.entries.length ? (
          <a href={csvHref} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 font-semibold hover:bg-surface-2">
            <FileDown size={18} aria-hidden /> CSV herunterladen
          </a>
        ) : null}
      </form>
      {!range.success ? (
        <p className="text-sm text-danger" role="alert">{range.error.issues[0]?.message ?? "Zeitraum ungültig."}</p>
      ) : list && list.entries.length ? (
        <>
          <div className="mb-4">
            <Table>
              <thead>
                <tr>
                  <th>Tag</th>
                  {VERMERK_METHODS.map(([, label]) => (
                    <th key={label} className="text-right">{label}</th>
                  ))}
                  <th className="text-right">Summe</th>
                </tr>
              </thead>
              <tbody>
                {list.days.map((d) => (
                  <tr key={d.date}>
                    <td className="font-semibold">{dateDe(d.date)}</td>
                    {VERMERK_METHODS.map(([m]) => (
                      <td key={m} className="text-right tabular-nums">{money(d.byMethod[m] ?? 0)}</td>
                    ))}
                    <td className="text-right font-semibold tabular-nums">{money(d.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <Table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Rechnung</th>
                <th>Zahlart</th>
                <th className="text-right">Betrag</th>
                <th>Bon-Nr. Praxiskasse</th>
              </tr>
            </thead>
            <tbody>
              {list.entries.map((e) => (
                <tr key={e.id}>
                  <td>{dateTimeDe(e.paidAt)}</td>
                  <td>
                    <Link href={`/rechnungen/${e.invoiceId}`} className="hover:underline">{e.invoiceNumber ?? "–"}</Link>
                  </td>
                  <td>
                    {PAYMENT_METHOD_LABEL[e.method] ?? e.method}
                    {e.viaSumup ? <> <Badge tone="warn">SumUp</Badge></> : null}
                  </td>
                  <td className="text-right tabular-nums">{money(e.amountCents)}</td>
                  <td>{e.bonNr ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {list.truncated ? <p className="mt-2 text-sm text-muted">Nur die ersten 5000 Einträge – bitte den Zeitraum verkleinern.</p> : null}
        </>
      ) : (
        <Empty title="Keine Kassenvermerke im Zeitraum">Vermerke entstehen beim Erfassen von Bar-, Karten- und Gutscheinzahlungen an der Rechnung.</Empty>
      )}
    </section>
  );
}
