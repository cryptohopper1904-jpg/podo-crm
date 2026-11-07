"use client";

import { useActionState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { loginAction } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <form action={action} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} />
      <Field label="E-Mail">
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Passwort">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Anmelden …" : "Anmelden"}
      </Button>
    </form>
  );
}
