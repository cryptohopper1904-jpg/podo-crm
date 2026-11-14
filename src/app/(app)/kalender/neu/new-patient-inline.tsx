"use client";

import { UserPlus } from "lucide-react";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { Button, Field, FormError, Input } from "@/components/ui";
import type { PickerPatient } from "@/lib/calendar-patient-search";
import { quickCreatePatientAction } from "../actions";

/**
 * Neue Patient:in direkt im Terminformular (kein eigenes <form> – liegt im Terminformular): Vorname, Nachname,
 * Telefon, optional Geburtsdatum und E-Mail. Legt über quickCreatePatientAction an (Rechte, Prüfung und
 * Dublettenprüfung wie unter Patienten → Neu) und wählt die Person direkt aus. Bei möglichen Dubletten
 * „Meinten Sie …?“ mit Auswahl oder „trotzdem anlegen“. Enter in einem Feld legt an (statt den Termin zu speichern).
 */
export function NewPatientInline({
  initial,
  known,
  onCreated,
  onCancel,
}: {
  initial: { firstName: string; lastName: string };
  /** bekannte Patient:innen (für die Auswahl aus „Meinten Sie …?“) */
  known: PickerPatient[];
  onCreated: (p: PickerPatient) => void;
  onCancel: () => void;
}) {
  const [state, run, pending] = useActionState(quickCreatePatientAction, undefined);
  const [v, setV] = useState({ firstName: initial.firstName, lastName: initial.lastName, phoneMobile: "", birthDate: "", email: "" });
  const first = useRef<HTMLInputElement>(null);
  const phone = useRef<HTMLInputElement>(null);
  const done = useRef<string | null>(null);
  const startWithPhone = useRef(!!initial.lastName);

  // beim Öffnen: Name aus der Suche steht schon da → weiter mit Telefon
  useEffect(() => {
    (startWithPhone.current ? phone.current : first.current)?.focus();
  }, []);
  useEffect(() => {
    const p = state?.patient;
    if (p && done.current !== p.id) {
      done.current = p.id;
      onCreated(p);
    }
  }, [state, onCreated]);

  const submit = (ignoreDuplicates = false) => {
    const fd = new FormData();
    for (const [k, val] of Object.entries(v)) fd.set(k, val);
    if (ignoreDuplicates) fd.set("ignoreDuplicates", "1");
    startTransition(() => run(fd));
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary-soft/30 p-3" aria-busy={pending || undefined}>
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
        <UserPlus size={16} aria-hidden /> Neue:n Patient:in anlegen
      </legend>
      <FormError message={state?.error} revealKey={state} />
      {state?.duplicates?.length ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold">Meinten Sie …?</p>
          <ul className="flex flex-col gap-1.5">
            {state.duplicates.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onCreated(known.find((k) => k.id === d.id) ?? { id: d.id, number: d.number, firstName: null, lastName: d.name })}
                  className="inline-flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 text-left hover:border-primary"
                >
                  <span className="font-semibold">{d.name}</span>
                  <span className="text-muted">#{d.number} · auswählen</span>
                </button>
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => submit(true)}>
              Trotzdem neu anlegen
            </Button>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Vorname">
          <Input ref={first} value={v.firstName} onChange={set("firstName")} onKeyDown={onEnter} autoComplete="off" />
        </Field>
        <Field label="Nachname">
          <Input value={v.lastName} onChange={set("lastName")} onKeyDown={onEnter} autoComplete="off" />
        </Field>
        <Field label="Telefon (mobil)">
          <Input ref={phone} type="tel" inputMode="tel" value={v.phoneMobile} onChange={set("phoneMobile")} onKeyDown={onEnter} autoComplete="off" />
        </Field>
        <Field label="Geburtsdatum (optional)">
          <Input type="date" value={v.birthDate} onChange={set("birthDate")} onKeyDown={onEnter} clearable placeholder="optional" />
        </Field>
        <Field label="E-Mail (optional)" className="sm:col-span-2">
          <Input type="email" inputMode="email" value={v.email} onChange={set("email")} onKeyDown={onEnter} autoComplete="off" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => submit()}>
          {pending ? "Wird angelegt …" : "Anlegen und auswählen"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Abbrechen
        </Button>
      </div>
    </fieldset>
  );
}
