"use client";

import { ActionForm } from "@/components/action-form";
import { Field, Input, Textarea } from "@/components/ui";
import {
  DEFAULT_DUNNING_TEXT,
  DUNNING_PLACEHOLDERS,
  DUNNING_STAGE_LABEL,
  DUNNING_STAGES,
  FEES_ENABLED,
  MAX_FEE_CENTS,
  MAX_PAY_DAYS,
  MAX_STAGE_DAYS,
  MAX_TEXT,
  type DunningSettings,
} from "@/lib/dunning";
import { saveDunningSettingsAction } from "../actions";

const euro = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

/** Mahnwesen: Fristen, Gebühren und Textvorlagen je Stufe. */
export function DunningForm({ settings }: { settings: DunningSettings }) {
  return (
    <ActionForm action={saveDunningSettingsAction}>
      <Field label="Neue Zahlungsfrist im Schreiben (Tage ab Datum des Schreibens)" className="sm:max-w-xs">
        <Input name="payDays" type="number" inputMode="numeric" min={1} max={MAX_PAY_DAYS} defaultValue={settings.payDays} required />
      </Field>
      {DUNNING_STAGES.map((s, i) => {
        const st = settings.stages[s];
        return (
          <fieldset key={s} className="flex flex-col gap-3 rounded-xl border border-border p-4">
            <legend className="px-1 font-semibold">{DUNNING_STAGE_LABEL[s]}{s === "dunning2" ? " (letzte Mahnung)" : ""}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={i === 0 ? "Fällig … Tage nach dem Zahlungsziel" : `Fällig … Tage nach der ${DUNNING_STAGE_LABEL[DUNNING_STAGES[i - 1]]}`}>
                <Input name={`${s}.days`} type="number" inputMode="numeric" min={1} max={MAX_STAGE_DAYS} defaultValue={st.days} required />
              </Field>
              {s === "reminder" ? (
                <Field label="Gebühr (€)" hint="Die Zahlungserinnerung setzt den Verzug erst in Gang – dafür darf keine Gebühr verlangt werden.">
                  <Input value="0,00" disabled readOnly />
                </Field>
              ) : FEES_ENABLED ? (
                <Field label="Gebühr (€)" hint={`Nur tatsächliche Kosten (z. B. Porto, Papier), keine Pauschale – üblich ca. 1–3 €. Höchstens ${euro(MAX_FEE_CENTS)} €. Wird nur im Schreiben ausgewiesen, nicht auf der Rechnung.`}>
                  <Input name={`${s}.fee`} inputMode="decimal" defaultValue={euro(st.feeCents)} />
                </Field>
              ) : (
                <Field label="Gebühr (€)" hint="Mahngebühren folgen, sobald die Verbuchung eingebaut ist.">
                  <Input value="0,00" disabled readOnly />
                </Field>
              )}
            </div>
            <Field label="Brieftext">
              <Textarea name={`${s}.text`} rows={8} maxLength={MAX_TEXT} defaultValue={st.text} required />
            </Field>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer">Standardtext anzeigen</summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans">{DEFAULT_DUNNING_TEXT[s]}</pre>
            </details>
          </fieldset>
        );
      })}
      <p className="text-sm text-muted">
        Platzhalter: {DUNNING_PLACEHOLDERS.map((p, i) => (
          <span key={p.key}>
            {i ? " · " : ""}
            <code className="rounded bg-surface-2 px-1">{`{${p.key}}`}</code> {p.label}
          </span>
        ))}
      </p>
      <p className="text-sm text-muted">
        Verzugszinsen (§ 288 BGB: 5 Prozentpunkte über dem Basiszinssatz) berechnet PodoHero nicht automatisch. Texte für Mahnungen bitte bei Bedarf rechtlich prüfen lassen.
      </p>
    </ActionForm>
  );
}
