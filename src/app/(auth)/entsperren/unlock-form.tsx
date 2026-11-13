"use client";

import { useActionState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { unlockAction } from "./actions";

export function UnlockForm({ hasPin }: { hasPin: boolean }) {
  const [state, action, pending] = useActionState(unlockAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      <Field label={hasPin ? "PIN oder Passwort" : "Passwort"}>
        <Input name="secret" type="password" autoComplete="off" autoFocus required />
      </Field>
      <Button type="submit" disabled={pending}>Entsperren</Button>
    </form>
  );
}
