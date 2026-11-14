"use client";

import { ActionForm } from "@/components/action-form";
import { Checkbox, Field, Input, Textarea } from "@/components/ui";

type State = { error?: string; ok?: string } | undefined;
type Action = (s: State, f: FormData) => Promise<State>;

export function SettingsForm({
  action,
  values,
}: {
  action: Action;
  values: { senderName: string; senderEmail: string; replyTo: string; impressum: string; delay2Days: number; delay3Days: number; mailProcessorConfirmed: boolean };
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
      <Checkbox
        name="mailProcessorConfirmed"
        defaultChecked={values.mailProcessorConfirmed}
        label="Der E-Mail-Versanddienstleister ist mit Name, Sitz, Serverstandort und AVV (ggf. SCC/DPF) unter „Unterauftragnehmer“ eingetragen. Ohne diese Bestätigung wird nicht versendet."
      />
    </ActionForm>
  );
}

export function LeadSearchForm({
  action,
  values,
}: {
  action: Action;
  values: { enabled: boolean; centerText: string; ringKm: number; maxKm: number; allowNamed: boolean };
}) {
  return (
    <ActionForm action={action} submit="Praxissuche speichern">
      <Checkbox name="enabled" defaultChecked={values.enabled} label="Jede Nacht automatisch den nächsten Ring durchsuchen" />
      <Field label="Startort" hint="Adresse oder PLZ und Ort (wird einmal über Photon/OpenStreetMap in Koordinaten umgewandelt) oder Koordinaten wie „52.39, 13.06“">
        <Input name="centerText" maxLength={200} defaultValue={values.centerText} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ringbreite (km)" hint="je Nacht ein Ring"><Input name="ringKm" type="number" min={2} max={50} defaultValue={values.ringKm} /></Field>
        <Field label="Höchstradius (km)" hint="danach stoppt die Suche"><Input name="maxKm" type="number" min={5} max={300} defaultValue={values.maxKm} /></Field>
      </div>
      <Checkbox
        name="allowNamed"
        defaultChecked={values.allowNamed}
        label="Auch Geschäftsadressen mit Namen übernehmen (nur von der eigenen Praxis-Website / Impressum, nur mit deren Domain)"
      />
      <Checkbox name="resetProgress" label="Fortschritt zurücksetzen (wieder bei 0 km beginnen)" />
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
