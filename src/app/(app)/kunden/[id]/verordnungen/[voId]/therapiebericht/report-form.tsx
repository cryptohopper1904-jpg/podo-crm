"use client";

import { useActionState } from "react";
import { Button, Card, Field, FormError, Input, Textarea } from "@/components/ui";
import { saveTherapyReportAction, type ReportState } from "../../actions";

export type ReportInitial = { reportDate: string; findings: string; course: string; result: string; recommendation: string; notes: string };

const FIELDS: [keyof Omit<ReportInitial, "reportDate">, string, string][] = [
  ["findings", "Befund", "z. B. Ausgangsbefund, Lokalisation, Schweregrad"],
  ["course", "Verlauf", "Behandlungen, Reaktion, Besonderheiten"],
  ["result", "Ergebnis", "Stand zum Berichtsdatum"],
  ["recommendation", "Empfehlung", "z. B. Fortsetzung, Frequenz, Folgeverordnung"],
  ["notes", "Weitere Angaben (Freitext)", ""],
];

/** Formular Therapiebericht (Position 78530) – Speichern legt an bzw. ändert (bis „abrechnungsreif“) */
export function TherapyReportForm({ prescriptionId, patientId, initial, maxDate }: { prescriptionId: string; patientId: string; initial: ReportInitial; maxDate: string }) {
  const [state, action, pending] = useActionState<ReportState, FormData>(saveTherapyReportAction, undefined);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="prescriptionId" value={prescriptionId} />
      <input type="hidden" name="patientId" value={patientId} />
      <FormError message={state?.error} revealKey={state} />
      <Card className="flex flex-col gap-4">
        <Field label="Berichtsdatum" hint="Gilt als Tag der Einheit 78530 im Preis-Snapshot.">
          <Input type="date" name="reportDate" defaultValue={initial.reportDate} max={maxDate} required className="w-48" />
        </Field>
        {FIELDS.map(([name, label, placeholder]) => (
          <Field key={name} label={label}>
            <Textarea name={name} rows={4} maxLength={4000} defaultValue={initial[name]} placeholder={placeholder} />
          </Field>
        ))}
      </Card>
      <div>
        <Button type="submit" disabled={pending}>{pending ? "Speichern …" : "Therapiebericht speichern"}</Button>
      </div>
    </form>
  );
}
