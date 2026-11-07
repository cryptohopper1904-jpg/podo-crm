"use client";

import { startTransition, type FormEvent } from "react";

/**
 * React 19 setzt Formulare nach einer Server Action automatisch zurück – auch bei Fehlern.
 * Das wäre in der Praxis fatal (z. B. Doku-Felder weg nach einer Validierungsmeldung).
 * `keepValues(dispatch)` sendet das Formular ohne Zurücksetzen. Der auslösende Button
 * (name/value, z. B. „Gegenzeichnen“) wird mitgeschickt.
 */
export function keepValues(dispatch: (fd: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(e.currentTarget, submitter ?? undefined);
    startTransition(() => dispatch(fd));
  };
}
