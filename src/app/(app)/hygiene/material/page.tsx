import Link from "next/link";
import { ExternalLink, Minus, Plus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, LinkButton, Table } from "@/components/ui";
import { needsReorder, safeHttpUrl } from "@/lib/hygiene-rules";
import { listMaterials } from "@/server/hygiene";
import { canEditMaterials, canViewMaterials, requireHygiene } from "../access";
import { adjustStockAction, saveMaterialAction } from "../actions";
import { MaterialFields } from "./material-fields";

export const metadata = { title: "Material" };

const stepBtn = "inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface hover:bg-surface-2";

export default async function MaterialsPage(props: PageProps<"/hygiene/material">) {
  const auth = await requireHygiene(canViewMaterials);
  const sp = await props.searchParams;
  const mats = await listMaterials(auth.organization.id);
  const edit = canEditMaterials(auth);
  const editing = typeof sp.edit === "string" ? mats.find((m) => m.id === sp.edit) : undefined;
  const low = mats.filter((m) => m.active && needsReorder(m)).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px]">
          {low ? <Badge tone="warn">{low} Artikel nachbestellen</Badge> : <Badge tone="primary">Alle Bestände über Mindestbestand</Badge>}
        </p>
        <LinkButton href="/hygiene/material/bestellliste" variant="secondary">Bestellliste</LinkButton>
      </div>

      {mats.length === 0 ? (
        <Empty title="Noch kein Material erfasst" />
      ) : (
        <Table>
          <thead><tr><th>Material</th><th className="text-right">Bestand</th><th className="text-right">Mindest</th><th>Lieferant</th><th></th></tr></thead>
          <tbody>
            {mats.map((m) => {
              const url = safeHttpUrl(m.orderUrl);
              return (
                <tr key={m.id} className={m.active ? undefined : "opacity-60"}>
                  <td>
                    <p className="font-semibold">{m.name}</p>
                    {needsReorder(m) && m.active ? <Badge tone="warn">nachbestellen</Badge> : null}
                    {!m.active ? <Badge>inaktiv</Badge> : null}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {edit ? (
                        <form action={adjustStockAction}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="delta" value="-1" />
                          <button className={stepBtn} aria-label={`${m.name}: Bestand um 1 verringern`} disabled={m.stock <= 0}><Minus size={18} aria-hidden /></button>
                        </form>
                      ) : null}
                      <span className="min-w-14 text-center font-semibold tabular-nums">{m.stock} <span className="text-xs font-normal text-muted">{m.unit}</span></span>
                      {edit ? (
                        <form action={adjustStockAction}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="delta" value="1" />
                          <button className={stepBtn} aria-label={`${m.name}: Bestand um 1 erhöhen`}><Plus size={18} aria-hidden /></button>
                        </form>
                      ) : null}
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{m.minStock}</td>
                  <td>
                    {m.supplier ?? "–"}
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                        bestellen <ExternalLink size={14} aria-hidden />
                      </a>
                    ) : null}
                  </td>
                  <td>{edit ? <Link href={{ pathname: "/hygiene/material", query: { edit: m.id } }} className="text-sm font-semibold text-primary">bearbeiten</Link> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {edit ? (
        <Card>
          <CardTitle action={editing ? <Link href="/hygiene/material" className="text-sm font-semibold text-muted">Abbrechen</Link> : undefined}>
            {editing ? `Bearbeiten: ${editing.name}` : "Material hinzufügen"}
          </CardTitle>
          <ActionForm key={editing?.id ?? `new-${mats.length}`} action={saveMaterialAction} submit={editing ? "Änderung speichern" : "Material anlegen"}>
            <MaterialFields material={editing} />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
