"use client";

import { useActionState, useState } from "react";
import { Button, FormError } from "@/components/ui";
import { SignatureField } from "@/components/signature-field";
import { addSignatureAction, type SignatureState } from "../../actions";

/** Fehlende Unterschrift zu einer Behandlung nachtragen (oder Papier-Vermerk) – danach unveränderbar */
export function SignatureLater({ recordId, patientId, prescriptionId, patientName }: { recordId: string; patientId: string; prescriptionId: string; patientName: string }) {
  const [state, action, pending] = useActionState<SignatureState, FormData>(addSignatureAction, undefined);
  const [open, setOpen] = useState(false);
  const [filled, setFilled] = useState(false);
  if (state?.ok) return <p role="status" className="text-sm font-medium text-primary">{state.ok}</p>;
  if (!open) {
    return (
      <Button type="button" variant="secondary" className="text-sm" onClick={() => setOpen(true)}>
        Unterschrift nachtragen
      </Button>
    );
  }
  return (
    <form action={action} className="flex min-w-72 flex-col gap-2">
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="patientId" value={patientId} />
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <FormError message={state?.error} revealKey={state} />
      <SignatureField patientName={patientName} compact onChange={setFilled} />
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !filled} className="text-sm">{pending ? "Wird gespeichert …" : "Speichern (unveränderbar)"}</Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={() => setOpen(false)}>Abbrechen</Button>
      </div>
    </form>
  );
}
