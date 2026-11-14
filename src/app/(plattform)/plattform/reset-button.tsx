"use client";

import { useActionState } from "react";
import { platformSendPasswordResetAction } from "@/app/(auth)/password-actions";

/** Schickt einer Praxis-Inhaberin/einem Praxis-Inhaber den Link „Passwort neu setzen“ – das Passwort sieht niemand. */
export function ResetButton({ userId, label }: { userId: string; label: string }) {
  const [state, action, pending] = useActionState(platformSendPasswordResetAction, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <button disabled={pending} className="text-sm font-semibold text-primary disabled:opacity-50">
        {pending ? "Sende …" : `Passwort-Link an ${label}`}
      </button>
      {state?.ok ? <span className="text-xs text-success">{state.ok}</span> : null}
      {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}
