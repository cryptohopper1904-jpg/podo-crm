"use client";

import { useActionState } from "react";
import { Button, FormError } from "@/components/ui";
import { switchToFreeAction } from "./actions";

/**
 * „Kostenlos weiter nutzen“. Mit Rückfrage, wenn dabei etwas verloren geht (laufende Testphase, weitere
 * Teammitglieder) – der Wechsel ist nicht ohne Weiteres rückgängig zu machen.
 */
export function FreePlanForm({ disabledReason, warning }: { disabledReason: string | null; warning: string | null }) {
  const [state, action, pending] = useActionState(async () => switchToFreeAction(), undefined);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (warning && !window.confirm(`${warning}\n\nJetzt in den kostenlosen Tarif wechseln?`)) e.preventDefault();
      }}
      className="flex flex-col gap-3"
    >
      <FormError message={state?.error} revealKey={state} />
      {state?.ok ? <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">{state.ok}</p> : null}
      {disabledReason ? <p className="text-sm text-muted">{disabledReason}</p> : warning ? <p className="text-sm font-medium text-warn-soft-text">{warning}</p> : null}
      <div>
        <Button type="submit" variant="secondary" disabled={pending || !!disabledReason}>Kostenlos weiter nutzen</Button>
      </div>
    </form>
  );
}
