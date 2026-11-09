"use client";

import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Field, FormError, FormSuccess, Input, Select } from "@/components/ui";
import { assignFeedPatientAction } from "../../actions";

type P = { id: string; number: number; firstName: string | null; lastName: string };

/** Manuelle Zuordnung – bewusst ohne automatische Vorauswahl (auch nicht bei gleichem Namen im Titel). */
export function AssignForm({ appointmentId, patients }: { appointmentId: string; patients: P[] }) {
  const [state, action, pending] = useActionState(assignFeedPatientAction, undefined);
  const [filter, setFilter] = useState("");
  const shown = filter ? patients.filter((p) => `${p.lastName} ${p.firstName ?? ""} ${p.number}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 50) : patients.slice(0, 300);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kund:in suchen">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name oder Nummer" />
        </Field>
        <Field label="Kund:in">
          <Select name="patientId" defaultValue="" required>
            <option value="">– bitte wählen –</option>
            {shown.map((p) => <option key={p.id} value={p.id}>{p.lastName}{p.firstName ? `, ${p.firstName}` : ""} (#{p.number})</option>)}
          </Select>
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>{pending ? "…" : "Zuordnen"}</Button>
      </div>
    </form>
  );
}
