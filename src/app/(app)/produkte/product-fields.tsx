import { Checkbox, Field, Input, Select } from "@/components/ui";
import type { products } from "@/db/schema";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "@/lib/catalog";

const euro = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

/** Formularfelder Produkt (anlegen/bearbeiten) */
export function ProductFields({ p, suppliers }: { p?: typeof products.$inferSelect; suppliers: { id: string; name: string; active: boolean }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {p ? <input type="hidden" name="id" value={p.id} /> : null}
      <Field label="Name *" className="sm:col-span-2"><Input name="name" defaultValue={p?.name} required maxLength={200} placeholder="z. B. Hornhautsalbe 75 ml" /></Field>
      <Field label="Kategorie">
        <Select name="category" defaultValue={p?.category ?? "salbe"}>
          {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{PRODUCT_CATEGORY_LABELS[c]}</option>)}
        </Select>
      </Field>
      <Field label="Kürzel" hint="optional, Schnelleingabe in der Rechnung"><Input name="code" defaultValue={p?.code ?? ""} maxLength={10} className="uppercase" /></Field>
      <Field label="Verkaufspreis brutto (€) *"><Input name="price" defaultValue={euro(p?.priceCents)} required inputMode="decimal" placeholder="0,00" /></Field>
      <Field label="USt beim Verkauf" hint="in der Behandlung angewendet: 0 % auf der Rechnung wählbar">
        <Select name="vatRate" defaultValue={String(p?.vatRate ?? 19)}><option value="19">19 %</option><option value="7">7 %</option></Select>
      </Field>
      <Field label="Einkaufspreis (€)" hint="optional, netto oder brutto – nur intern"><Input name="purchasePrice" defaultValue={euro(p?.purchasePriceCents)} inputMode="decimal" /></Field>
      <Field label="Einheit"><Input name="unit" defaultValue={p?.unit ?? "Stück"} maxLength={30} /></Field>
      <Field label="Artikelnummer"><Input name="sku" defaultValue={p?.sku ?? ""} maxLength={60} /></Field>
      <Field label="EAN"><Input name="ean" defaultValue={p?.ean ?? ""} inputMode="numeric" maxLength={14} /></Field>
      <Field label="Lieferant">
        <Select name="supplierId" defaultValue={p?.supplierId ?? ""}>
          <option value="">– keiner –</option>
          {suppliers.filter((s) => s.active || s.id === p?.supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="Mindestbestand" hint="Warnung und Nachbestell-Liste"><Input name="minStock" type="number" min={0} defaultValue={p?.minStock ?? 0} /></Field>
      <div className="sm:col-span-2 lg:col-span-4">
        <Checkbox name="trackStock" defaultChecked={p?.trackStock ?? true} label="Bestand führen (Verkauf bucht ab, Storno bucht zurück)" />
      </div>
    </div>
  );
}
