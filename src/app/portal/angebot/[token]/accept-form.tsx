"use client";

import { useActionState } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { acceptOfferAction } from "./actions";

export function AcceptOfferForm({ token, label }: { token: string; label: string }) {
  const [state, action, pending] = useActionState(acceptOfferAction, undefined);
  // Formular bleibt stehen (nur der Knopf entfällt, wenn erledigt): die Meldungen sind schon vor dem Absenden im DOM,
  // werden also angesagt und – weil der Knopf verschwindet – fokussiert (sonst fiele der Fokus auf <body>).
  const done = !!state?.ok || !!state?.taken;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {done ? null : <Button type="submit" disabled={pending}>{pending ? "Wird reserviert …" : `Termin annehmen: ${label}`}</Button>}
      <FormSuccess message={state?.ok} focus />
      <FormError message={state?.error} revealKey={state} />
    </form>
  );
}
