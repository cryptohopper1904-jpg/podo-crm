"use client";

import { useActionState, type ReactNode } from "react";
import { Button, FormError, FormSuccess } from "./ui";

type State = { error?: string; ok?: string } | undefined;

/** Kleines Formular-Gerüst für Server Actions mit Erfolg/Fehler-Anzeige. */
export function ActionForm({
  action,
  children,
  submit = "Speichern",
  className = "flex flex-col gap-4",
}: {
  action: (s: State, f: FormData) => Promise<State>;
  children: ReactNode;
  submit?: string;
  className?: string;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className={className}>
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      {children}
      <div>
        <Button type="submit" disabled={pending}>{pending ? "…" : submit}</Button>
      </div>
    </form>
  );
}
