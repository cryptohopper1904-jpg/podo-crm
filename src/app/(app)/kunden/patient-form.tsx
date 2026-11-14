"use client";

import { keepValues } from "@/lib/forms";
import Link from "next/link";
import { useActionState, useState, type FormEvent } from "react";
import type { patients } from "@/db/schema";
import { Button, Card, Checkbox, Field, FieldSlot, FormActions, FormError, Input, Select, Textarea } from "@/components/ui";
import { AddressAutocomplete, ZipInput } from "@/components/address-autocomplete";
import { savePatientAction } from "./actions";

type P = typeof patients.$inferSelect;

function toDe(iso?: string | null) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** privateOnly: Praxis nur für Privat-/Selbstzahler (src/lib/features.ts) → Kassendaten eingeklappt und optional */
export function PatientForm({ patient, privateOnly = false }: { patient?: P; privateOnly?: boolean }) {
  const [state, action, pending] = useActionState(savePatientAction, undefined);
  const r = patient?.riskFlags ?? {};
  // Pflichtfeld Nachname: Meldung am Feld (statt Browser-Blase in Systemsprache), Fokus dorthin
  const [lastNameError, setLastNameError] = useState<string | null>(null);
  const submit = keepValues(action);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const input = e.currentTarget.elements.namedItem("lastName") as HTMLInputElement | null;
    if (input && !input.value.trim()) {
      e.preventDefault();
      setLastNameError("Bitte einen Nachnamen eintragen.");
      input.scrollIntoView({ block: "center" });
      input.focus({ preventScroll: true });
      return;
    }
    setLastNameError(null);
    submit(e);
  }
  const kassenFields = (
    <>
      <Field label={privateOnly ? "Krankenkasse (optional)" : "Krankenkasse"}><Input name="insurerName" defaultValue={patient?.insurerName ?? ""} /></Field>
      <Field label={privateOnly ? "Versichertennummer (optional)" : "Versichertennummer"}><Input name="insuranceNumber" defaultValue={patient?.insuranceNumber ?? ""} /></Field>
    </>
  );
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {patient ? <input type="hidden" name="id" value={patient.id} /> : null}
      <FormError message={state?.error} revealKey={state} />
      {state?.duplicates?.length ? (
        <Card className="border-accent">
          <p className="font-semibold">Mögliche Dubletten:</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {state.duplicates.map((d) => (
              <li key={d.id}>
                <Link className="text-primary underline" href={`/kunden/${d.id}`}>#{d.number} {d.name}</Link>
              </li>
            ))}
          </ul>
          <Checkbox name="ignoreDuplicates" value="1" label="Trotzdem neu anlegen" />
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Person</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Anrede">
            <Select name="salutation" defaultValue={patient?.salutation ?? ""}>
              <option value="">–</option>
              <option>Frau</option>
              <option>Herr</option>
              <option>Divers</option>
            </Select>
          </Field>
          <Field label="Titel"><Input name="title" defaultValue={patient?.title ?? ""} /></Field>
          <Field label="Vorname"><Input name="firstName" defaultValue={patient?.firstName ?? ""} autoComplete="off" /></Field>
          <Field label="Nachname *" id="patient-lastName" error={lastNameError}>
            <Input name="lastName" aria-required="true" defaultValue={patient?.lastName ?? ""} autoComplete="off" onChange={(e) => lastNameError && e.target.value.trim() && setLastNameError(null)} />
          </Field>
          <Field label="Geburtsdatum" hint="TT.MM.JJJJ"><Input name="birthDate" defaultValue={toDe(patient?.birthDate)} placeholder="01.02.1950" inputMode="numeric" /></Field>
          <Field label="Straße" className="sm:col-span-2"><AddressAutocomplete name="street" defaultValue={patient?.street ?? ""} placeholder="z. B. Friedrich-Herder-Str. 12" /></Field>
          <Field label="PLZ"><ZipInput name="zip" defaultValue={patient?.zip ?? ""} /></Field>
          <Field label="Ort"><Input name="city" defaultValue={patient?.city ?? ""} /></Field>
          <Field label="Mobil"><Input name="phoneMobile" type="tel" defaultValue={patient?.phoneMobile ?? ""} /></Field>
          <Field label="Festnetz"><Input name="phoneLandline" type="tel" defaultValue={patient?.phoneLandline ?? ""} /></Field>
          <Field label="E-Mail"><Input name="email" type="email" defaultValue={patient?.email ?? ""} /></Field>
          <Field label="Bevorzugter Kanal">
            <Select name="preferredChannel" defaultValue={patient?.preferredChannel ?? "none"}>
              <option value="none">keine Angabe</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="sms">SMS</option>
              <option value="email">E-Mail</option>
              <option value="phone">Telefon</option>
              <option value="letter">Brief</option>
            </Select>
          </Field>
          <Field label="Wunsch-Intervall"><Input suffix="Wochen" name="visitIntervalWeeks" type="number" min={1} max={52} defaultValue={patient?.visitIntervalWeeks ?? ""} /></Field>
          <FieldSlot spacer="hidden sm:block"><Checkbox name="homeVisit" defaultChecked={patient?.homeVisit} label="Hausbesuch" /></FieldSlot>
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 font-display text-lg font-semibold">Versicherung</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status">
            <Select name="insuranceType" defaultValue={patient?.insuranceType ?? "self"}>
              <option value="self">Selbstzahler</option>
              <option value="gkv">Gesetzlich (GKV)</option>
              <option value="pkv">Privat (PKV)</option>
              <option value="beihilfe">Beihilfe</option>
            </Select>
          </Field>
          {privateOnly ? (
            <details className="sm:col-span-2" open={!!(patient?.insurerName || patient?.insuranceNumber)}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-muted">Kassendaten (optional)</summary>
              <div className="grid gap-4 sm:grid-cols-2">{kassenFields}</div>
            </details>
          ) : kassenFields}
          <Field label="Hausarzt"><Input name="gpName" defaultValue={patient?.gpName ?? ""} /></Field>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 font-display text-lg font-semibold">Risiken</h2>
        <p className="mb-4 text-sm text-muted">Werden in der Akte und im Kalender immer oben angezeigt.</p>
        <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
          <Checkbox name="risk_diabetes" defaultChecked={r.diabetes} label="Diabetes mellitus" />
          <Checkbox name="risk_anticoagulation" defaultChecked={r.anticoagulation} label="Blutverdünner (Antikoagulation)" />
          <Checkbox name="risk_pavk" defaultChecked={r.pavk} label="pAVK / Durchblutungsstörung" />
          <Checkbox name="risk_neuropathy" defaultChecked={r.neuropathy} label="Neuropathie" />
          <Checkbox name="risk_mrsa" defaultChecked={r.mrsa} label="MRSA / multiresistente Keime" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Diabetes-Typ"><Input name="risk_diabetesType" defaultValue={r.diabetesType ?? ""} placeholder="z. B. Typ 2, insulinpflichtig" /></Field>
          <Field label="Allergien"><Input name="risk_allergies" defaultValue={r.allergies ?? ""} placeholder="z. B. Latex, Jod" /></Field>
        </div>
      </Card>

      {/* Optional: eingeklappt, solange leer (kürzeres Formular auf dem Handy) */}
      <Card className="p-0">
        <details open={!!patient?.notes} className="group">
          <summary className="flex min-h-14 cursor-pointer items-center px-5 font-display text-lg font-semibold">Hinweis (optional)</summary>
          <div className="px-5 pb-5">
            <Field label="Hinweis (organisatorisch, keine Befunde)">
              <Textarea name="notes" defaultValue={patient?.notes ?? ""} />
            </Field>
          </div>
        </details>
      </Card>

      {/* Klebende Aktionsleiste (ui.tsx FormActions): Speichern ohne Scrollen ans Ende erreichbar */}
      <FormActions error={state?.error}>
        <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Speichern"}</Button>
        <Link href={patient ? `/kunden/${patient.id}` : "/kunden"} className="inline-flex h-11 items-center rounded-xl px-4 font-semibold text-muted hover:bg-surface-2">Abbrechen</Link>
      </FormActions>
    </form>
  );
}
