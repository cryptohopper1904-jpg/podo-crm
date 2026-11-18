"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui";
import { EURO_INPUT_MAX_LENGTH } from "@/lib/euro-input";
import { DEDUCTION_STATUS_LABEL, canChangeDeductionStatus, type DeductionStatus } from "@/lib/rules/gkv-billing";
import { deductionStatusAction, type DeductionStatusState } from "./actions";

const inputCls = "h-9 rounded-lg border border-border bg-surface px-2 text-sm";

/** Status, Notiz und (nur „offen“) Betrag einer Absetzung ändern */
export function DeductionStatusForm({ id, status, note, amount }: { id: string; status: DeductionStatus; note: string | null; amount: string }) {
  const [state, action, pending] = useActionState<DeductionStatusState, FormData>(deductionStatusAction, undefined);
  const options = (Object.keys(DEDUCTION_STATUS_LABEL) as DeductionStatus[]).filter((s) => canChangeDeductionStatus(status, s));
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-center gap-2">
        <select name="status" defaultValue={status} aria-label="Status der Absetzung" className={inputCls}>
          {options.map((s) => <option key={s} value={s}>{DEDUCTION_STATUS_LABEL[s]}</option>)}
        </select>
        {status === "open" ? <input name="amount" inputMode="decimal" maxLength={EURO_INPUT_MAX_LENGTH} placeholder={amount} aria-label="Betrag korrigieren (nur offen)" className={`${inputCls} w-24`} /> : null}
        <input name="note" defaultValue={note ?? ""} maxLength={1000} placeholder="Notiz (z. B. Widerspruch am …)" aria-label="Notiz" className={`${inputCls} min-w-48 flex-1`} />
        <button type="submit" disabled={pending} className="text-xs font-semibold text-primary">{pending ? "…" : "Speichern"}</button>
      </div>
      <FormError message={state?.error} revealKey={state} />
      {state?.ok ? <p role="status" className="text-xs font-medium text-primary">{state.ok}</p> : null}
    </form>
  );
}
