"use client";

import { useActionState, useState } from "react";
import { Button, Checkbox, FormError, FormSuccess } from "@/components/ui";
import { cancelSubscriptionAction, resumeSubscriptionAction } from "./actions";

/** „Abo kündigen“ in zwei Schritten: 1) bewusst starten, 2) Kündigung zum Periodenende ausdrücklich bestätigen. */
export function CancelSubscriptionForm({ periodEnd }: { periodEnd: string }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [state, run, pending] = useActionState(cancelSubscriptionAction, undefined);
  if (step === 1) {
    return (
      <div className="flex flex-col gap-3">
        <FormSuccess message={state?.ok} />
        <div>
          <Button type="button" variant="secondary" onClick={() => setStep(2)}>Abo kündigen …</Button>
        </div>
      </div>
    );
  }
  return (
    <form action={run} className="flex flex-col gap-4 rounded-xl border border-border bg-surface-2 p-4">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <p className="text-sm font-semibold">Kündigung bestätigen</p>
      <Checkbox name="confirm" required label={`Ich kündige das Abo zum ${periodEnd}. Meine Daten bleiben danach höchstens 12 Monate im Nur-Lesen-Modus erhalten und werden dann gelöscht (Ankündigung 30 Tage vorher).`} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={pending}>{pending ? "…" : "Abo zum Periodenende kündigen"}</Button>
        <Button type="button" variant="ghost" onClick={() => setStep(1)}>Abbrechen</Button>
      </div>
    </form>
  );
}

export function ResumeSubscriptionForm({ disabledReason }: { disabledReason?: string | null }) {
  const [state, run, pending] = useActionState(async () => resumeSubscriptionAction(), undefined);
  return (
    <form action={run} className="flex flex-col gap-3">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      {disabledReason ? <p className="text-sm text-muted">{disabledReason}</p> : null}
      <div>
        <Button type="submit" disabled={pending || !!disabledReason}>{pending ? "…" : "Kündigung zurücknehmen"}</Button>
      </div>
    </form>
  );
}
