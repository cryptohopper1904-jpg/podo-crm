"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui";
import { followUpRequestedAction, type FollowUpActionState } from "./actions";

/** Vermerk „Folgeverordnung angefordert am heute“ (unveränderbar, protokolliert) */
export function FollowUpRequestForm({ prescriptionId, patientId }: { prescriptionId: string; patientId: string }) {
  const [state, action, pending] = useActionState<FollowUpActionState, FormData>(followUpRequestedAction, undefined);
  if (state?.ok) return <p role="status" className="text-sm font-medium text-primary">{state.ok}</p>;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} revealKey={state} />
      <input name="note" maxLength={300} placeholder="Notiz (optional, z. B. per Fax)" aria-label="Notiz zur Anforderung" className="h-9 min-w-48 flex-1 rounded-lg border border-border bg-surface px-2 text-sm" />
      <button type="submit" disabled={pending} className="text-sm font-semibold text-primary">{pending ? "…" : "als angefordert vermerken"}</button>
    </form>
  );
}
