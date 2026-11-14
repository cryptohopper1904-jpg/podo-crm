"use client";

import { useActionState } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { acceptedKey } from "./accepted-notice";
import { acceptOfferAction } from "./actions";

export function AcceptOfferForm({ token, label }: { token: string; label: string }) {
  const [state, action, pending] = useActionState(acceptOfferAction, undefined);
  if (state?.ok) return <FormSuccess message={state.ok} />;
  if (state?.taken) return <FormError message={state.error} />;
  return (
    <form
      onSubmit={(e) => {
        // Merker schon beim Absenden: die Seite lädt mit der Antwort neu (Zustand „angenommen“), bevor ein Effekt liefe
        try {
          window.sessionStorage.setItem(acceptedKey(token), "1");
        } catch {
          // ohne sessionStorage bleibt es bei „bereits angenommen“
        }
        keepValues(action)(e);
      }}
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="token" value={token} />
      <Button type="submit" disabled={pending}>{pending ? "Wird reserviert …" : `Termin annehmen: ${label}`}</Button>
      <FormError message={state?.error} />
    </form>
  );
}
