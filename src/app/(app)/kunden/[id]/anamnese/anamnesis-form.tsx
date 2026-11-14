"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { AnamnesisFields } from "@/components/anamnesis-fields";
import { Button, Checkbox, FormActions, FormError } from "@/components/ui";
import type { AnamnesisData } from "@/lib/anamnesis";
import { saveAnamnesisAction, type AnamnesisFormState } from "./actions";

/** `touch`: große Bedienelemente für das iPad im Behandlungsraum (Bogen gemeinsam mit dem Patienten ausfüllen). */
export function AnamnesisForm({ patientId, initial, touch = false }: { patientId: string; initial: Partial<AnamnesisData> | null; touch?: boolean }) {
  const [state, action, pending] = useActionState<AnamnesisFormState, FormData>(saveAnamnesisAction, undefined);
  return (
    <form
      onSubmit={keepValues(action)}
      className={
        touch
          ? "flex flex-col gap-5 text-lg [&_input[type=checkbox]]:size-7 [&_label]:min-h-14 [&_input:not([type=checkbox])]:h-14 [&_input:not([type=checkbox])]:text-lg [&_select]:h-14 [&_select]:text-lg [&_textarea]:text-lg [&_button[type=submit]]:h-14 [&_button[type=submit]]:px-8 [&_button[type=submit]]:text-lg"
          : "flex flex-col gap-5"
      }
    >
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} revealKey={state} />
      <AnamnesisFields mode="practice" initial={initial} />
      <Checkbox name="updateRiskFlags" defaultChecked label="Risikomerkmale der Patientenakte (Diabetes, Blutverdünner, pAVK, Neuropathie, MRSA, Allergien) aus dieser Anamnese übernehmen" />
      {/* Klebende Aktionsleiste: Speichern bleibt im langen Bogen erreichbar (ui.tsx FormActions) */}
      <FormActions error={state?.error}>
        <Button type="submit" disabled={pending}>{pending ? "Wird gespeichert …" : "Als neue Version speichern"}</Button>
      </FormActions>
    </form>
  );
}
