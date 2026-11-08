"use client";

import { keepValues } from "@/lib/forms";
import { useActionState } from "react";
import { Download } from "lucide-react";
import { Button, Field, FormError, FormSuccess, Input, Select, Table } from "@/components/ui";
import { createBatchAction, type BatchState } from "./actions";

export type ReadyRow = { id: string; patient: string; group: string; issuedAt: string; units: string; copayment: string; warning: string | null };

export function BatchForm({ rows }: { rows: ReadyRow[] }) {
  const [state, action, pending] = useActionState<BatchState, FormData>(createBatchAction, undefined);
  return (
    <form onSubmit={keepValues(action)} className="flex flex-col gap-4">
      <FormError message={state?.error} />
      {state?.ok ? (
        <div className="flex flex-wrap items-center gap-3">
          <FormSuccess message={state.ok} />
          {state.batchId ? (
            <a href={`/api/export/gkv-batch/${state.batchId}`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-on-primary"><Download size={18} aria-hidden /> CSV herunterladen</a>
          ) : null}
        </div>
      ) : null}
      <Table>
        <thead>
          <tr><th className="w-12"><span className="sr-only">Auswahl</span></th><th>Kunde</th><th>VO</th><th>Ausgestellt</th><th>Einheiten</th><th>Zuzahlung</th><th>Hinweis</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" name="prescriptionId" value={r.id} defaultChecked={!r.warning} className="size-5 accent-[var(--primary)]" aria-label={`${r.patient} auswählen`} /></td>
              <td className="font-semibold">{r.patient}</td>
              <td>{r.group}</td>
              <td>{r.issuedAt}</td>
              <td className="tabular-nums">{r.units}</td>
              <td className="tabular-nums">{r.copayment}</td>
              <td className="text-sm text-warn-soft-text">{r.warning ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
        <Field label="Abrechnungszentrum">
          <Select name="partner" defaultValue="manual">
            <option value="manual">manuell / noch offen</option>
            <option value="opta-data">opta data</option>
            <option value="optica">Optica</option>
            <option value="azh">azh / noventi</option>
            <option value="rzh">RZH</option>
            <option value="other">anderes</option>
          </Select>
        </Field>
        <Field label="Notiz (optional)"><Input name="note" maxLength={500} placeholder="z. B. Abrechnung Oktober" /></Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>{pending ? "…" : "Abrechnungslauf erstellen und als abgerechnet markieren"}</Button>
      </div>
    </form>
  );
}
