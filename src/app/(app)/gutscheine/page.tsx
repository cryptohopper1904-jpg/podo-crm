import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, money } from "@/lib/format";
import { listVouchers } from "@/server/vouchers";
import { returnPath, withReturn } from "@/lib/back-link";

export const metadata = { title: "Gutscheine" };

export default async function VouchersPage(props: PageProps<"/gutscheine">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const filter = sp.filter === "all" ? "all" : "active";
  const { rows, totals } = await listVouchers(auth, { q, filter });
  const from = returnPath("/gutscheine", { q, filter: filter === "active" ? "" : filter }); // Rücksprung aus dem Gutschein
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Gutscheine"
        subtitle={`${totals.count} ausgestellt`}
        actions={auth.can("invoices.write") ? <LinkButton href="/gutscheine/neu"><Plus size={18} aria-hidden /> Neuer Gutschein</LinkButton> : null}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Stat label="Offenes Gutscheinguthaben" value={money(totals.outstandingCents)} tone="warn" sub="gültige Gutscheine (Verbindlichkeit)" />
        <Stat label="Angezeigt" value={rows.length} tone="neutral" />
      </div>
      <form className="mb-4 flex flex-wrap items-center gap-2">
        <input type="hidden" name="filter" value={filter} />
        <label className="sr-only" htmlFor="search">Code suchen</label>
        <input
          id="search"
          name="q"
          defaultValue={q}
          placeholder="Code, z. B. G2026-0001"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 text-[15px] placeholder:text-muted focus:border-primary focus:outline-none sm:max-w-sm"
        />
        {[
          { key: "active", label: "Mit Guthaben" },
          { key: "all", label: "Alle" },
        ].map((f) => (
          <Link
            key={f.key}
            href={{ pathname: "/gutscheine", query: { ...(q ? { q } : {}), filter: f.key } }}
            aria-current={filter === f.key ? "page" : undefined}
            className={`inline-flex h-11 items-center rounded-xl px-3.5 text-sm font-semibold ${filter === f.key ? "bg-primary text-on-primary" : "border border-border bg-surface"}`}
          >
            {f.label}
          </Link>
        ))}
      </form>
      {rows.length === 0 ? (
        <Empty title="Keine Gutscheine">{filter === "active" ? "Filter „Alle“ zeigt auch eingelöste und abgelaufene." : null}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Ausgestellt</th>
              <th>Gültig bis</th>
              <th>Art</th>
              <th className="text-right">Wert</th>
              <th className="text-right">Restguthaben</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} className="hover:bg-surface-2">
                <td>
                  <Link href={withReturn(`/gutscheine/${v.id}`, from)} className="font-semibold tabular-nums hover:text-primary">{v.code}</Link>
                </td>
                <td className="text-sm tabular-nums">{dateDe(v.issuedAt)}</td>
                <td className="text-sm tabular-nums">{dateDe(v.validUntil)}</td>
                <td className="text-sm">{v.purpose === "single" ? "Einzweck" : "Mehrzweck"}</td>
                <td className="text-right tabular-nums">{money(v.amountCents)}</td>
                <td className="text-right font-semibold tabular-nums">{money(v.balanceCents)}</td>
                <td>
                  {v.expired ? (
                    <Badge>abgelaufen</Badge>
                  ) : v.balanceCents <= 0 ? (
                    <Badge>eingelöst</Badge>
                  ) : v.redemptions > 0 ? (
                    <Badge tone="info">teilweise eingelöst</Badge>
                  ) : (
                    <Badge tone="primary">gültig</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
