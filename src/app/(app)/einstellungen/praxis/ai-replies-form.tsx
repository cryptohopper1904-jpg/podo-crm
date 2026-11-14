"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Checkbox, Field, Input, Select } from "@/components/ui";
import { AI_COUNTRIES, AI_PROVIDER_MAX, aiCountry, type AiReplySettings } from "@/lib/ai-replies";
import { saveAiRepliesAction } from "../actions";

/**
 * KI-Antwortvorschläge an/aus (Standard aus). Einschalten nur durch die Inhaber:in (`canEnable`) mit Anbieter, Land
 * (Auswahlliste) und den Bestätigungen – bei Drittland zusätzlich die Garantien für die Übermittlung. Die Häkchen sind
 * nie vorausgefüllt, solange der Schalter aus ist: nach Aus/Ein wird neu bestätigt. Anbieter und Land erscheinen danach
 * in den Datenschutzhinweisen der Online-Buchung.
 */
export function AiRepliesForm({ initial, disabled, canEnable }: { initial: AiReplySettings; disabled?: boolean; canEnable: boolean }) {
  const [on, setOn] = useState(initial.enabled);
  const [country, setCountry] = useState(aiCountry(initial.country)?.name ?? "");
  const third = aiCountry(country)?.euEea === false;
  // Bestätigungen gelten nur für die laufende Einschaltung (Recht N-88-7)
  const confirmed = initial.enabled;
  return (
    <ActionForm action={saveAiRepliesAction}>
      <Checkbox
        name="enabled"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
        // nicht Inhaber:in: nur ausschalten (Häkchen entfernen), nicht einschalten
        disabled={disabled || (!canEnable && !on)}
        label="KI-Antwortvorschläge einschalten"
      />
      {!canEnable && !initial.enabled ? <p className="text-sm text-muted">Einschalten kann nur die Inhaberin bzw. der Inhaber der Praxis.</p> : null}
      {on && canEnable ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="KI-Anbieter *" id="ai-provider" hint="z. B. „Mistral AI“ oder „Microsoft Azure OpenAI“">
              <Input name="provider" defaultValue={initial.provider} maxLength={AI_PROVIDER_MAX} required />
            </Field>
            <Field label="Land der Verarbeitung *" id="ai-country" hint="Für Gesundheitsdaten empfehlen wir Anbieter in der EU.">
              <Select name="country" value={country} onChange={(e) => setCountry(e.target.value)} required>
                <option value="">– wählen –</option>
                <optgroup label="EU / EWR">
                  {AI_COUNTRIES.filter((c) => c.euEea).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </optgroup>
                <optgroup label="außerhalb von EU / EWR">
                  {AI_COUNTRIES.filter((c) => !c.euEea).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </optgroup>
              </Select>
            </Field>
          </div>
          <Checkbox
            name="avvConfirmed"
            defaultChecked={confirmed && initial.avvConfirmed}
            required
            label="Mit dem KI-Anbieter besteht ein AVV (Auftragsverarbeitungsvertrag nach Art. 28 DSGVO)."
          />
          <Checkbox
            name="confidentialityConfirmed"
            defaultChecked={confirmed && initial.confidentialityConfirmed}
            required
            label="Ich habe den KI-Anbieter vertraglich zur Geheimhaltung verpflichtet (§ 203 Abs. 3 und 4 StGB), z. B. durch eine Verschwiegenheitsklausel im Vertrag oder in der AVV."
          />
          {third ? (
            <>
              <Checkbox
                key={country}
                name="transferConfirmed"
                defaultChecked={confirmed && initial.transferConfirmed && initial.country === country}
                required
                label="Für die Übermittlung in dieses Land besteht ein Angemessenheitsbeschluss (z. B. EU-US Data Privacy Framework mit Zertifizierung des Anbieters) oder es wurden Standardvertragsklauseln abgeschlossen."
              />
              <p className="text-sm text-muted">Für Gesundheitsdaten empfehlen wir Anbieter in der EU.</p>
            </>
          ) : null}
          <p className="text-sm text-muted">
            Den KI-Dienst beauftragst du selbst (eigener Vertrag); PodoHero übermittelt nur auf deine Anforderung je Nachricht. Anbieter und Land stehen
            danach in den Datenschutzhinweisen deiner Buchungsseite. Vor dem Versand werden Namen der Person, Telefonnummern, E-Mail-Adressen und
            Datumsangaben entfernt, bei Online-Anfragen zusätzlich die Notiz und die Leistung. Freie Namen im Text erkennt die Software nicht sicher.
          </p>
        </div>
      ) : null}
    </ActionForm>
  );
}
