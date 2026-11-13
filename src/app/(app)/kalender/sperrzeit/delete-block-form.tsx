"use client";

import { useActionState, type MouseEvent } from "react";
import { Trash2 } from "lucide-react";
import { keepValues } from "@/lib/forms";
import { Button, FormError } from "@/components/ui";
import { deleteBlockAction } from "./actions";

/** Sperrzeit löschen – bei Serien wahlweise nur das angeklickte Vorkommen oder die ganze Serie. */
export function DeleteBlockForm({ id, series, occurrence, occurrenceLabel }: { id: string; series: boolean; occurrence: string; occurrenceLabel: string }) {
  const [state, action, pending] = useActionState(deleteBlockAction, undefined);
  const ask = (msg: string) => (e: MouseEvent<HTMLButtonElement>) => {
    if (!window.confirm(msg)) e.preventDefault();
  };
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="occurrence" value={occurrence} />
      <FormError message={state?.error} />
      <div className="flex flex-wrap gap-2">
        {series ? (
          <Button type="submit" name="scope" value="occurrence" variant="danger" disabled={pending} onClick={ask(`Nur das Vorkommen am ${occurrenceLabel} löschen?`)}>
            <Trash2 size={18} aria-hidden /> Nur dieses Vorkommen ({occurrenceLabel})
          </Button>
        ) : null}
        <Button type="submit" name="scope" value="series" variant="danger" disabled={pending} onClick={ask(series ? "Die ganze Serie löschen?" : "Sperrzeit löschen?")}>
          <Trash2 size={18} aria-hidden /> {series ? "Ganze Serie löschen" : "Sperrzeit löschen"}
        </Button>
      </div>
    </form>
  );
}
