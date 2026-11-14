"use client";

import { useActionState } from "react";
import { Button, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { redeemPromoAction } from "./actions";

/** Aktionscode für eine längere Testphase einlösen (je Praxis einmal). */
export function PromoForm() {
  const [state, action, pending] = useActionState(redeemPromoAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-3">
      <FormError message={state?.error} revealKey={state} />
      <FormSuccess message={state?.ok} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Aktionscode" className="min-w-56 flex-1">
          <Input name="code" required maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="z. B. PODO-ABCD-EFGH" />
        </Field>
        <Button type="submit" variant="secondary" disabled={pending}>{pending ? "…" : "Einlösen"}</Button>
      </div>
    </form>
  );
}
