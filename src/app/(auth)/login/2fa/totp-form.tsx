"use client";

import { useActionState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { verifyTotpAction } from "../../actions";

export function TotpForm() {
  const [state, action, pending] = useActionState(verifyTotpAction, undefined);
  return (
    <form action={action} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} />
      <Field label="Code">
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
      </Field>
      <Button type="submit" disabled={pending}>Bestätigen</Button>
    </form>
  );
}
