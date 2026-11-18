"use client";

import { useActionState, useState } from "react";
import { FormError } from "@/components/ui";
import { EURO_INPUT_MAX_LENGTH } from "@/lib/euro-input";
import { PRESCRIPTION_KINDS, PRESCRIPTION_KIND_SOURCE, PRESCRIPTION_SPECIALS, type KindSuggestion } from "@/lib/rules/gkv-billing";
import { billingDetailsAction, correctionAction, deductionAction, resolveCorrectionAction, type GkvActionState } from "./gkv-actions";

const inputCls = "h-9 rounded-lg border border-border bg-surface px-2 text-sm";
const btnCls = "text-xs font-semibold text-primary disabled:opacity-60";

function Result({ state }: { state: GkvActionState }) {
  return (
    <>
      <FormError message={state?.error} revealKey={state} />
      {state?.ok ? <p role="status" className="text-xs font-medium text-primary">{state.ok}</p> : null}
    </>
  );
}

/**
 * Abrechnungsangaben (§ 302): Kennzeichen Verordnungsart (03/04) – nie vorbelegt, die Auswahl ist die Bestätigung; ein
 * Vorschlag steht nur als Hinweis daneben. Dazu Verordnungsbesonderheit (8.1.11) und Genehmigung (SKZ B2).
 */
export function BillingDetailsForm({
  prescriptionId,
  patientId,
  kind,
  special,
  approvalRef,
  approvalDate,
  suggestion,
}: {
  prescriptionId: string;
  patientId: string;
  kind: string | null;
  special: string | null;
  approvalRef: string | null;
  approvalDate: string | null;
  suggestion: KindSuggestion;
}) {
  const [state, action, pending] = useActionState<GkvActionState, FormData>(billingDetailsAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="id" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <fieldset className="flex flex-col gap-1">
        <legend className="font-medium">Kennzeichen Verordnungsart <span className="text-xs text-muted">({PRESCRIPTION_KIND_SOURCE})</span></legend>
        {!kind ? (
          <p className="text-xs font-medium text-warn-soft-text">
            {suggestion ? `Vorschlag: ${suggestion.kind} – ${suggestion.reason} Bitte mit der Verordnung abgleichen und bestätigen.` : "Bitte wählen – wie auf der Verordnung (Muster 13) angegeben. Ohne bestätigtes Kennzeichen keine Abrechnung."}
          </p>
        ) : null}
        {Object.entries(PRESCRIPTION_KINDS).map(([code, k]) => (
          <label key={code} className="flex items-start gap-2">
            <input type="radio" name="prescriptionKind" value={code} defaultChecked={kind === code} required className="mt-1 size-4 accent-[var(--primary)]" />
            <span>{k.label}</span>
          </label>
        ))}
        <p className="text-xs text-muted">„05“ (Blankoverordnung) gibt es für Podologie nicht.</p>
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Verordnungsbesonderheit</span>
        <select name="prescriptionSpecial" defaultValue={special ?? ""} className={inputCls}>
          <option value="">keine</option>
          {Object.entries(PRESCRIPTION_SPECIALS).map(([code, label]) => (
            <option key={code} value={code}>{`${code} – ${label}`}</option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Genehmigung langfristiger Heilmittelbedarf (B2)</span>
          <input name="approvalRef" defaultValue={approvalRef ?? ""} maxLength={20} placeholder="Genehmigungskennzeichen" aria-label="Genehmigungskennzeichen" className={`${inputCls} w-52`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Datum der Genehmigung</span>
          <input type="date" name="approvalDate" defaultValue={approvalDate ?? ""} className={inputCls} />
        </label>
      </div>
      <Result state={state} />
      <div>
        <button type="submit" disabled={pending} className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-on-primary disabled:opacity-60">
          {pending ? "…" : kind ? "Abrechnungsangaben speichern" : "Kennzeichen bestätigen und speichern"}
        </button>
      </div>
    </form>
  );
}

/** Absetzung/Retaxe der Kasse erfassen (abgerechnete Verordnung) */
export function DeductionForm({ prescriptionId, patientId, today }: { prescriptionId: string; patientId: string; today: string }) {
  const [state, action, pending] = useActionState<GkvActionState, FormData>(deductionAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="amount" inputMode="decimal" required maxLength={EURO_INPUT_MAX_LENGTH} placeholder="Betrag €" aria-label="abgesetzter Betrag in Euro" className={`${inputCls} w-24`} />
        <input type="date" name="deductedOn" required defaultValue={today} max={today} aria-label="Datum der Absetzung" className={inputCls} />
        <input name="reasonCode" maxLength={20} placeholder="Code (optional)" aria-label="Absetzungscode" className={`${inputCls} w-32`} />
        <input name="reason" required minLength={3} maxLength={500} placeholder="Grund der Absetzung" aria-label="Grund der Absetzung" className={`${inputCls} min-w-56 flex-1`} />
        <button type="submit" disabled={pending} className={btnCls}>{pending ? "…" : "Absetzung erfassen"}</button>
      </div>
      <p className="text-xs text-muted">Grund ohne Gesundheitsangaben formulieren (z. B. „Unterschrift fehlt“, „Frist überschritten“).</p>
      <Result state={state} />
    </form>
  );
}

/** „Korrektur nötig“ (abgerechnet) – mit Begründung, optional Bezug auf eine Absetzung */
export function CorrectionForm({ prescriptionId, patientId, deductions }: { prescriptionId: string; patientId: string; deductions: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState<GkvActionState, FormData>(correctionAction, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className={btnCls} onClick={() => setOpen(true)}>Korrektur nötig …</button>;
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="reason" required minLength={5} maxLength={500} placeholder="Was muss korrigiert werden?" aria-label="Begründung der Korrektur" className={`${inputCls} min-w-64 flex-1`} />
        {deductions.length ? (
          <select name="deductionId" defaultValue="" aria-label="zugehörige Absetzung" className={inputCls}>
            <option value="">ohne Bezug auf eine Absetzung</option>
            {deductions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        ) : null}
        <button type="submit" disabled={pending} className={btnCls}>{pending ? "…" : "Korrektur nötig setzen"}</button>
        <button type="button" className="text-xs text-muted" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <p className="text-xs text-muted">Der Stand der Erstabrechnung (Lauf, Beträge, Preis-Snapshot) wird festgehalten. Danach korrigieren, „abrechnungsreif“ setzen und im nächsten Lauf erneut abrechnen.</p>
      <Result state={state} />
    </form>
  );
}

/** Korrektur ohne Neuabrechnung abschließen (z. B. Absetzung akzeptiert) */
export function ResolveCorrectionForm({ prescriptionId, patientId }: { prescriptionId: string; patientId: string }) {
  const [state, action, pending] = useActionState<GkvActionState, FormData>(resolveCorrectionAction, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className={btnCls} onClick={() => setOpen(true)}>ohne Neuabrechnung abschließen …</button>;
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="note" required minLength={5} maxLength={500} placeholder="Begründung (z. B. Absetzung akzeptiert)" aria-label="Begründung" className={`${inputCls} min-w-64 flex-1`} />
        <button type="submit" disabled={pending} className={btnCls}>{pending ? "…" : "abschließen"}</button>
        <button type="button" className="text-xs text-muted" onClick={() => setOpen(false)}>Abbrechen</button>
      </div>
      <Result state={state} />
    </form>
  );
}
