"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { keepValues } from "@/lib/forms";
import { Button, Card, Field, FormError, Input, Select, Textarea } from "@/components/ui";
import { DEPOSIT_METHODS, PAYMENT_METHOD_LABEL, type DepositMethod } from "@/lib/invoice-labels";
import { createDepositAction } from "../actions";

export type DepositDefaults = {
  patientId: string;
  appointmentId: string | null;
  treatmentRecordId: string | null;
  description: string;
  amount: string;
  vatRate: number;
};

/** Anzahlung (Vorauszahlung): Betrag jetzt annehmen und quittieren, Anrechnung auf die spätere Rechnung bzw. Sammelrechnung. */
export function DepositForm({ defaults, smallBusiness, tseTestMode }: { defaults: DepositDefaults; smallBusiness: boolean; tseTestMode: boolean }) {
  const [state, action, pending] = useActionState(createDepositAction, undefined);
  const [method, setMethod] = useState<DepositMethod>("cash");
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-6">
      <input type="hidden" name="patientId" value={defaults.patientId} />
      <input type="hidden" name="appointmentId" value={defaults.appointmentId ?? ""} />
      <input type="hidden" name="treatmentRecordId" value={defaults.treatmentRecordId ?? ""} />
      <FormError message={state?.error} />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Text auf der Quittung" className="sm:col-span-2" hint="keine Diagnosen">
            <Input name="description" defaultValue={defaults.description} required minLength={3} maxLength={300} />
          </Field>
          <Field label="Erhaltener Betrag (€)">
            <Input name="amount" inputMode="decimal" defaultValue={defaults.amount} placeholder="0,00" required />
          </Field>
          <Field label="Zahlart">
            <Select name="method" value={method} onChange={(e) => setMethod(e.target.value as DepositMethod)}>
              {DEPOSIT_METHODS.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>
              ))}
            </Select>
          </Field>
          <Field label="USt" hint={smallBusiness ? "Kleinunternehmer (§ 19 UStG)" : "wie die Leistung (Heilbehandlung 0 %)"}>
            {smallBusiness ? (
              <>
                <input type="hidden" name="vatRate" value={0} />
                <Input value="0 % (§ 19)" disabled />
              </>
            ) : (
              <Select name="vatRate" defaultValue={defaults.vatRate}>
                {[0, 7, 19].map((r) => <option key={r} value={r}>{r} %</option>)}
              </Select>
            )}
          </Field>
          <Field label="Hinweis auf der Quittung (optional)" className="sm:col-span-2">
            <Textarea name="notes" rows={2} />
          </Field>
        </div>
        {method === "cash" || method === "card" ? (
          <p className="mt-4 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn-soft-text">
            {method === "cash" ? "Barzahlung" : "Kartenzahlung"} wird wie jede Kassenzahlung über die TSE signiert und erscheint im Kassenbuch und Tagesabschluss.
            {tseTestMode ? " TSE im Testmodus: nur Test-Signatur – für echten Bargeldeinsatz ist ein TSE-Vertrag Pflicht (KassenSichV)." : ""}
          </p>
        ) : null}
      </Card>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Wird ausgestellt …" : "Anzahlung quittieren"}</Button>
        <Link href="/rechnungen" className="inline-flex h-11 items-center px-4 font-semibold text-muted">Abbrechen</Link>
        <p className="w-full text-xs text-muted">
          Die Anzahlung bekommt eine eigene Nummer (AZ…), die Patient:in erhält eine Quittung darüber. Danach unveränderbar. Der Betrag wird auf die spätere Rechnung bzw. Sammelrechnung angerechnet.
        </p>
      </div>
    </form>
  );
}
