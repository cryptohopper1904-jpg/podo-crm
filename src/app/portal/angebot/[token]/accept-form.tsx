"use client";

import { useActionState } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { acceptOfferAction } from "./actions";

export function AcceptOfferForm({ token, label }: { token: string; label: string }) {
  const [state, action, pending] = useActionState(acceptOfferAction, undefined);
  if (state?.ok) return <FormSuccess message={state.ok} />;
  if (state?.taken) return <FormError message={state.error} revealKey={state} />;
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <Button type="submit" disabled={pending}>{pending ? "Wird reserviert …" : `Termin annehmen: ${label}`}</Button>
      <FormError message={state?.error} revealKey={state} />
    </form>
  );
}
