import Link from "next/link";
import { Empty, Table } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { requireAuth } from "@/lib/auth/session";
import { dateDe } from "@/lib/format";
import { orderEmailText } from "@/lib/stock";
import { reorderList } from "@/server/hygiene";
import { productReorderGroups } from "@/server/products";
import { canViewMaterials } from "../../hygiene/access";
import { CopyOrderText } from "./copy-text";

export const metadata = { title: "Nachbestellen" };

/**
 * Nachbestell-Liste: Produkte unter Mindestbestand, nach Lieferant gruppiert – druckbar bzw. als Text für eine
 * Bestell-E-Mail. Es wird nichts automatisch bestellt. Verbrauchsmaterial der Praxis (Hygiene → Material) hat
 * seine eigene Bestellliste; hier nur ein Hinweis darauf.
 */
export default async function ReorderPage() {
  const auth = await requireAuth("invoices.read");
  const groups = await productReorderGroups(auth);
  const materialsLow = canViewMaterials(auth) ? (await reorderList(auth)).length : null;

  return (
    <article className="flex flex-col gap-6 bg-surface p-4 print:p-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold">Nachbestellen</h2>
          <p className="text-sm text-muted">{auth.organization.name} · Stand {dateDe(new Date())}</p>
        </div>
        <PrintButton />
      </div>

      {groups.length === 0 ? (
        <Empty title="Nichts nachzubestellen">Alle Produkte mit Bestandsführung liegen über dem Mindestbestand.</Empty>
      ) : (
        groups.map((g) => {
          const text = orderEmailText(g, auth.organization);
          return (
            <section key={g.supplier} className="flex break-inside-avoid flex-col gap-2">
              <h3 className="text-lg font-semibold">
                {g.supplier}
                {g.customerNumber ? <span className="ml-2 text-sm font-normal text-muted">Kundennr. {g.customerNumber}</span> : null}
              </h3>
              <Table>
                <thead><tr><th>Artikel</th><th>Art.-Nr.</th><th className="text-right">Bestand</th><th className="text-right">Mindest</th><th className="text-right">Vorschlag</th></tr></thead>
                <tbody>
                  {g.lines.map((l) => (
                    <tr key={l.name + (l.sku ?? "")}>
                      <td className="font-semibold">{l.name}</td>
                      <td className="text-sm">{l.sku ?? "–"}</td>
                      <td className="text-right tabular-nums">{l.stock} {l.unit}</td>
                      <td className="text-right tabular-nums">{l.minStock}</td>
                      <td className="text-right font-semibold tabular-nums">{l.orderQty} {l.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <CopyOrderText text={text} email={g.email} subject={`Bestellung ${auth.organization.name}`} />
            </section>
          );
        })
      )}

      {materialsLow !== null ? (
        <p className="no-print text-sm text-muted">
          Verbrauchsmaterial der Praxis (Handschuhe, Desinfektion …) wird unter Hygiene geführt
          {materialsLow ? ` – dort sind ${materialsLow} Artikel nachzubestellen` : ""}:{" "}
          <Link href="/hygiene/material/bestellliste" className="font-semibold text-primary">Material-Bestellliste</Link>.
        </p>
      ) : null}
    </article>
  );
}
