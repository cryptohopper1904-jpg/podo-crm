import Link from "next/link";
import { Badge } from "@/components/ui";
import { dateDe, money } from "@/lib/format";
import { DEDUCTION_OUTCOME_LABEL, DEDUCTION_STATUS_LABEL, PRESCRIPTION_KINDS, isDeductionOutcome, PRESCRIPTION_SPECIALS, isDeductionStatus, type KindSuggestion, type PrescriptionKind, type PrescriptionSpecial } from "@/lib/rules/gkv-billing";
import { BillingDetailsForm, CorrectionForm, DeductionForm, ResolveCorrectionForm } from "./gkv-billing-forms";

type Vo = {
  id: string;
  status: string;
  prescriptionKind: string | null;
  prescriptionKindConfirmedAt: Date | null;
  prescriptionSpecial: string | null;
  approvalRef: string | null;
  approvalDate: string | null;
  kindSuggestion: KindSuggestion;
  deductions: { id: string; amountCents: number; reasonCode: string | null; reason: string; deductedOn: string; status: string; note: string | null; letterRef: string | null; letterDate: string | null; outcome: string | null }[];
  corrections: { id: string; reason: string; createdAt: Date; originalBilledAt: Date | null; resolution: string | null; resolvedAt: Date | null; resolutionNote: string | null }[];
};

/**
 * GKV Paket C an der Verordnung (Akte): Abrechnungsangaben (Kennzeichen Verordnungsart, Besonderheit, Genehmigung),
 * Absetzungen und Korrekturvermerke. Bearbeiten der Angaben: medical.write; Absetzung/Korrektur: invoices.write +
 * medical.read (Rolle mit Abrechnungsrecht).
 */
export function GkvBillingSection({ vo, patientId, canWrite, canBilling, today }: { vo: Vo; patientId: string; canWrite: boolean; canBilling: boolean; today: string }) {
  const editable = vo.status !== "billed" && vo.status !== "cancelled";
  const kindLabel = vo.prescriptionKind ? PRESCRIPTION_KINDS[vo.prescriptionKind as PrescriptionKind]?.short ?? vo.prescriptionKind : null;
  const openCorrection = vo.corrections.find((c) => !c.resolvedAt);
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Abrechnungsangaben (§ 302):</span>
        {kindLabel ? <Badge tone="primary">Verordnungsart {kindLabel}</Badge> : <Badge tone="warn">Verordnungsart nicht bestätigt</Badge>}
        {vo.prescriptionKindConfirmedAt ? <span className="text-xs text-muted">bestätigt am {dateDe(vo.prescriptionKindConfirmedAt)}</span> : null}
        {vo.prescriptionSpecial ? <Badge tone="info">{`Besonderheit ${vo.prescriptionSpecial}: ${PRESCRIPTION_SPECIALS[vo.prescriptionSpecial as PrescriptionSpecial] ?? ""}`}</Badge> : null}
        {vo.approvalRef ? <Badge tone="info">{`Genehmigung B2 ${vo.approvalRef} vom ${vo.approvalDate ? dateDe(vo.approvalDate) : "–"}`}</Badge> : null}
      </div>
      {canWrite && editable ? (
        <details open={!vo.prescriptionKind}>
          <summary className="cursor-pointer text-xs font-semibold text-primary">{vo.prescriptionKind ? "Abrechnungsangaben ändern" : "Kennzeichen Verordnungsart wählen"}</summary>
          <div className="mt-2">
            <BillingDetailsForm
              prescriptionId={vo.id}
              patientId={patientId}
              kind={vo.prescriptionKind}
              special={vo.prescriptionSpecial}
              approvalRef={vo.approvalRef}
              approvalDate={vo.approvalDate}
              suggestion={vo.kindSuggestion}
              status={vo.status}
            />
          </div>
        </details>
      ) : null}

      {vo.status === "correction_needed" ? (
        <div className="rounded-lg bg-danger-soft px-3 py-2 text-danger-soft-text">
          <p className="font-medium">Korrektur nötig{openCorrection ? ` seit ${dateDe(openCorrection.createdAt)}: ${openCorrection.reason}` : ""}</p>
          <p className="text-xs">Verordnung korrigieren (Bearbeiten bzw. Abrechnungsangaben), dann „abrechnungsreif“ setzen – sie geht in den nächsten Abrechnungslauf. „Ohne Neuabrechnung abschließen“ geht nur, solange die Verordnung inhaltlich unverändert ist (Stand der Erstabrechnung) – auch ein erneutes Speichern der Abrechnungsangaben zählt als Änderung; jede Änderung im Korrekturstatus wird protokolliert.</p>
          {canBilling ? <div className="mt-1"><ResolveCorrectionForm prescriptionId={vo.id} patientId={patientId} /></div> : null}
        </div>
      ) : null}

      {vo.deductions.length ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Absetzungen der Kasse">
          {vo.deductions.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Absetzung {money(d.amountCents)}</span>
              <span>{dateDe(d.deductedOn)}{d.reasonCode ? ` · ${d.reasonCode}` : ""} · {d.reason}</span>
              {d.letterRef || d.letterDate ? <span className="text-muted">Schreiben {d.letterRef ?? ""}{d.letterDate ? ` vom ${dateDe(d.letterDate)}` : ""}</span> : null}
              <Badge tone={d.status === "done" ? "neutral" : d.status === "objected" ? "info" : d.status === "accepted" ? "primary" : "warn"}>{isDeductionStatus(d.status) ? DEDUCTION_STATUS_LABEL[d.status] : d.status}{isDeductionOutcome(d.outcome) ? ` · ${DEDUCTION_OUTCOME_LABEL[d.outcome]}` : ""}</Badge>
              {d.note ? <span className="text-muted">{d.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {vo.corrections.length ? (
        <ul className="flex flex-col gap-1 text-xs" aria-label="Korrekturvermerke">
          {vo.corrections.map((c) => (
            <li key={c.id}>
              Korrektur vom {dateDe(c.createdAt)}: {c.reason}
              {c.originalBilledAt ? ` · ursprünglich abgerechnet am ${dateDe(c.originalBilledAt)}` : ""}
              {c.resolvedAt ? ` · ${c.resolution === "rebilled" ? "erneut abgerechnet" : "ohne Neuabrechnung abgeschlossen"} am ${dateDe(c.resolvedAt)}${c.resolutionNote ? ` (${c.resolutionNote})` : ""}` : " · offen"}
            </li>
          ))}
        </ul>
      ) : null}

      {canBilling && (vo.status === "billed" || vo.status === "correction_needed") ? (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <DeductionForm prescriptionId={vo.id} patientId={patientId} today={today} />
          {vo.status === "billed" ? (
            <CorrectionForm
              prescriptionId={vo.id}
              patientId={patientId}
              deductions={vo.deductions.map((d) => ({ id: d.id, label: `${money(d.amountCents)} vom ${dateDe(d.deductedOn)}` }))}
            />
          ) : null}
          <Link href="/verordnungen/absetzungen" className="text-xs font-semibold text-primary">Alle Absetzungen</Link>
        </div>
      ) : null}
    </div>
  );
}
