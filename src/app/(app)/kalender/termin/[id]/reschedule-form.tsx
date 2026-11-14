"use client";

import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Checkbox, Field, FormActions, FormError, Input, Select } from "@/components/ui";
import { rescheduleAppointmentAction } from "../../actions";
import { SlotWarning, slotQueryFromForm, type SlotQuery } from "../../slot-warning";

type T = { id: string; name: string };

/** Termin verschieben: Datum, Uhrzeit, Dauer, Behandler:in. Bei Überschneidung erst nach Bestätigung. */
export function RescheduleForm({ id, team, defaults }: { id: string; team: T[]; defaults: { date: string; time: string; durationMin: number; therapistId: string } }) {
  const [state, action, pending] = useActionState(rescheduleAppointmentAction, undefined);
  const [slot, setSlot] = useState<SlotQuery | null>(null);
  return (
    <form onSubmit={keepValues(action)} noValidate onChange={(e) => setSlot(slotQueryFromForm(e.currentTarget, defaults.durationMin, id))} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      <FormError message={state?.error} revealKey={state} />
      {state?.conflict ? <Checkbox name="allowConflict" value="1" label="Trotzdem verschieben (Doppelbelegung, Abwesenheit bzw. Sperrzeit)" /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        <Field label="Neues Datum"><Input type="date" name="date" defaultValue={defaults.date} required /></Field>
        <Field label="Uhrzeit"><Input type="time" name="time" step={300} defaultValue={defaults.time} required /></Field>
        <Field label="Dauer"><Input suffix="Min" type="number" name="durationMin" min={5} max={480} defaultValue={defaults.durationMin} required /></Field>
        <Field label="Behandler:in">
          <Select name="therapistId" defaultValue={defaults.therapistId}>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
      {slot ? <SlotWarning query={slot} override="Trotzdem verschieben" /> : null}
      <FormActions sticky={false} error={pending ? null : state?.error}>
        <Button type="submit" disabled={pending}>{pending ? "Wird verschoben …" : "Termin verschieben"}</Button>
      </FormActions>
    </form>
  );
}
