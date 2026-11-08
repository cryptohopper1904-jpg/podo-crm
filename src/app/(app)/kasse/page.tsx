import Link from "next/link";
import { FileDown, FileText } from "lucide-react";
import { Badge, Card, CardTitle, Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, money, timeDe } from "@/lib/format";
import { PAYMENT_METHOD_LABEL } from "@/lib/invoice-labels";
import { MOVEMENT_LABEL } from "@/lib/kasse/labels";
import { kasseOverview, NO_TSE_NOTE } from "@/server/kasse";
import { CloseDayForm, MovementForm } from "./kasse-forms";

export const metadata = { title: "Kasse" };

const METHODS = [
  ["cash", "Bar"],
  ["card", "Karte"],
  ["transfer", "Überweisung"],
  ["voucher", "Gutschein"],
] as const;

export default async function KassePage() {
  const auth = await requireAuth("invoices.read");
  const data = await kasseOverview(auth);
  const { open, calc } = data;
  const canWrite = auth.can("invoices.write");
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
          <LinkButton href="/kasse/export" variant="secondary">
            <FileDown size={18} aria-hidden /> DSFinV-K-Export
          </LinkButton>
        }
      />

      {data.tseMode === "none" ? (
        <p className="mb-6 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn-soft-text" role="note">
          <strong>Keine TSE angebunden.</strong> Abschlüsse werden als „{NO_TSE_NOTE}“ gekennzeichnet. Wer Bargeld mit einem
          elektronischen Aufzeichnungssystem erfasst, braucht eine zertifizierte TSE und muss die Kasse beim Finanzamt melden – bitte mit der
          Steuerberatung abstimmen (siehe Hilfe „Kasse“).
        </p>
      ) : null}

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

      {canWrite ? (
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

      <h2 className="mb-3 font-display text-xl font-semibold">Abschlüsse</h2>
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
