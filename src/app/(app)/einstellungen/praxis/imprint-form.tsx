"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { DEFAULT_REGULATIONS, LEGAL_FORMS, PROFESSIONS, requiresRegister, type ImprintSettings } from "@/lib/imprint";
import { saveImprintAction } from "../actions";

const OTHER = "__andere";

/** Impressums-Pflichtangaben (§ 5 DDG) für Praxis-Website und Online-Buchung */
export function ImprintForm({ initial }: { initial: ImprintSettings }) {
  const known = (PROFESSIONS as readonly string[]).includes(initial.profession);
  const [choice, setChoice] = useState(initial.profession === "" ? "" : known ? initial.profession : OTHER);
  const [legalForm, setLegalForm] = useState(initial.legalForm);
  const freeText = choice === OTHER;
  const register = requiresRegister(legalForm);
  // PodG-Standardtext nur bei „Podologin/Podologe“ vorbelegen; bei Freitext nur eigene Angaben der Praxis
  const regulations = freeText ? (initial.regulations === DEFAULT_REGULATIONS ? "" : initial.regulations) : initial.regulations || DEFAULT_REGULATIONS;
  return (
    <ActionForm action={saveImprintAction}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Rechtsform (optional)" id="imprint-legal-form" hint="Bei Einzelpraxis steht im Impressum „Inhaberin/Inhaber“.">
          <Select name="legalForm" value={legalForm} onChange={(e) => setLegalForm(e.target.value)}>
            <option value="">– keine Angabe –</option>
            {LEGAL_FORMS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
        </Field>
        <Field label="Inhaber:in bzw. vertretungsberechtigte Person *" id="imprint-owner">
          <Input name="owner" defaultValue={initial.owner} maxLength={200} autoComplete="name" />
        </Field>
        {register ? (
          <>
            <Field label="Registergericht *" id="imprint-register-court" hint="z. B. Amtsgericht Neuruppin">
              <Input name="registerCourt" defaultValue={initial.registerCourt} maxLength={120} />
            </Field>
            <Field label="Registernummer *" id="imprint-register-number" hint="z. B. HRB 12345 oder PR 123">
              <Input name="registerNumber" defaultValue={initial.registerNumber} maxLength={60} />
            </Field>
          </>
        ) : null}
        <Field label="Berufsbezeichnung *" id="imprint-profession">
          <Select name="professionChoice" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">– wählen –</option>
            {PROFESSIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            <option value={OTHER}>andere (Freitext)</option>
          </Select>
        </Field>
        {freeText ? (
          <Field label="Berufsbezeichnung (Freitext) *">
            <Input name="professionOther" defaultValue={known ? "" : initial.profession} maxLength={120} />
          </Field>
        ) : null}
        <Field label="Staat der Verleihung">
          <Input name="professionState" defaultValue={initial.professionState} maxLength={120} />
        </Field>
        {/* key: beim Wechsel Podologin/Podologe ↔ Freitext neu vorbelegen (Standardtext nur für PodG-Berufe) */}
        <Field
          key={freeText ? "frei" : "podg"}
          label="Berufsrechtliche Regelungen"
          className="sm:col-span-2"
          hint={freeText ? "Für deinen Beruf geltende Regelungen und wo sie abrufbar sind (falls es welche gibt)." : `Standard: ${DEFAULT_REGULATIONS}`}
        >
          <Textarea name="regulations" rows={2} defaultValue={regulations} maxLength={500} />
        </Field>
        <Field label="Zuständige Aufsichtsbehörde (optional)" className="sm:col-span-2" hint="z. B. Gesundheitsamt des Landkreises – nur wenn für die Praxis zutreffend.">
          <Textarea name="authority" rows={2} defaultValue={initial.authority} maxLength={500} />
        </Field>
        <Field label="Wirtschafts-Identifikationsnummer (optional)" id="imprint-economic-id" hint="W-IdNr., sobald das Finanzamt sie mitgeteilt hat.">
          <Input name="economicId" defaultValue={initial.economicId} maxLength={40} />
        </Field>
        <Field label="Datenschutzbeauftragte:r (optional)" id="imprint-dpo" hint="Name und Kontakt – erscheint im Impressum und in den Datenschutzhinweisen.">
          <Textarea name="dpo" rows={2} defaultValue={initial.dpo} maxLength={500} />
        </Field>
      </div>
    </ActionForm>
  );
}
