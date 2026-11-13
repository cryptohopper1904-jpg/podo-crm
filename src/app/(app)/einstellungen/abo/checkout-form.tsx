"use client";

import { useActionState, useState } from "react";
import { Button, Field, FormError, FormSuccess, Input, Select } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { money } from "@/lib/format";
import { grossLabel, monthlyPriceCents, PAID_PLANS, PLANS, SEAT_FREE_NOTE, type PaidPlan } from "@/lib/plans";
import { startCheckoutAction } from "./actions";

export function CheckoutForm({ defaultPlan, minSeats, mock }: { defaultPlan: PaidPlan; minSeats: number; mock: boolean }) {
  const [state, action, pending] = useActionState(startCheckoutAction, undefined);
  const [plan, setPlan] = useState<PaidPlan>(defaultPlan);
  const info = PLANS[plan];
  const [seats, setSeats] = useState(Math.max(minSeats, info.includedSeats));
  const effSeats = Math.max(seats, info.includedSeats);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Tarif">
          <Select name="plan" value={plan} onChange={(e) => setPlan(e.target.value as PaidPlan)}>
            {PAID_PLANS.map((p) => (
              <option key={p} value={p}>{PLANS[p].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Plätze (Inhaber:in, Podolog:innen, Azubis)" hint={`enthalten: ${info.includedSeats}${info.maxSeats ? `, max. ${info.maxSeats}` : ", unbegrenzt"}. ${SEAT_FREE_NOTE}`}>
          <Input
            name="seats"
            type="number"
            min={Math.max(1, minSeats)}
            max={info.maxSeats ?? 999}
            value={seats}
            onChange={(e) => setSeats(Number(e.target.value) || 1)}
          />
        </Field>
        <div className="flex flex-col justify-end">
          <p className="text-sm text-muted">voraussichtlich</p>
          <p className="font-display text-2xl font-semibold">{money(monthlyPriceCents(plan, effSeats))} <span className="text-sm font-normal text-muted">netto/Monat</span></p>
          <p className="text-sm text-muted">{grossLabel(monthlyPriceCents(plan, effSeats))}</p>
        </div>
      </div>
      <div>
        <Button type="submit" disabled={pending}>{pending ? "…" : mock ? "Tarif wählen (Testmodus)" : "Tarif wählen"}</Button>
      </div>
    </form>
  );
}
