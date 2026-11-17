import { Trash2 } from "lucide-react";
import { Badge, Card, CardTitle, Field, Input } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import type { CopaymentExemptionRow } from "@/db/schema";
import { berlinDateIso, dateDe } from "@/lib/format";
import { addExemptionAction, removeExemptionAction } from "./actions";

/**
 * Befreiungsausweis der Krankenkasse (Zuzahlung): Gültig-von/-bis (je Kalenderjahr) und Kasse. Die Zuzahlung wird je
 * Behandlungstag gegen diese Einträge geprüft (Vertrag § 125 Podologie § 8 Abs. 3, SGB V § 62 Abs. 1).
 */
export function ExemptionsCard({
  patientId,
  exemptions,
  canWrite,
  insurerName,
  insurerIk,
}: {
  patientId: string;
  exemptions: CopaymentExemptionRow[];
  canWrite: boolean;
  insurerName: string | null;
  insurerIk: string | null;
}) {
  const today = berlinDateIso();
  const year = today.slice(0, 4);
  const sorted = [...exemptions].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  return (
    <Card className="mb-6">
      <CardTitle>Zuzahlungsbefreiung</CardTitle>
      <p className="mb-3 text-sm text-muted">
        Auf die Zuzahlung darf nur bei gültiger Befreiungsbescheinigung der Krankenkasse verzichtet werden – das Kreuz „zuzahlungsfrei“ auf der Verordnung genügt nicht.
        Geprüft wird je Behandlungstag; über den Jahreswechsel bitte neu prüfen.
      </p>
      {sorted.length ? (
        <ul className="mb-4 flex flex-col gap-2 text-sm">
          {sorted.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{dateDe(e.validFrom)} – {dateDe(e.validTo)}</span>
              {e.validFrom <= today && today <= e.validTo ? <Badge tone="primary">gültig</Badge> : e.validTo < today ? <Badge>abgelaufen</Badge> : <Badge tone="info">künftig</Badge>}
              <span className="text-muted">{[e.insurerName, e.insurerIk ? `IK ${e.insurerIk}` : null, e.note].filter(Boolean).join(" · ")}</span>
              {insurerIk && e.insurerIk && insurerIk !== e.insurerIk ? <Badge tone="warn">andere Kasse als in der Akte</Badge> : null}
              {canWrite ? (
                <form action={removeExemptionAction} className="ml-auto">
                  <input type="hidden" name="patientId" value={patientId} />
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-danger" aria-label={`Befreiung ${dateDe(e.validFrom)} entfernen`}>
                    <Trash2 size={16} aria-hidden /> entfernen
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm">Keine Befreiung hinterlegt.</p>
      )}
      {canWrite ? (
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-primary">Befreiungsausweis erfassen</summary>
          <ActionForm action={addExemptionAction} submit="Befreiung speichern">
            <input type="hidden" name="patientId" value={patientId} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Gültig ab"><Input type="date" name="validFrom" defaultValue={today} required /></Field>
              <Field label="Gültig bis" hint="i. d. R. Ende des Kalenderjahres"><Input type="date" name="validTo" defaultValue={`${year}-12-31`} required /></Field>
              <Field label="Krankenkasse"><Input name="insurerName" defaultValue={insurerName ?? ""} maxLength={200} /></Field>
              <Field label="IK der Krankenkasse"><Input name="insurerIk" defaultValue={insurerIk ?? ""} inputMode="numeric" maxLength={11} /></Field>
            </div>
          </ActionForm>
        </details>
      ) : null}
    </Card>
  );
}
