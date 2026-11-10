"use client";

import { ActionForm } from "@/components/action-form";
import { Field, Input, Textarea } from "@/components/ui";

type State = { error?: string; ok?: string } | undefined;
type Action = (s: State, f: FormData) => Promise<State>;

export function SettingsForm({
  action,
  values,
}: {
  action: Action;
  values: { senderName: string; senderEmail: string; replyTo: string; impressum: string; delay2Days: number; delay3Days: number };
}) {
  return (
    <ActionForm action={action} submit="Einstellungen speichern">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Absendername *" hint="z. B. Vor- und Nachname"><Input name="senderName" maxLength={80} defaultValue={values.senderName} /></Field>
        <Field label="Absender-E-Mail *" hint="bestätigte Domain beim Mail-Dienst"><Input name="senderEmail" type="email" maxLength={254} defaultValue={values.senderEmail} /></Field>
        <Field label="Antwortadresse" hint="leer = Absender-E-Mail"><Input name="replyTo" type="email" maxLength={254} defaultValue={values.replyTo} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tage bis Mail 2"><Input name="delay2Days" type="number" min={1} max={60} defaultValue={values.delay2Days} /></Field>
          <Field label="Tage bis Mail 3"><Input name="delay3Days" type="number" min={1} max={60} defaultValue={values.delay3Days} /></Field>
        </div>
      </div>
      <Field label="Impressum / Absenderangaben *" hint="Firma, Vertretungsberechtigte:r, Anschrift, E-Mail/Telefon, ggf. Register und USt-IdNr. – steht unter jeder Mail.">
        <Textarea name="impressum" rows={7} maxLength={1500} defaultValue={values.impressum} />
      </Field>
    </ActionForm>
  );
}

export function SuppressionForm({ action }: { action: Action }) {
  return (
    <ActionForm action={action} submit="Sperren">
      <Field label="E-Mail-Adresse sperren"><Input name="email" type="email" required maxLength={254} /></Field>
    </ActionForm>
  );
}
