"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { resetPasswordAction } from "../../password-actions";

export function NewPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} />
      <input type="hidden" name="token" value={token} />
      <Field label="Neues Passwort" hint="mindestens 12 Zeichen">
        <Input name="password" type="password" autoComplete="new-password" minLength={12} required autoFocus />
      </Field>
      <Field label="Neues Passwort wiederholen">
        <Input name="confirm" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Passwort speichern"}</Button>
    </form>
  );
}
