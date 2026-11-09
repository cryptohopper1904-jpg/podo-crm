"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Button, Field, FormError, FormSuccess, Input } from "@/components/ui";
import { requestPasswordResetAction } from "../../password-actions";

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, undefined);
  if (state?.ok) return <div className="mt-6"><FormSuccess message={state.ok} /></div>;
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} />
      <Field label="E-Mail">
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Senden …" : "Link anfordern"}</Button>
    </form>
  );
}
