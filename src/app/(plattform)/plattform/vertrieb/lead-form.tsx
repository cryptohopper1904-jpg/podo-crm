"use client";

import { ActionForm } from "@/components/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { DELETE_MONTHS } from "@/lib/vertrieb/dsgvo";

type State = { error?: string; ok?: string } | undefined;

export type LeadFormValues = {
  id?: string;
  name?: string;
  contactPerson?: string | null;
  email?: string | null;
  /** nur übergeben, wenn sichtbar (Einwilligung oder Bestandskunde) – sonst gelangt die Nummer nicht in den Browser */
  phone?: string | null;
  website?: string | null;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  distanceKm?: number | null;
  source?: string | null;
  sourceRetrievedAt?: string | null;
  notes?: string | null;
  /** Löschfrist in Monaten ab Anlage (6–24); null = keine ganze Monatszahl (Altbestand) */
  deleteMonths?: number | null;
  /** Löschdatum zur Anzeige (TT.MM.JJJJ) */
  deleteAfterLabel?: string | null;
};

const MONTHS = Array.from({ length: DELETE_MONTHS.max - DELETE_MONTHS.min + 1 }, (_, i) => DELETE_MONTHS.min + i);

export function LeadForm({
  action,
  values = {},
  submit,
  phoneHidden = false,
  phoneStored = false,
  today,
}: {
  action: (s: State, f: FormData) => Promise<State>;
  values?: LeadFormValues;
  submit: string;
  /** Telefonnummer ausblenden (keine Einwilligung, kein Bestandskunde) */
  phoneHidden?: boolean;
  /** es ist eine (ausgeblendete) Telefonnummer gespeichert */
  phoneStored?: boolean;
  /** heutiges Datum YYYY-MM-DD (deutsche Zeit) – Obergrenze für das Abrufdatum */
  today: string;
}) {
  const v = (x: string | number | null | undefined) => (x === null || x === undefined ? "" : String(x));
  const months = values.deleteMonths ?? (values.id ? "" : DELETE_MONTHS.default);
  return (
    <ActionForm action={action} submit={submit}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      {phoneHidden ? <input type="hidden" name="phoneHidden" value="1" /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name der Praxis *"><Input name="name" required maxLength={200} defaultValue={v(values.name)} /></Field>
        <Field label="Ansprechpartner:in" hint="z. B. „Frau Muster“ – erscheint in der Anrede"><Input name="contactPerson" maxLength={120} defaultValue={v(values.contactPerson)} /></Field>
        <Field label="E-Mail"><Input name="email" type="email" maxLength={254} defaultValue={v(values.email)} /></Field>
        {phoneHidden ? (
          <Field
            label="Telefon"
            hint={phoneStored ? "Nummer hinterlegt, aber ausgeblendet: Anzeige nur mit Einwilligung oder bei Bestandskunden. Leer lassen = Nummer behalten." : "Wird erst mit Einwilligung oder bei Bestandskunden angezeigt."}
          >
            <Input name="phone" maxLength={60} defaultValue="" placeholder={phoneStored ? "ausgeblendet" : ""} autoComplete="off" />
          </Field>
        ) : (
          <Field label="Telefon"><Input name="phone" maxLength={60} defaultValue={v(values.phone)} /></Field>
        )}
        <Field label="Website"><Input name="website" type="url" maxLength={300} placeholder="https://" defaultValue={v(values.website)} /></Field>
        <Field label="Straße"><Input name="street" maxLength={200} defaultValue={v(values.street)} /></Field>
        <Field label="PLZ"><Input name="zip" maxLength={10} defaultValue={v(values.zip)} /></Field>
        <Field label="Ort"><Input name="city" maxLength={120} defaultValue={v(values.city)} /></Field>
        <Field label="Entfernung (km)"><Input name="distanceKm" inputMode="decimal" maxLength={10} defaultValue={v(values.distanceKm)} /></Field>
        <Field label="Quelle der Daten *" hint="Pflicht (Art. 14 DSGVO), z. B. „OpenStreetMap“ oder „Impressum praxis-muster.example“">
          <Input name="source" required minLength={3} maxLength={200} defaultValue={v(values.source)} />
        </Field>
        <Field label="Abgerufen am *" hint="Datum, an dem die Daten aus der Quelle übernommen wurden">
          <Input name="sourceRetrievedAt" type="date" required max={today} defaultValue={v(values.sourceRetrievedAt ?? (values.id ? null : today))} />
        </Field>
        <Field
          label="Löschfrist"
          hint={`Monate ab Anlage (${DELETE_MONTHS.min}–${DELETE_MONTHS.max}, Standard ${DELETE_MONTHS.default}).${values.deleteAfterLabel ? ` Derzeit: Löschung am ${values.deleteAfterLabel}.` : ""} Ohne Einwilligung und ohne Status „Kunde“ wird der Eintrag danach automatisch gelöscht.`}
        >
          <Select name="deleteMonths" defaultValue={String(months)} required>
            {months === "" ? <option value="">bitte wählen</option> : null}
            {MONTHS.map((m) => <option key={m} value={m}>{m} Monate</option>)}
          </Select>
        </Field>
      </div>
      {phoneHidden && phoneStored ? <Checkbox name="clearPhone" label="Hinterlegte Telefonnummer löschen" /> : null}
      <Field label="Notizen"><Textarea name="notes" maxLength={2000} rows={4} defaultValue={v(values.notes)} /></Field>
    </ActionForm>
  );
}
