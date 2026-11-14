"use client";

import { useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { revealMessage } from "@/components/form-error";
import { keepValues } from "@/lib/forms";
import { acceptOfferAction } from "./actions";

/**
 * In diesem Tab gerade angenommen? Die Annahme ruft refresh() auf – Next lädt die Seite dabei neu vom Server, und
 * statt des Formulars erscheint die Ansicht „angenommen“ (OfferAcceptedNotice). Der Knopf ist dann weg; ohne dieses
 * Merkmal fiele der Fokus auf <body>.
 */
let submittedHere = false;

export function AcceptOfferForm({ token, label }: { token: string; label: string }) {
  const [state, action, pending] = useActionState(acceptOfferAction, undefined);
  const submit = keepValues(action);
  // Formular bleibt stehen (nur der Knopf entfällt, wenn erledigt): die Meldungen sind schon vor dem Absenden im DOM,
  // werden also angesagt und – weil der Knopf verschwindet – fokussiert (sonst fiele der Fokus auf <body>).
  const done = !!state?.ok || !!state?.taken;
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        submittedHere = true;
        submit(e);
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="token" value={token} />
      {done ? null : <Button type="submit" disabled={pending}>{pending ? "Wird reserviert …" : `Termin annehmen: ${label}`}</Button>}
      <FormSuccess message={state?.ok} focus />
      <FormError message={state?.error} revealKey={state} />
    </form>
  );
}

/**
 * Ansicht „Termin angenommen“: wurde der Termin gerade in diesem Tab angenommen, bekommt sie den Fokus (Screenreader
 * lesen sie vor). Beim normalen Aufruf des Links (z. B. später erneut geöffnet) wird nichts fokussiert.
 */
export function OfferAcceptedNotice({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!submittedHere || !ref.current) return;
    submittedHere = false;
    revealMessage(ref.current);
  }, []);
  return (
    <div ref={ref} tabIndex={-1} role="region" aria-labelledby={labelledBy} data-offer-accepted className="rounded-[var(--radius-card)]">
      {children}
    </div>
  );
}
