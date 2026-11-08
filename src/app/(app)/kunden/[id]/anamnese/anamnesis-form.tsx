"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { AnamnesisFields } from "@/components/anamnesis-fields";
import { Button, Checkbox, FormError } from "@/components/ui";
import type { AnamnesisData } from "@/lib/anamnesis";
import { saveAnamnesisAction, type AnamnesisFormState } from "./actions";

export function AnamnesisForm({ patientId, initial }: { patientId: string; initial: Partial<AnamnesisData> | null }) {
  const [state, action, pending] = useActionState<AnamnesisFormState, FormData>(saveAnamnesisAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-5">
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} />
      <AnamnesisFields mode="practice" initial={initial} />
      <Checkbox name="updateRiskFlags" defaultChecked label="Risikomerkmale der Kundenakte (Diabetes, Blutverdünner, pAVK, Neuropathie, MRSA, Allergien) aus dieser Anamnese übernehmen" />
      <div>
        <Button type="submit" disabled={pending}>{pending ? "Wird gespeichert …" : "Als neue Version speichern"}</Button>
      </div>
      <FormError message={state?.error} />
    </form>
  );
}
