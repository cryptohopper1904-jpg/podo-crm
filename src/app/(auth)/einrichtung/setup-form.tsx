"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Button, Checkbox, Field, FormError, Input, Select } from "@/components/ui";
import { STATES } from "@/lib/holidays";
import { setupAction } from "../actions";

export function SetupForm({ needsToken = false }: { needsToken?: boolean }) {
  const [state, action, pending] = useActionState(setupAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} />
      {needsToken ? (
        <Field label="Einrichtungs-Code" hint="Steht als SETUP_TOKEN in der Server-Konfiguration.">
          <Input name="setupToken" required autoComplete="off" />
        </Field>
      ) : null}
      <Field label="Name der Praxis">
        <Input name="practiceName" required placeholder="Podologie am Markt" />
      </Field>
      <Field label="Bundesland" hint="Für Feiertage im Kalender">
        <Select name="state" defaultValue="BB">
          {Object.entries(STATES).map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Dein Name">
        <Input name="name" required autoComplete="name" />
      </Field>
      <Field label="E-Mail">
        <Input name="email" type="email" required autoComplete="username" />
      </Field>
      <Field label="Passwort" hint="Mindestens 12 Zeichen. Ein Satz ist sicherer als ein kurzes Sonderzeichen-Passwort.">
        <Input name="password" type="password" required minLength={12} autoComplete="new-password" />
      </Field>
      <Checkbox
        name="privacy"
        required
        label={<>Ich habe die Datenschutzhinweise und den Auftragsverarbeitungsvertrag (AVV) gelesen.</>}
      />
      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Wird eingerichtet …" : "Praxis anlegen"}
      </Button>
    </form>
  );
}
