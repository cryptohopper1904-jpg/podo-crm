import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardTitle, Empty, Stat, Table, BackLink, pageTitleCls } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, money } from "@/lib/format";
import { getOrganizationForPrint, getVoucher } from "@/server/vouchers";
import { backHref } from "@/lib/back-link";
import { VOUCHER_MOTIFS, VoucherCard, parseMotif } from "./voucher-card";

export const metadata = { title: "Gutschein" };

/** Gedruckt wird nur die Gutscheinkarte, in Farbe (Motiv). */
const PRINT_CSS = `
@page { size: A4; margin: 15mm; }
@media print {
  main { padding: 0 !important; }
  .voucher-page > :not(.voucher-card) { display: none !important; }
  .voucher-card, .voucher-card * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .voucher-card { break-inside: avoid; }
}`;

export default async function VoucherPage(props: PageProps<"/gutscheine/[id]">) {
  const { id } = await props.params;
  const { von, motiv } = await props.searchParams;
  const motif = parseMotif(motiv);
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

      <nav aria-label="Motiv wählen" className="no-print flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Motiv:</span>
        {VOUCHER_MOTIFS.map((m) => {
          const q = new URLSearchParams({ motiv: m.id, ...(typeof von === "string" ? { von } : {}) });
          const on = m.id === motif;
          return (
            <Link
              key={m.id}
              href={`/gutscheine/${v.id}?${q}`}
              replace
              scroll={false}
              aria-current={on ? "true" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${on ? "bg-primary text-on-primary" : "border border-border bg-surface hover:bg-surface-2"}`}
            >
              {m.label}
            </Link>
          );
        })}
      </nav>

      <VoucherCard
        motif={motif}
        org={org}
        v={{ code: v.code, amountCents: v.amountCents, issuedAt: v.issuedAt, validUntil: v.validUntil, single: v.purpose === "single" }}
      />

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
