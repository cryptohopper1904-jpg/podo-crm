import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { Badge, Card, CardTitle, Empty, PageHeader, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { PAYMENT_METHOD_LABEL } from "@/lib/invoice-labels";
import { periodQuery, resolvePeriod } from "@/lib/stats";
import { belegliste } from "@/server/gkv-stats";
import { StatsFilter, StatsTabs, yearOfPeriod } from "../stats-nav";

export const metadata = { title: "Auswertung – Belegliste" };

const PARTNER: Record<string, string> = { manual: "manuell", "opta-data": "opta data", optica: "Optica", azh: "azh / noventi", rzh: "RZH", other: "anderes" };

/**
 * GKV Paket C: interne Belegliste – Zuzahlungsquittungen (ZZ) mit Stornobelegen und Abrechnungsläufe je Zeitraum, CSV.
 * Rechte: finance.read (Auswertung) + invoices.read (Belege mit Namen).
 */
export default async function BeleglistePage(props: PageProps<"/auswertung/belegliste">) {
  const auth = await requireAuth("finance.read");
  if (!auth.can("invoices.read")) redirect("/kein-zugriff");
  const sp = await props.searchParams;
  const period = resolvePeriod(sp, berlinDateIso());
  const b = await belegliste(auth, period);
  const zzSum = b.receipts.filter((r) => r.kind === "copayment" && r.status !== "cancelled").reduce((s, r) => s + r.totalCents, 0);
  const csvHref = `/api/export/belegliste?${new URLSearchParams({ von: period.from, bis: period.until }).toString()}`;
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Auswertung" subtitle="Belegliste: Zuzahlungsquittungen und Abrechnungsläufe" />
      <StatsTabs active="belegliste" statsQuery={periodQuery(period)} year={yearOfPeriod(period)} />
      <StatsFilter action="/auswertung/belegliste" period={period} />
      {!auth.support ? (
        <p className="mb-4">
          <a href={csvHref} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2">
            <Download size={16} aria-hidden /> Belegliste als CSV
          </a>
        </p>
      ) : null}
      <Card className="mb-6">
        <CardTitle>Zuzahlungsquittungen ({b.receipts.length}) · gültig {money(zzSum)}</CardTitle>
        {b.receipts.length === 0 ? (
          <Empty title="Keine Zuzahlungsquittungen im Zeitraum" />
        ) : (
          <Table>
            <thead><tr><th>Datum</th><th>Beleg</th><th>Person</th><th>Betrag</th><th>Zahlungsart</th><th>Status</th></tr></thead>
            <tbody>
              {b.receipts.map((r) => (
                <tr key={r.invoiceId}>
                  <td>{r.issuedAt ? dateDe(r.issuedAt) : "–"}</td>
                  <td>
                    <Link href={`/rechnungen/${r.invoiceId}`} className="font-semibold text-primary">{r.number ?? "–"}</Link>
                    {r.kind === "storno" ? <div className="text-xs text-muted">Storno zu {r.related ?? "–"}</div> : r.related ? <div className="text-xs text-muted">storniert durch {r.related}</div> : null}
                  </td>
                  <td>{r.patient}{r.patientNumber !== null ? ` (#${r.patientNumber})` : ""}</td>
                  <td className="tabular-nums">{money(r.totalCents)}</td>
                  <td>{r.methods.map((m) => PAYMENT_METHOD_LABEL[m] ?? m).join(", ") || "–"}</td>
                  <td>{r.status === "cancelled" ? <Badge tone="neutral">storniert</Badge> : r.kind === "storno" ? <Badge tone="warn">Storno</Badge> : <Badge tone="primary">gültig</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardTitle>Abrechnungsläufe ({b.batches.length})</CardTitle>
        {b.batches.length === 0 ? (
          <Empty title="Keine Abrechnungsläufe im Zeitraum" />
        ) : (
          <Table>
            <thead><tr><th>Erstellt</th><th>Partner</th><th>Verordnungen</th><th>Heilmittelkosten</th><th>Zuzahlungen</th><th>Kassenanteil</th><th>Export</th></tr></thead>
            <tbody>
              {b.batches.map((x) => (
                <tr key={x.id}>
                  <td>{dateDe(x.createdOn)}{x.note ? <div className="text-xs text-muted">{x.note}</div> : null}</td>
                  <td>{PARTNER[x.partner] ?? x.partner}</td>
                  <td className="tabular-nums">{x.prescriptionCount}</td>
                  <td className="tabular-nums">{x.remedyCents === null ? "–" : money(x.remedyCents)}</td>
                  <td className="tabular-nums">{money(x.copaymentCents)}</td>
                  <td className="tabular-nums">{x.insurerCents === null ? "–" : money(x.insurerCents)}</td>
                  <td>{x.exportedOn ? <Badge tone="primary">{dateDe(x.exportedOn)}</Badge> : <Badge tone="warn">offen</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
