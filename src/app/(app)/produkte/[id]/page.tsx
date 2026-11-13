import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Field, Input, LinkButton, Select, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/catalog";
import { dateDe, money } from "@/lib/format";
import { CORRECTION_KINDS, isBelowMinimum, MOVEMENT_LABELS, type MovementKind } from "@/lib/stock";
import { getProduct, listSuppliers } from "@/server/products";
import { correctStockAction, saveProductAction, setProductActiveAction } from "../actions";
import { ProductFields } from "../product-fields";

export const metadata = { title: "Produkt" };

export default async function ProductPage(props: PageProps<"/produkte/[id]">) {
  const auth = await requireAuth("invoices.read");
  const { id } = await props.params;
  const p = await getProduct(auth, id);
  if (!p) notFound();
  const manage = auth.can("settings.manage");
  const write = auth.can("invoices.write");
  const sup = manage ? await listSuppliers(auth) : [];
  const low = isBelowMinimum(p);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-2xl font-semibold">{p.name}</h2>
        <Badge>{PRODUCT_CATEGORY_LABELS[p.category] ?? p.category}</Badge>
        <Badge>{p.vatRate} % USt</Badge>
        {!p.active ? <Badge>archiviert</Badge> : null}
        <span className="ml-auto font-display text-2xl font-bold tabular-nums">{money(p.priceCents)}</span>
      </div>

      <Card>
        <CardTitle action={write ? <LinkButton href={`/produkte/wareneingang?produkt=${p.id}`} variant="secondary">Wareneingang buchen</LinkButton> : undefined}>Bestand</CardTitle>
        {p.trackStock ? (
          <p className="flex flex-wrap items-center gap-3 text-[15px]">
            <span className="font-display text-3xl font-bold tabular-nums">{p.stock}</span> {p.unit}
            {p.minStock ? <span className="text-muted">Mindestbestand {p.minStock}</span> : null}
            {low ? <Badge tone="warn"><AlertTriangle size={12} className="mr-1" aria-hidden />nachbestellen</Badge> : null}
            {p.stock < 0 ? <Badge tone="accent">Bestand negativ – bitte Inventur buchen</Badge> : null}
          </p>
        ) : (
          <p className="text-sm text-muted">Bestandsführung ist aus. Ein Wareneingang oder eine Inventur schaltet sie ein.</p>
        )}
        {write ? (
          <div className="mt-4 rounded-xl border border-dashed border-border-strong p-4">
            <p className="mb-2 font-semibold">Bestand korrigieren (Inventur, Bruch, Eigenverbrauch)</p>
            <ActionForm action={correctStockAction} submit="Korrektur buchen">
              <input type="hidden" name="productId" value={p.id} />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Grund">
                  <Select name="kind" defaultValue="inventory">
                    {CORRECTION_KINDS.map((k) => <option key={k} value={k}>{MOVEMENT_LABELS[k]}</option>)}
                  </Select>
                </Field>
                <Field label="Menge" hint="Inventur: gezählter Bestand · Bruch/Eigenverbrauch: entnommene Menge">
                  <Input name="amount" type="number" min={0} required />
                </Field>
                <Field label="Notiz"><Input name="note" maxLength={300} placeholder="optional" /></Field>
              </div>
            </ActionForm>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Lagerbewegungen</CardTitle>
        {p.movements.length === 0 ? (
          <Empty title="Noch keine Bewegungen" />
        ) : (
          <Table>
            <thead><tr><th>Datum</th><th>Art</th><th className="text-right">Menge</th><th>Details</th><th>Person</th></tr></thead>
            <tbody>
              {p.movements.map((m) => (
                <tr key={m.id}>
                  <td className="tabular-nums">{dateDe(m.occurredOn)}</td>
                  <td>{MOVEMENT_LABELS[m.kind as MovementKind] ?? m.kind}</td>
                  <td className={`text-right font-semibold tabular-nums ${m.quantity < 0 ? "text-danger" : ""}`}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                  <td className="text-sm">
                    {[
                      m.supplierName,
                      m.deliveryNote && `Lieferschein ${m.deliveryNote}`,
                      m.unitCostCents !== null && `EK ${money(m.unitCostCents)}`,
                      m.note,
                    ].filter(Boolean).join(" · ")}
                    {m.invoiceId ? <Link href={`/rechnungen/${m.invoiceId}`} className="ml-1 font-semibold text-primary">Beleg</Link> : null}
                  </td>
                  <td className="text-sm text-muted">{m.userName ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">Bewegungen sind unveränderbar. Fehler werden mit einer Korrekturbuchung (Inventur) ausgeglichen.</p>
      </Card>

      {manage ? (
        <Card>
          <CardTitle
            action={
              <form action={setProductActiveAction}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="active" value={p.active ? "0" : "1"} />
                <button className="text-sm font-semibold text-muted hover:underline">{p.active ? "Archivieren" : "Wiederherstellen"}</button>
              </form>
            }
          >
            Stammdaten
          </CardTitle>
          <ActionForm action={saveProductAction} submit="Änderung speichern">
            <ProductFields p={p} suppliers={sup.map((s) => s.supplier)} />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
