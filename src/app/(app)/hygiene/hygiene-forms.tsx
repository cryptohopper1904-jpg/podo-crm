"use client";

import { useActionState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Checkbox, FormError, FormSuccess, Input } from "@/components/ui";
import { decideBatchAction } from "./actions";

/** Freigabe oder Sperre einer Charge (einmalig). */
export function DecideBatchForm({ id, code }: { id: string; code: string }) {
  const [state, run, pending] = useActionState(decideBatchAction, undefined);
  return (
    <form onSubmit={keepValues(run)} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={id} />
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <Checkbox name="indicatorConfirmed" label="Indikator & Prozessprotokoll geprüft, Verpackung intakt" />
      <label className="sr-only" htmlFor={`note-${id}`}>Bemerkung zu {code}</label>
      <Input id={`note-${id}`} name="note" placeholder="Bemerkung (bei Sperre Pflicht)" maxLength={500} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="released" disabled={pending}>Freigeben</Button>
        <Button
          type="submit"
          name="decision"
          value="rejected"
          variant="danger"
          disabled={pending}
          onClick={(e) => {
            if (!window.confirm(`Charge ${code} endgültig sperren?`)) e.preventDefault();
          }}
        >
          Sperren
        </Button>
      </div>
      <p className="text-xs text-muted">Die Entscheidung ist endgültig und wird mit Name und Zeit gespeichert.</p>
    </form>
  );
}
