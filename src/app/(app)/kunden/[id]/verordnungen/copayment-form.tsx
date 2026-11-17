"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui";
import { copaymentPaidAction, type CopaymentPaidState } from "./actions";

/**
 * „Zuzahlung erhalten“ markieren bzw. zurücksetzen. Ungültiger Betrag → sichtbare Fehlermeldung; Betrag über der
 * berechneten Zuzahlung → gespeichert, aber Hinweis (PR #111 Review-Runde 2).
 */
export function CopaymentPaidForm({ id, patientId, paid, copaymentCents, methods }: { id: string; patientId: string; paid: boolean; copaymentCents: number; methods: Record<string, string> }) {
  const [state, action, pending] = useActionState<CopaymentPaidState, FormData>(copaymentPaidAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="paid" value={paid ? "0" : "1"} />
      <FormError message={state?.error} revealKey={state} />
      <div className="flex flex-wrap items-center gap-2">
        {paid ? null : (
          <>
            <input name="amount" inputMode="decimal" placeholder={(copaymentCents / 100).toFixed(2).replace(".", ",")} aria-label="erhaltener Betrag in Euro" maxLength={20} className="h-9 w-24 rounded-lg border border-border bg-surface px-2 text-sm" />
            <select name="method" aria-label="Zahlungsart" defaultValue="cash" aria-describedby={`copay-hint-${id}`} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm">
              {Object.entries(methods).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </>
        )}
        <button type="submit" disabled={pending} className="text-xs font-semibold text-primary">{paid ? "zurücksetzen" : "als erhalten markieren"}</button>
      </div>
      {paid ? null : <p id={`copay-hint-${id}`} className="text-xs text-muted">Nur Vermerk – Barzahlung zusätzlich in der Kasse als Zahlung erfassen.</p>}
      {state?.warning ? <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn-soft-text">{state.warning}</p> : null}
    </form>
  );
}
