import { Field, Input } from "@/components/ui";
import { AddressAutocomplete, ZipInput } from "@/components/address-autocomplete";

export function CareHomeFields({ home }: { home?: { id: string; name: string; street: string | null; zip: string | null; city: string | null; email: string | null; phone: string | null } }) {
  return (
    <>
      {home ? <input type="hidden" name="id" value={home.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name der Einrichtung" className="sm:col-span-2"><Input name="name" required defaultValue={home?.name} /></Field>
        <Field label="Straße"><AddressAutocomplete name="street" defaultValue={home?.street ?? ""} /></Field>
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <Field label="PLZ"><ZipInput name="zip" defaultValue={home?.zip ?? ""} /></Field>
          <Field label="Ort"><Input name="city" defaultValue={home?.city ?? ""} /></Field>
        </div>
        <Field label="Ansprechpartner / Telefon"><Input name="phone" defaultValue={home?.phone ?? ""} placeholder="z. B. Wohnbereichsleitung, 0331 …" /></Field>
        <Field label="E-Mail (für Sammelrechnungen)"><Input name="email" type="email" defaultValue={home?.email ?? ""} /></Field>
      </div>
    </>
  );
}
