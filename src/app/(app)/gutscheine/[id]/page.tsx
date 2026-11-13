import Link from "next/link";
import { notFound } from "next/navigation";
import { Gift } from "lucide-react";
import { Badge, Card, CardTitle, Empty, Stat, Table, BackLink, pageTitleCls } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import { getOrganizationForPrint, getVoucher } from "@/server/vouchers";
import { backHref } from "@/lib/back-link";

export const metadata = { title: "Gutschein" };

/** Gedruckt wird nur die Gutscheinkarte (Format etwa DIN lang). */
const PRINT_CSS = `
@page { size: A4; margin: 15mm; }
@media print {
  main { padding: 0 !important; }
  .voucher-page > :not(.voucher-card) { display: none !important; }
  .voucher-card, .voucher-card * { color: #000 !important; background: transparent !important; border-color: #888 !important; }
  .voucher-card { border-width: 2px !important; border-style: dashed !important; }
}`;

export default async function VoucherPage(props: PageProps<"/gutscheine/[id]">) {
  const { id } = await props.params;
  const { von } = await props.searchParams;
  const auth = await requireAuth("invoices.read");
  const [data, org] = await Promise.all([getVoucher(auth, id), getOrganizationForPrint(auth)]);
  if (!data) notFound();
  const { voucher: v } = data;

  return (
    <div className="voucher-page mx-auto flex max-w-4xl flex-col gap-6">
      <style>{PRINT_CSS}</style>
      <BackLink href={backHref("/gutscheine", von)} label="Gutscheine" className="-mb-6 self-start" />
      <div className="no-print flex flex-wrap items-center gap-3">
        <h1 className={pageTitleCls}>{v.code}</h1>
        {data.expired ? <Badge>abgelaufen</Badge> : data.balanceCents > 0 ? <Badge tone="primary">gültig</Badge> : <Badge>eingelöst</Badge>}
        <div className="ml-auto"><PrintButton label="Gutschein drucken" /></div>
      </div>

      <div className="no-print grid gap-4 sm:grid-cols-3">
        <Stat label="Wert" value={money(v.amountCents)} tone="info" />
        <Stat label="Restguthaben" value={money(data.balanceCents)} tone={data.balanceCents > 0 ? "primary" : "neutral"} />
        <Stat label="Gültig bis" value={dateDe(v.validUntil)} tone={data.expired ? "accent" : "neutral"} sub={v.purpose === "single" ? "Einzweck-Gutschein" : "Mehrzweck-Gutschein"} />
      </div>

      <section
        aria-label="Gutscheinkarte"
        className="voucher-card mx-auto w-full max-w-[180mm] rounded-[var(--radius-card)] border-2 border-dashed border-primary bg-primary-soft p-8 text-primary-soft-text"
      >
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest">
              <Gift size={18} aria-hidden /> Gutschein
            </p>
            <p className="mt-3 font-display text-5xl font-bold tabular-nums">{money(v.amountCents)}</p>
            <p className="mt-2 text-sm">einlösbar für alle Leistungen und Produkte{v.purpose === "single" ? " laut Vermerk" : ""}</p>
          </div>
          <div className="text-right">
            <p className="font-display text-xl font-semibold">{org?.name}</p>
            {org?.street ? <p className="text-sm">{org.street}</p> : null}
            <p className="text-sm">{[org?.zip, org?.city].filter(Boolean).join(" ")}</p>
            {org?.phone ? <p className="text-sm">Tel. {org.phone}</p> : null}
          </div>
        </div>
        <div className="mt-8 flex flex-wrap items-end justify-between gap-4 border-t border-current/30 pt-4">
          <div>
            <p className="text-xs uppercase tracking-wide">Gutscheincode</p>
            <p className="font-mono text-2xl font-bold tracking-wider">{v.code}</p>
          </div>
          <div className="text-right text-sm">
            <p>Ausgestellt am {dateDe(v.issuedAt)}</p>
            <p className="font-semibold">Gültig bis {dateDe(v.validUntil)}</p>
          </div>
        </div>
        <p className="mt-4 text-xs">Keine Barauszahlung. Restguthaben bleibt bis zum Ablauf erhalten.</p>
      </section>

      {v.note ? (
        <Card className="no-print">
          <CardTitle>Notiz</CardTitle>
          <p className="whitespace-pre-line text-sm">{v.note}</p>
        </Card>
      ) : null}

      <div className="no-print">
        <h2 className="mb-3 font-display text-xl font-semibold">Einlösungen</h2>
        {data.redemptions.length === 0 ? (
          <Empty title="Noch nicht eingelöst">Einlösen: In der Rechnung als Zahlungsmethode „Gutschein“ mit dem Code wählen.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Rechnung</th>
                <th>Patient</th>
                <th className="text-right">Betrag</th>
              </tr>
            </thead>
            <tbody>
              {data.redemptions.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm tabular-nums">{dateTimeDe(r.paidAt)}</td>
                  <td>
                    <Link href={`/rechnungen/${r.invoiceId}`} className="font-semibold hover:text-primary">{r.invoiceNumber}</Link>
                  </td>
                  <td>{[r.patientFirst, r.patientLast].filter(Boolean).join(" ") || "–"}</td>
                  <td className="text-right tabular-nums">{money(r.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}
