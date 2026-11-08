"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import Link from "next/link";
import { Button, Checkbox, Field, FormError, FormSuccess, Input, Select } from "@/components/ui";
import { saveFixedCostAction, saveMaterialCostAction } from "./actions";

const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

type Cost = { id: string; category: string; amountCents: number; interval: string; startDate: string; note: string | null; active: boolean };

export function FixedCostForm({ cost, today, cancelHref }: { cost?: Cost; today: string; cancelHref: string }) {
  const [state, action, pending] = useActionState(saveFixedCostAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4" key={cost?.id ?? "new"}>
      {cost ? <input type="hidden" name="id" value={cost.id} /> : null}
      <FormError message={state?.error} />
      <FormSuccess message={state?.success} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Bezeichnung *" className="lg:col-span-2">
          <Input name="category" defaultValue={cost?.category ?? ""} placeholder="z. B. Miete, Versicherung" required />
        </Field>
        <Field label="Betrag (€) *">
          <Input name="amount" inputMode="decimal" defaultValue={cost ? euro(cost.amountCents) : ""} placeholder="0,00" required />
        </Field>
        <Field label="Intervall">
          <Select name="interval" defaultValue={cost?.interval ?? "monthly"}>
            <option value="monthly">monatlich</option>
            <option value="quarterly">vierteljährlich</option>
            <option value="yearly">jährlich</option>
          </Select>
        </Field>
        <Field label="Ab">
          <Input type="date" name="startDate" defaultValue={cost?.startDate ?? today} required />
        </Field>
        <Field label="Notiz" className="sm:col-span-2 lg:col-span-3">
          <Input name="note" defaultValue={cost?.note ?? ""} />
        </Field>
        <div className="flex items-end">
          <Checkbox name="active" defaultChecked={cost?.active ?? true} label="aktiv" />
        </div>
      </div>
      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Speichern …" : cost ? "Änderung speichern" : "Fixkosten hinzufügen"}</Button>
        {cost ? <Link href={cancelHref} className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link> : null}
      </div>
    </form>
  );
}

export function MaterialCostForm({ cents }: { cents: number }) {
  const [state, action, pending] = useActionState(saveMaterialCostAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-wrap items-end gap-3">
      <Field label="Materialkosten je Behandlung (€)">
        <Input name="materialCost" inputMode="decimal" defaultValue={euro(cents)} className="w-36" />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>Speichern</Button>
      <div className="w-full">
        <FormError message={state?.error} />
        <FormSuccess message={state?.success} />
      </div>
    </form>
  );
}
