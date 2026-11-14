"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { DEFAULT_REGULATIONS, PROFESSIONS, type ImprintSettings } from "@/lib/imprint";
import { saveImprintAction } from "../actions";

const OTHER = "__andere";

/** Impressums-Pflichtangaben (§ 5 DDG) für Praxis-Website und Online-Buchung */
export function ImprintForm({ initial }: { initial: ImprintSettings }) {
  const known = (PROFESSIONS as readonly string[]).includes(initial.profession);
  const [choice, setChoice] = useState(initial.profession === "" ? "" : known ? initial.profession : OTHER);
  return (
    <ActionForm action={saveImprintAction}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Inhaber:in bzw. vertretungsberechtigte Person *" id="imprint-owner">
          <Input name="owner" defaultValue={initial.owner} maxLength={200} autoComplete="name" />
        </Field>
        <Field label="Berufsbezeichnung *" id="imprint-profession">
          <Select name="professionChoice" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">– wählen –</option>
            {PROFESSIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            <option value={OTHER}>andere (Freitext)</option>
          </Select>
        </Field>
        {choice === OTHER ? (
          <Field label="Berufsbezeichnung (Freitext) *">
            <Input name="professionOther" defaultValue={known ? "" : initial.profession} maxLength={120} />
          </Field>
        ) : null}
        <Field label="Staat der Verleihung">
          <Input name="professionState" defaultValue={initial.professionState} maxLength={120} />
        </Field>
        <Field label="Berufsrechtliche Regelungen" className="sm:col-span-2" hint={`Standard: ${DEFAULT_REGULATIONS}`}>
          <Textarea name="regulations" rows={2} defaultValue={initial.regulations} maxLength={500} />
        </Field>
        <Field label="Zuständige Aufsichtsbehörde (optional)" className="sm:col-span-2" hint="z. B. Gesundheitsamt des Landkreises – nur wenn für die Praxis zutreffend.">
          <Textarea name="authority" rows={2} defaultValue={initial.authority} maxLength={500} />
        </Field>
      </div>
    </ActionForm>
  );
}
