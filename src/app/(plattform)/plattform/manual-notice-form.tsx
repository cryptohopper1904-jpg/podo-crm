"use client";

import { useActionState } from "react";
import { Button, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { FormError, FormSuccess } from "@/components/form-error";
import { MANUAL_NOTICE_VIAS } from "@/lib/readonly-expiry";
import { recordManualNoticeAction } from "./actions";

/**
 * Pflichtaktion der Plattform-Konsole: Die Ankündigung der Löschung (Ende des Nur-Lesen-Modus) ging nicht per E-Mail
 * raus. Betreiber kündigt von Hand in Textform an und vermerkt hier Zugang, Weg und Nachweis. Erst danach (und frühestens
 * 30 Tage nach Zugang) stellt der Cron den automatischen Löschantrag.
 */
export function ManualNoticeForm({ organizationId, today }: { organizationId: string; today: string }) {
  const [state, run, pending] = useActionState(recordManualNoticeAction, undefined);
  return (
    <form action={run} className="mt-3 grid gap-3 rounded-xl border border-border bg-surface-2 p-3 sm:grid-cols-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <div className="sm:col-span-2">
        <FormError message={state?.error} />
        <FormSuccess message={state?.ok} />
      </div>
      <Field label="Zugegangen am (bei Brief: Zustelltag)">
        <Input type="date" name="receivedOn" required max={today} defaultValue={today} />
      </Field>
      <Field label="Weg">
        <Select name="via" required defaultValue="email">
          {Object.entries(MANUAL_NOTICE_VIAS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </Field>
      <Field label="Nachweis (Notiz)" hint="z. B. Absender, Empfängeradresse, Ablage der Kopie – keine Patientendaten" className="sm:col-span-2">
        <Textarea name="note" required minLength={5} maxLength={300} rows={2} />
      </Field>
      <div className="sm:col-span-2">
        <Checkbox name="confirm" required label="Ich habe die Löschung mit Termin, Export-Hinweis und Weg zum Tarif in Textform an die Inhaber:innen angekündigt." />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>{pending ? "…" : "Ankündigung in Textform von Hand verschickt"}</Button>
      </div>
    </form>
  );
}
