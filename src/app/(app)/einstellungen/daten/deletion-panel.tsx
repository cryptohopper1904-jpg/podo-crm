"use client";

import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Checkbox, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { cancelDeletionAction, requestDeletionAction } from "./actions";

/** Zweistufige Kündigung: 1) bewusst starten, 2) Praxisnamen eintippen + Aufbewahrungshinweis bestätigen. */
export function DeletionRequest({ practiceName }: { practiceName: string }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [state, run, pending] = useActionState(requestDeletionAction, undefined);
  if (step === 1) {
    return (
      <Button type="button" variant="danger" onClick={() => setStep(2)}>
        Praxis kündigen & löschen …
      </Button>
    );
  }
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-4 rounded-xl border border-danger/40 bg-accent-soft/40 p-4">
      <FormError message={state?.error} revealKey={state} />
      <FormSuccess message={state?.ok} />
      <p className="text-sm font-semibold">Schritt 2 von 2: Bitte bestätigen</p>
      <Checkbox name="acknowledge" required label="Ich habe einen vollständigen Export gesichert und bewahre ihn für die gesetzlichen Fristen auf." />
      <Field label={`Zur Bestätigung den Praxisnamen eingeben: „${practiceName}“`}>
        <Input name="confirmName" required autoComplete="off" spellCheck={false} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={pending}>{pending ? "…" : "Endgültig kündigen & Löschung beantragen"}</Button>
        <Button type="button" variant="ghost" onClick={() => setStep(1)}>Abbrechen</Button>
      </div>
    </form>
  );
}

export function DeletionCancel() {
  const [state, run, pending] = useActionState(cancelDeletionAction, undefined);
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-3">
      <FormError message={state?.error} revealKey={state} />
      <FormSuccess message={state?.ok} />
      <div>
        <Button type="submit" disabled={pending}>{pending ? "…" : "Löschung zurücknehmen"}</Button>
      </div>
    </form>
  );
}
