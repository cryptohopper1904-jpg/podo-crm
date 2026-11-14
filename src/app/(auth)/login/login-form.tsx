"use client";

import Link from "next/link";
import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import { loginAction } from "../actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} revealKey={state} />
      <Field label="E-Mail">
        <Input name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Passwort">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Anmelden …" : "Anmelden"}
      </Button>
      <Link href="/login/passwort-vergessen" className="inline-flex min-h-11 items-center justify-center text-sm font-semibold text-primary">Passwort vergessen?</Link>
    </form>
  );
}
