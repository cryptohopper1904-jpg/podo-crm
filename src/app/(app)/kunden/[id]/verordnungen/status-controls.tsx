"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, useState } from "react";
import { Button, FormError, Input } from "@/components/ui";
import type { PrescriptionStatus } from "@/lib/rules/prescription";
import { prescriptionStatusAction, type PrescriptionFormState } from "./actions";

/** Statuswechsel einer Verordnung (Regeln in src/lib/rules/prescription.ts → canTransition). */
export function StatusControls({ id, patientId, status, unitsUsed, units }: { id: string; patientId: string; status: PrescriptionStatus; unitsUsed: number; units: number }) {
  const [state, action, pending] = useActionState<PrescriptionFormState, FormData>(prescriptionStatusAction, undefined);
  const [early, setEarly] = useState(false);
  const [reopen, setReopen] = useState(false);
  const options: [PrescriptionStatus, string, "primary" | "secondary" | "danger"][] = [];
  if (status === "completed") options.push(["billing_ready", "Abrechnungsreif", "primary"]);
  if (status === "billing_ready") options.push(["completed", "Abrechnungsreif zurücknehmen", "secondary"]);
  if (status === "open") options.push(["expired", "Als verfallen markieren", "secondary"]);
  if (status === "open" || status === "active") options.push(["cancelled", "Stornieren", "danger"]);
  const canEnd = status === "active" && unitsUsed > 0 && unitsUsed < units;
  // Rückweg aus „Frist überschritten“ nur mit Begründung (wird protokolliert) – src/lib/rules/prescription.ts canTransition
  const canReopen = status === "expired" && unitsUsed < units;
  if (!options.length && !canEnd && !canReopen) return null;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} />
      {state?.warning ? <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn-soft-text">{state.warning}</p> : null}
      {reopen ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input name="interruptionNote" placeholder="Begründung (z. B. Behandlung hat am … begonnen, Doku nachgetragen)" className="min-w-64 flex-1" required minLength={5} maxLength={500} aria-label="Begründung der Wiederaufnahme" />
          <Button type="submit" name="to" value={unitsUsed > 0 ? "active" : "open"} disabled={pending}>Wieder aufnehmen</Button>
          <Button type="button" variant="ghost" onClick={() => setReopen(false)}>Abbrechen</Button>
        </div>
      ) : early ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input name="interruptionNote" placeholder="Grund des Abbruchs (z. B. Behandlungsziel erreicht, Umzug)" className="min-w-64 flex-1" required minLength={5} />
          <Button type="submit" name="to" value="billing_ready" disabled={pending}>Vorzeitig abrechnen</Button>
          <Button type="button" variant="ghost" onClick={() => setEarly(false)}>Abbrechen</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map(([to, label, variant]) => (
            <Button key={to} type="submit" name="to" value={to} variant={variant} disabled={pending} className="h-10 text-sm">{label}</Button>
          ))}
          {canEnd ? <Button type="button" variant="secondary" className="h-10 text-sm" onClick={() => setEarly(true)}>Behandlung abgebrochen …</Button> : null}
          {canReopen ? <Button type="button" variant="secondary" className="h-10 text-sm" onClick={() => setReopen(true)}>Irrtümlich abgelaufen – wieder aufnehmen …</Button> : null}
        </div>
      )}
    </form>
  );
}
