"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Checkbox, Field, Input } from "@/components/ui";
import { AI_COUNTRY_MAX, AI_PROVIDER_MAX, type AiReplySettings } from "@/lib/ai-replies";
import { saveAiRepliesAction } from "../actions";

/**
 * KI-Antwortvorschläge an/aus (Standard aus). Einschalten nur mit Anbieter, Land und beiden Bestätigungen –
 * Anbieter und Land erscheinen danach in den Datenschutzhinweisen der Online-Buchung.
 */
export function AiRepliesForm({ initial, disabled }: { initial: AiReplySettings; disabled?: boolean }) {
  const [on, setOn] = useState(initial.enabled);
  return (
    <ActionForm action={saveAiRepliesAction}>
      <Checkbox
        name="enabled"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
        disabled={disabled}
        label="KI-Antwortvorschläge im Posteingang einschalten"
      />
      {on ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="KI-Anbieter *" id="ai-provider" hint="z. B. „Mistral AI“ oder „Microsoft Azure OpenAI“">
              <Input name="provider" defaultValue={initial.provider} maxLength={AI_PROVIDER_MAX} required />
            </Field>
            <Field label="Land der Verarbeitung *" id="ai-country" hint="z. B. „Frankreich“ oder „Deutschland“">
              <Input name="country" defaultValue={initial.country} maxLength={AI_COUNTRY_MAX} required />
            </Field>
          </div>
          <Checkbox name="avvConfirmed" defaultChecked={initial.avvConfirmed} required label="Mit dem KI-Anbieter besteht ein AVV (Auftragsverarbeitungsvertrag nach Art. 28 DSGVO)." />
          <Checkbox
            name="confidentialityConfirmed"
            defaultChecked={initial.confidentialityConfirmed}
            required
            label="Der Anbieter ist zur Verschwiegenheit nach § 203 Abs. 4 StGB verpflichtet."
          />
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
