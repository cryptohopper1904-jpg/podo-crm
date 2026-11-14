"use client";

import { useActionState } from "react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { cancelPortalAppointmentAction } from "@/server/portal";

export function CancelAppointmentButton({ appointmentId, label }: { appointmentId: string; label: string }) {
  const [state, action, pending] = useActionState(cancelPortalAppointmentAction, undefined);
  if (state?.ok) return <FormSuccess message={state.ok} />;
  return (
    <form
      onSubmit={(e) => {
        if (!window.confirm(`Termin am ${label} wirklich absagen?`)) return e.preventDefault();
        keepValues(action)(e);
      }}
      className="flex flex-col items-end gap-2"
    >
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <Button type="submit" variant="danger" disabled={pending}>{pending ? "Sage ab …" : "Termin absagen"}</Button>
      <FormError message={state?.error ? `${state.error}${state.phone ? ` Telefon: ${state.phone}` : ""}` : null} revealKey={state} />
    </form>
  );
}
