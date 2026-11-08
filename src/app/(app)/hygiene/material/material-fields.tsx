import { Checkbox, Field, Input } from "@/components/ui";
import type { materials } from "@/db/schema";

type Material = typeof materials.$inferSelect;

export function MaterialFields({ material }: { material?: Material }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {material ? <input type="hidden" name="id" value={material.id} /> : null}
      <Field label="Bezeichnung *" className="lg:col-span-2">
        <Input name="name" defaultValue={material?.name ?? ""} required maxLength={120} placeholder="z. B. Einmal-Skalpellklingen Nr. 15" />
      </Field>
      <Field label="Einheit">
        <Input name="unit" defaultValue={material?.unit ?? "Stück"} maxLength={30} placeholder="Stück, Packung, Liter" />
      </Field>
      <div />
      <Field label="Bestand">
        <Input type="number" name="stock" min={0} step={1} defaultValue={material?.stock ?? 0} />
      </Field>
      <Field label="Mindestbestand" hint="Ab diesem Bestand auf die Bestellliste">
        <Input type="number" name="minStock" min={0} step={1} defaultValue={material?.minStock ?? 0} />
      </Field>
      <Field label="Lieferant">
        <Input name="supplier" defaultValue={material?.supplier ?? ""} maxLength={120} />
      </Field>
      <Field label="Bestell-Link" hint="https://…">
        <Input type="url" name="orderUrl" defaultValue={material?.orderUrl ?? ""} maxLength={500} />
      </Field>
      {material ? <Checkbox name="active" defaultChecked={material.active} label="aktiv" /> : null}
    </div>
  );
}
