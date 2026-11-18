"use client";

import { useActionState } from "react";
import { FormError, Input } from "@/components/ui";
import { PAPER_SIGNATURE_LABEL } from "@/lib/signature";
import { paperBulkAction, type SignatureState } from "../../actions";

/**
 * Bestand (Behandlungen vor Einführung der Unterschrift auf dem Gerät): alle noch offenen Behandlungen bis zu einem
 * Datum als „Unterschrift auf der Papier-Verordnung“ vermerken – bewusster, protokollierter Schritt (Review R2-13).
 */
export function PaperBulkForm({ prescriptionId, patientId, maxDate, defaultDate }: { prescriptionId: string; patientId: string; maxDate: string; defaultDate: string }) {
  const [state, action, pending] = useActionState<SignatureState, FormData>(paperBulkAction, undefined);
  return (
    <details className="mb-4 rounded-xl border border-border p-3 text-sm">
      <summary className="cursor-pointer font-semibold text-primary">Unterschriften liegen auf Papier vor (Sammel-Vermerk)</summary>
      <form action={action} className="mt-3 flex flex-col gap-2">
        <input type="hidden" name="prescriptionId" value={prescriptionId} />
        <input type="hidden" name="patientId" value={patientId} />
        <FormError message={state?.error} revealKey={state} />
        <label className="flex flex-wrap items-center gap-2">
          Alle offenen Behandlungen bis einschließlich
          <Input type="date" name="until" defaultValue={defaultDate} max={maxDate} required className="w-44" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="confirm" required className="size-5 accent-[var(--primary)]" />
          Ich bestätige: Für diese Behandlungen liegt die Bestätigung vor – „{PAPER_SIGNATURE_LABEL}“.
        </label>
        <button type="submit" disabled={pending} className="self-start font-semibold text-primary">{pending ? "…" : "Vermerken (unveränderbar)"}</button>
        {state?.ok ? <p role="status" className="font-medium text-primary">{state.ok}</p> : null}
      </form>
    </details>
  );
}
