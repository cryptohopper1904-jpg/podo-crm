import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Empty, Field, Input, Select, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { listProducts, listSuppliers, recentReceipts } from "@/server/products";
import { bookReceiptAction } from "../actions";

export const metadata = { title: "Wareneingang" };

export default async function GoodsReceiptPage(props: PageProps<"/produkte/wareneingang">) {
  const auth = await requireAuth("invoices.read");
  const sp = await props.searchParams;
  const write = auth.can("invoices.write");
  const [prods, sup, recent] = await Promise.all([listProducts(auth), listSuppliers(auth), recentReceipts(auth)]);
  const active = prods.filter((p) => p.active);
  const pre = typeof sp.produkt === "string" && active.some((p) => p.id === sp.produkt) ? sp.produkt : "";
  const today = berlinDateIso();

  return (
    <div className="flex flex-col gap-6">
      {write ? (
        <Card>
          <CardTitle>Wareneingang buchen</CardTitle>
          {active.length === 0 ? (
            <Empty title="Noch keine Produkte">
              {auth.can("settings.manage") ? <Link href="/produkte/neu" className="font-semibold text-primary">Zuerst ein Produkt anlegen</Link> : "Produkte legt die Praxisleitung an (Einstellungsrecht)."}
            </Empty>
          ) : (
            <ActionForm key={pre || "x"} action={bookReceiptAction} submit="Eingang buchen">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Produkt *" className="sm:col-span-2">
                  <Select name="productId" defaultValue={pre} required>
                    <option value="">– bitte wählen –</option>
                    {active.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ""}{p.trackStock ? ` – Bestand ${p.stock}` : ""}</option>)}
                  </Select>
                </Field>
                <Field label="Menge *"><Input name="quantity" type="number" min={1} required /></Field>
                <Field label="Datum *"><Input name="occurredOn" type="date" defaultValue={today} max={today} required /></Field>
                <Field label="Einkaufspreis je Einheit (€)" hint="optional"><Input name="unitCost" inputMode="decimal" /></Field>
                <Field label="Lieferschein-Nr." hint="optional"><Input name="deliveryNote" maxLength={60} /></Field>
                <Field label="Lieferant" hint="leer = Standard-Lieferant des Produkts">
                  <Select name="supplierId" defaultValue="">
                    <option value="">– Standard –</option>
                    {sup.filter((s) => s.supplier.active).map((s) => <option key={s.supplier.id} value={s.supplier.id}>{s.supplier.name}</option>)}
                  </Select>
                </Field>
                <Field label="Notiz"><Input name="note" maxLength={300} /></Field>
              </div>
            </ActionForm>
          )}
        </Card>
      ) : null}

      <Card>
        <CardTitle>Letzte Wareneingänge</CardTitle>
        {recent.length === 0 ? (
          <Empty title="Noch keine Wareneingänge" />
        ) : (
          <Table>
            <thead><tr><th>Datum</th><th>Produkt</th><th className="text-right">Menge</th><th>Lieferant</th><th>Lieferschein</th><th className="text-right">EK/Einheit</th><th>Person</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums">{dateDe(r.occurredOn)}</td>
                  <td><Link href={`/produkte/${r.productId}`} className="font-semibold text-primary">{r.productName}</Link></td>
                  <td className="text-right tabular-nums">+{r.quantity} {r.unit}</td>
                  <td className="text-sm">{r.supplierName ?? "–"}</td>
                  <td className="text-sm">{r.deliveryNote ?? "–"}</td>
                  <td className="text-right tabular-nums">{r.unitCostCents === null ? "–" : money(r.unitCostCents)}</td>
                  <td className="text-sm text-muted">{r.userName ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
