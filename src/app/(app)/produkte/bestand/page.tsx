import Link from "next/link";
import { Badge, Empty, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { money } from "@/lib/format";
import { isBelowMinimum } from "@/lib/stock";
import { listProducts } from "@/server/products";

export const metadata = { title: "Bestand" };

/** Bestandsliste: alle aktiven Produkte mit Bestandsführung, Unterschreitungen zuerst */
export default async function StockPage() {
  const auth = await requireAuth("invoices.read");
  const rows = (await listProducts(auth)).filter((p) => p.active && p.trackStock);
  rows.sort((a, b) => Number(isBelowMinimum(b)) - Number(isBelowMinimum(a)) || a.name.localeCompare(b.name, "de"));
  const low = rows.filter(isBelowMinimum).length;
  const value = rows.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchasePriceCents ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Produkte mit Bestand" value={rows.length} tone="neutral" />
        <Stat label="Unter Mindestbestand" value={low} tone={low ? "warn" : "primary"} sub={low ? <Link href="/produkte/nachbestellen" className="font-semibold underline">Nachbestell-Liste</Link> : "alles da"} />
        <Stat label="Lagerwert (Einkauf)" value={money(value)} tone="info" sub="nur Produkte mit Einkaufspreis" />
      </div>
      {rows.length === 0 ? (
        <Empty title="Noch keine Produkte mit Bestandsführung">Beim Produkt „Bestand führen“ anhaken oder einen Wareneingang buchen.</Empty>
      ) : (
        <Table>
          <thead><tr><th>Produkt</th><th className="text-right">Bestand</th><th className="text-right">Mindest</th><th>Lieferant</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <p className="font-semibold">{p.name}</p>
                  {p.sku ? <p className="text-xs text-muted">Art.-Nr. {p.sku}</p> : null}
                </td>
                <td className={`text-right font-semibold tabular-nums ${p.stock < 0 ? "text-danger" : ""}`}>{p.stock} <span className="text-xs font-normal text-muted">{p.unit}</span></td>
                <td className="text-right tabular-nums">{p.minStock || "–"}</td>
                <td className="text-sm">{p.supplierName ?? "–"}</td>
                <td>
                  {isBelowMinimum(p) ? <Badge tone="warn">nachbestellen</Badge> : null}{" "}
                  <Link href={`/produkte/${p.id}`} className="text-sm font-semibold text-primary">Details</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
