"use client";

import { useActionState } from "react";
import { Play } from "lucide-react";
import { Button, FormError, FormSuccess } from "@/components/ui";
import { keepValues } from "@/lib/forms";
import { runRemindersNowAction } from "./actions";

export function RunNowButton() {
  const [state, action, pending] = useActionState(runRemindersNowAction, undefined);
  return (
    <form onSubmit={keepValues(() => action())} className="flex flex-col gap-2">
      <FormError message={state?.error} />
      <FormSuccess message={state?.ok} />
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          <Play size={18} aria-hidden /> {pending ? "Läuft …" : "Jetzt ausführen"}
        </Button>
      </div>
    </form>
  );
}
