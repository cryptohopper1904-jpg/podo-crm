import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE } from "@/lib/invoice-labels";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { listInvoices, type InvoiceFilter } from "@/server/invoices";

export const metadata = { title: "Rechnungen" };

export default async function InvoicesPage(props: PageProps<"/rechnungen">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const filter: InvoiceFilter = sp.filter === "paid" ? "paid" : sp.filter === "all" ? "all" : "open";
  const { rows, totals } = await listInvoices(auth, { filter, q });
  const today = berlinDateIso();
  const filters: { key: InvoiceFilter; label: string }[] = [
    { key: "open", label: "Offen" },
    { key: "paid", label: "Bezahlt" },
    { key: "all", label: "Alle" },
  ];
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Rechnungen"
        subtitle={`${totals.count} ${totals.count === 1 ? "Beleg" : "Belege"}`}
        actions={
          auth.can("invoices.write") ? (
            <LinkButton href="/rechnungen/neu"><Plus size={18} aria-hidden /> Neue Rechnung</LinkButton>
          ) : null
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Rechnungsbetrag (Auswahl)" value={money(totals.totalCents)} tone="info" sub="ohne Stornos" />
        <Stat label="Zahlungseingänge" value={money(totals.paidCents)} tone="primary" sub="abzgl. Erstattungen" />
        <Stat label="Offen" value={money(totals.openCents)} tone={totals.openCents > 0 ? "accent" : "neutral"} />
      </div>
      <form className="mb-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="filter" value={filter} />
        <label className="sr-only" htmlFor="search">Suchen</label>
        <input
          id="search"
          name="q"
          defaultValue={q}
          placeholder="Rechnungsnummer oder Name"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 text-[15px] placeholder:text-muted focus:border-primary focus:outline-none sm:max-w-md"
        />
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <Link
              key={f.key}
              href={{ pathname: "/rechnungen", query: { ...(q ? { q } : {}), filter: f.key } }}
              aria-current={filter === f.key ? "page" : undefined}
              className={`inline-flex h-11 items-center rounded-xl px-3.5 text-sm font-semibold ${filter === f.key ? "bg-primary text-on-primary" : "border border-border bg-surface"}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </form>
      {rows.length === 0 ? (
        <Empty title={q ? "Keine Treffer" : filter === "open" ? "Keine offenen Rechnungen" : "Noch keine Rechnungen"}>
          {q ? "Andere Schreibweise oder Filter „Alle“ versuchen." : null}
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Nummer</th>
              <th>Datum</th>
              <th>Empfänger</th>
              <th>Art</th>
              <th className="text-right">Betrag</th>
              <th className="text-right">Offen</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const open = i.status === "issued" || i.status === "partially_paid" ? i.totalCents - i.paidCents : 0;
              const overdue = open > 0 && i.dueAt && i.dueAt < today;
              return (
                <tr key={i.id} className="hover:bg-surface-2">
                  <td>
                    <Link href={`/rechnungen/${i.id}`} className="font-semibold tabular-nums hover:text-primary">{i.number}</Link>
                  </td>
                  <td className="text-sm tabular-nums">{dateDe(i.issuedAt)}</td>
                  <td>{i.name}</td>
                  <td className="text-sm">{INVOICE_KIND_LABEL[i.kind]}</td>
                  <td className="text-right tabular-nums">{money(i.totalCents)}</td>
                  <td className="text-right tabular-nums">
                    {open !== 0 ? <span className="font-semibold text-danger">{money(open)}</span> : "–"}
                  </td>
                  <td className="whitespace-nowrap">
                    <Badge tone={INVOICE_STATUS_TONE[i.status]}>{INVOICE_STATUS_LABEL[i.status]}</Badge>
                    {overdue ? <Badge tone="accent" className="ml-1">überfällig</Badge> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
