"use client";

import { keepValues } from "@/lib/forms";
import { useActionState, type ReactNode } from "react";
import { Button, FormActions, FormError, FormSuccess } from "./ui";

type State = { error?: string; ok?: string } | undefined;

/**
 * Kleines Formular-Gerüst für Server Actions mit Erfolg/Fehler-Anzeige.
 * Fehler: oben im Formular (wird beim Absenden angesprungen, auch bei gleicher Meldung) und kurz neben dem Knopf.
 * `stickyActions`: Knopfleiste bei langen Formularen am unteren Rand halten (FormActions).
 */
export function ActionForm({
  action,
  children,
  submit = "Speichern",
  className = "flex flex-col gap-4",
  stickyActions = false,
}: {
  action: (s: State, f: FormData) => Promise<State>;
  children: ReactNode;
  submit?: string;
  className?: string;
  stickyActions?: boolean;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form onSubmit={keepValues(run)} className={className} aria-busy={pending || undefined}>
      <FormError message={state?.error} revealKey={state} />
      <FormSuccess message={state?.ok} />
      {children}
      <FormActions sticky={stickyActions} error={pending ? null : state?.error}>
        <Button type="submit" disabled={pending}>{pending ? "Wird gespeichert …" : submit}</Button>
      </FormActions>
    </form>
  );
}
