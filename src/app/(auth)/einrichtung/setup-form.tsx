"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Button, Checkbox, Field, FormError, Input, Select } from "@/components/ui";
import { STATES } from "@/lib/holidays";
import { LEGAL_VERSIONS } from "@/lib/legal";
import { setupAction } from "../actions";

export function SetupForm({ needsToken = false, saas = false, code = "", trialText = null }: { needsToken?: boolean; saas?: boolean; code?: string; trialText?: string | null }) {
  const [state, action, pending] = useActionState(setupAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="mt-6 flex flex-col gap-4">
      <FormError message={state?.error} revealKey={state} />
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
      <Field label="Ihr Name">
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
        label={<>Ich habe die <a href="/datenschutz" target="_blank" rel="noreferrer" className="font-semibold text-primary underline">Datenschutzhinweise</a> gelesen.</>}
      />
      {saas ? (
        <>
          <Field label="Aktionscode (optional)" hint="Falls Sie einen Code für eine längere Testphase erhalten haben.">
            <Input name="code" defaultValue={code} maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          </Field>
          <Checkbox
            name="agb"
            required
            label={<>Ich akzeptiere die <a href="/agb" target="_blank" rel="noreferrer" className="font-semibold text-primary underline">AGB</a> (Version {LEGAL_VERSIONS.agb}) und handle als Unternehmer:in (§ 14 BGB).</>}
          />
          <Checkbox
            name="avv"
            required
            label={<>Ich schließe den <a href="/avv" target="_blank" rel="noreferrer" className="font-semibold text-primary underline">Auftragsverarbeitungsvertrag (AVV)</a> nach Art. 28 DSGVO (Version {LEGAL_VERSIONS.avv}) ab.</>}
          />
          <p className="text-xs text-muted">{trialText ?? "30 Tage kostenlos testen, alle Funktionen"}, keine Zahlungsdaten nötig. Danach einen Tarif buchen oder in den kostenlosen Tarif wechseln (höchstens 20 Patient:innen einschließlich archivierter, 1 Person) – ohne Wahl bleibt die Praxis nur lesbar (Daten bleiben exportierbar).</p>
        </>
      ) : null}
      <Button type="submit" disabled={pending} className="mt-2">
        {pending ? "Wird eingerichtet …" : "Praxis anlegen"}
      </Button>
    </form>
  );
}
