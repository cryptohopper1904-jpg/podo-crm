"use client";

import { useActionState } from "react";
import { Button, FormError } from "@/components/ui";
import { switchToFreeAction } from "./actions";

export function FreePlanForm({ disabledReason }: { disabledReason: string | null }) {
  const [state, action, pending] = useActionState(switchToFreeAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormError message={state?.error} />
      {state?.ok ? <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">{state.ok}</p> : null}
      {disabledReason ? <p className="text-sm text-muted">{disabledReason}</p> : null}
      <div>
        <Button type="submit" variant="secondary" disabled={pending || !!disabledReason}>Kostenlos weiter nutzen</Button>
      </div>
    </form>
  );
}
