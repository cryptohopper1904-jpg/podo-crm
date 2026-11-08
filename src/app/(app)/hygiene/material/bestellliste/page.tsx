import { Empty, Table } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { dateDe } from "@/lib/format";
import { safeHttpUrl, suggestedOrderQty } from "@/lib/hygiene-rules";
import { reorderList } from "@/server/hygiene";
import { canViewMaterials, requireHygiene } from "../../access";

export const metadata = { title: "Bestellliste" };

/** Druckbare Bestellliste: alle aktiven Artikel mit Bestand ≤ Mindestbestand, nach Lieferant gruppiert. */
export default async function OrderListPage() {
  const auth = await requireHygiene(canViewMaterials);
  const items = await reorderList(auth.organization.id);
  const bySupplier = new Map<string, typeof items>();
  for (const m of items) {
    const k = m.supplier?.trim() || "ohne Lieferant";
    bySupplier.set(k, [...(bySupplier.get(k) ?? []), m]);
  }

  return (
    <article className="bg-surface p-6 print:p-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold">Bestellliste</h2>
          <p className="text-sm text-muted">{auth.organization.name} · Stand {dateDe(new Date())}</p>
        </div>
        <PrintButton />
      </div>
      {items.length === 0 ? (
        <Empty title="Nichts nachzubestellen" />
      ) : (
        <div className="flex flex-col gap-6">
          {[...bySupplier].map(([supplier, list]) => (
            <section key={supplier} className="break-inside-avoid">
              <h3 className="mb-2 text-lg font-semibold">{supplier}</h3>
              <Table>
                <thead><tr><th>Artikel</th><th className="text-right">Bestand</th><th className="text-right">Mindest</th><th className="text-right">Vorschlag</th><th>Bestell-Link</th></tr></thead>
                <tbody>
                  {list.map((m) => {
                    const url = safeHttpUrl(m.orderUrl);
                    return (
                      <tr key={m.id}>
                        <td className="font-semibold">{m.name}</td>
                        <td className="text-right tabular-nums">{m.stock} {m.unit}</td>
                        <td className="text-right tabular-nums">{m.minStock}</td>
                        <td className="text-right font-semibold tabular-nums">{suggestedOrderQty(m)} {m.unit}</td>
                        <td className="max-w-64 truncate text-sm">{url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{url}</a> : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}
