"use client";

import { ActionForm } from "@/components/action-form";
import { Field, Input, Textarea } from "@/components/ui";
import type { Template } from "@/lib/vertrieb/constants";

type State = { error?: string; ok?: string } | undefined;

export function TemplatesForm({
  action,
  templates,
  delays,
  hidden = {},
}: {
  action: (s: State, f: FormData) => Promise<State>;
  templates: Template[];
  delays: { delay2Days: number; delay3Days: number };
  /** zusätzliche versteckte Felder (z. B. Kampagnen-ID) */
  hidden?: Record<string, string>;
}) {
  const when = ["sofort beim ersten Klick", `frühestens ${delays.delay2Days} Tage nach Mail 1`, `frühestens ${delays.delay3Days} Tage nach Mail 2`];
  return (
    <ActionForm action={action} submit="Vorlagen speichern" className="flex flex-col gap-6">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {templates.map((t, i) => (
        <fieldset key={i} className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <legend className="px-1 font-display text-lg font-semibold">Mail {i + 1}</legend>
          <p className="mb-3 text-xs text-muted">{when[i]}</p>
          <div className="flex flex-col gap-3">
            <Field label="Betreff"><Input name={`subject${i + 1}`} required maxLength={200} defaultValue={t.subject} /></Field>
            <Field label="Text"><Textarea name={`body${i + 1}`} required maxLength={5000} rows={12} defaultValue={t.body} /></Field>
          </div>
        </fieldset>
      ))}
    </ActionForm>
  );
}
