"use client";

import { useActionState, useState } from "react";
import { FormError } from "@/components/ui";
import { EURO_INPUT_MAX_LENGTH } from "@/lib/euro-input";
import { copaymentLegacyResetAction, copaymentReceiptAction, copaymentRefundAction, type CopaymentPaidState } from "./actions";

const METHODS: Record<string, string> = { cash: "bar", card: "Karte", transfer: "Überweisung" };
const inputCls = "h-9 rounded-lg border border-border bg-surface px-2 text-sm";

/**
 * „Zuzahlung quittieren“: erzeugt die Zuzahlungsquittung (Beleg ZZ…) mit Kassenbuchung – PodoHero-Kasse mit TSE bzw.
 * bei eigener Praxiskasse ein Vermerk mit Bon-Nr. Betrag leer = offene Zuzahlung laut Berechnung. Ohne Preis bzw.
 * Positionsnummer (`manual`) lässt sich nichts berechnen – dann ist der erhaltene Betrag Pflicht.
 */
export function CopaymentReceiptForm({ prescriptionId, patientId, openCents, manual, external }: { prescriptionId: string; patientId: string; openCents: number | null; manual: boolean; external: boolean }) {
  const [state, action, pending] = useActionState<CopaymentPaidState, FormData>(copaymentReceiptAction, undefined);
  const [method, setMethod] = useState("cash");
  const register = method === "cash" || method === "card";
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} revealKey={state} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          name="amount"
          inputMode="decimal"
          required={manual}
          placeholder={manual || openCents === null ? "Betrag €" : (openCents / 100).toFixed(2).replace(".", ",")}
          aria-label="erhaltener Betrag in Euro"
          maxLength={EURO_INPUT_MAX_LENGTH}
          className={`${inputCls} w-24`}
        />
        <select name="method" aria-label="Zahlungsart" value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
          {Object.entries(METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        {external && register ? <input name="registerReceiptNo" maxLength={40} placeholder="Bon-Nr. Praxiskasse" aria-label="Bon-Nr. der Praxiskasse" className={`${inputCls} w-36`} /> : null}
        <button type="submit" disabled={pending} className="text-xs font-semibold text-primary">{pending ? "…" : "Zuzahlung quittieren"}</button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" name="confirmOverpay" className="size-4 accent-[var(--primary)]" />{" "}
        {manual ? "Ungewöhnlich hohen Betrag (insgesamt über 200 €) geprüft und bestätigt" : "Betrag über der offenen Zuzahlung ausdrücklich bestätigen (Überzahlung)"}
      </label>
      {manual ? <p className="text-xs font-medium text-warn-soft-text">Preis bzw. Positionsnummer fehlt – die Zuzahlung lässt sich nicht berechnen. Bitte den erhaltenen Betrag eingeben.</p> : null}
      <p className="text-xs text-muted">
        {external && register
          ? "Erst in der Praxiskasse buchen (Zahlung auf Beleg), dann hier mit Bon-Nr. vermerken – die Quittung trägt den Praxiskassen-Vermerk."
          : register
            ? "Kassenvorgang in der PodoHero-Kasse (TSE-Signatur, Tagesabschluss) – Quittung ohne Umsatzsteuer (§ 32/§ 61 SGB V)."
            : "Überweisung: nur nach Zahlungseingang auf dem Konto quittieren – Quittung über den Eingang, kein Kassenvorgang."}
      </p>
      {state?.ok ? <p role="status" className="text-xs font-medium text-primary">{state.ok}</p> : null}
      {state?.warning ? <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn-soft-text">{state.warning}</p> : null}
    </form>
  );
}

/** Zuzahlungsquittung stornieren und den Betrag erstatten (z. B. Überzahlung) – danach ggf. neu quittieren */
export function CopaymentRefundForm({ invoiceId, patientId, external }: { invoiceId: string; patientId: string; external: boolean }) {
  const [state, action, pending] = useActionState<CopaymentPaidState, FormData>(copaymentRefundAction, undefined);
  const [method, setMethod] = useState("cash");
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-semibold text-primary">stornieren/erstatten</summary>
      <form action={action} className="mt-2 flex flex-col gap-1">
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <input type="hidden" name="patientId" value={patientId} />
        <FormError message={state?.error} revealKey={state} />
        <div className="flex flex-wrap items-center gap-2">
          <input name="reason" required minLength={5} maxLength={300} placeholder="Grund (z. B. Überzahlung)" aria-label="Grund der Erstattung" className={`${inputCls} min-w-48 flex-1`} />
          <select name="method" aria-label="Zahlungsart der Erstattung" value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
            {Object.entries(METHODS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {external && (method === "cash" || method === "card") ? <input name="registerReceiptNo" maxLength={40} placeholder="Bon-Nr. Storno" aria-label="Bon-Nr. des Storno-Bons der Praxiskasse" className={`${inputCls} w-32`} /> : null}
          <button type="submit" disabled={pending} className="font-semibold text-danger">{pending ? "…" : "Quittung stornieren und erstatten"}</button>
        </div>
        <p className="text-muted">Die Erstattung wird als negative Zahlung auf dem Stornobeleg gebucht. Den richtigen Betrag danach neu quittieren.</p>
        {state?.ok ? <p role="status" className="font-medium text-primary">{state.ok}</p> : null}
        {state?.warning ? <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 font-medium text-warn-soft-text">{state.warning}</p> : null}
      </form>
    </details>
  );
}

/**
 * Altvermerk „Zuzahlung erhalten“ (vor Paket B) entfernen – nur, wenn der Vermerk falsch war und nichts erhalten wurde
 * (Pflichtbegründung, Audit). Früher erhaltene Beträge werden nie nachträglich quittiert/gebucht.
 */
export function CopaymentLegacyReset({ id, patientId }: { id: string; patientId: string }) {
  const [state, action, pending] = useActionState<CopaymentPaidState, FormData>(copaymentLegacyResetAction, undefined);
  if (state?.ok) return <p role="status" className="text-xs font-medium text-primary">{state.ok}</p>;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-semibold text-primary">Vermerk war falsch – nichts erhalten</summary>
      <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="patientId" value={patientId} />
        <FormError message={state?.error} revealKey={state} />
        <input name="reason" required minLength={5} maxLength={300} placeholder="Begründung (Pflicht)" aria-label="Begründung" className={`${inputCls} min-w-48 flex-1`} />
        <button type="submit" disabled={pending} className="font-semibold text-danger">{pending ? "…" : "Vermerk entfernen"}</button>
      </form>
    </details>
  );
}
