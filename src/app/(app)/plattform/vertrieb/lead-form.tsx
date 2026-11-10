"use client";

import { ActionForm } from "@/components/action-form";
import { Field, Input, Textarea } from "@/components/ui";

type State = { error?: string; ok?: string } | undefined;

export type LeadFormValues = {
  id?: string;
  name?: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  distanceKm?: number | null;
  source?: string | null;
  notes?: string | null;
};

export function LeadForm({ action, values = {}, submit }: { action: (s: State, f: FormData) => Promise<State>; values?: LeadFormValues; submit: string }) {
  const v = (x: string | number | null | undefined) => (x === null || x === undefined ? "" : String(x));
  return (
    <ActionForm action={action} submit={submit}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name der Praxis *"><Input name="name" required maxLength={200} defaultValue={v(values.name)} /></Field>
        <Field label="Ansprechpartner:in" hint="z. B. „Frau Muster“ – erscheint in der Anrede"><Input name="contactPerson" maxLength={120} defaultValue={v(values.contactPerson)} /></Field>
        <Field label="E-Mail"><Input name="email" type="email" maxLength={254} defaultValue={v(values.email)} /></Field>
        <Field label="Telefon"><Input name="phone" maxLength={60} defaultValue={v(values.phone)} /></Field>
        <Field label="Website"><Input name="website" type="url" maxLength={300} placeholder="https://" defaultValue={v(values.website)} /></Field>
        <Field label="Straße"><Input name="street" maxLength={200} defaultValue={v(values.street)} /></Field>
        <Field label="PLZ"><Input name="zip" maxLength={10} defaultValue={v(values.zip)} /></Field>
        <Field label="Ort"><Input name="city" maxLength={120} defaultValue={v(values.city)} /></Field>
        <Field label="Entfernung (km)"><Input name="distanceKm" inputMode="decimal" maxLength={10} defaultValue={v(values.distanceKm)} /></Field>
        <Field label="Quelle" hint="z. B. OpenStreetMap, Website/Impressum"><Input name="source" maxLength={120} defaultValue={v(values.source)} /></Field>
      </div>
      <Field label="Notizen"><Textarea name="notes" maxLength={2000} rows={4} defaultValue={v(values.notes)} /></Field>
    </ActionForm>
  );
}
