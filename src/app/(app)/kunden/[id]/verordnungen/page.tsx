import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { FileImage, Plus } from "lucide-react";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { Badge, Card, CardTitle, Empty, FormSuccess, LinkButton, pageTitleBox, pageTitleCls, BackLink } from "@/components/ui";
import { TrafficLight } from "@/components/traffic-light";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, fullName, money } from "@/lib/format";
import { DIAGNOSIS_GROUPS, RULES_VERSION, STATUS_LABEL, type DiagnosisGroup, type PrescriptionStatus } from "@/lib/rules/prescription";
import { ocrStatus } from "@/server/ocr";
import { listPatientPrescriptions } from "@/server/prescriptions";
import { INSURED_STATUS, kvnrProblem } from "@/lib/rules/gkv-ids";
import type { PriceSnapshot } from "@/lib/rules/prescription";
import { ExemptionsCard } from "./exemptions-card";
import { copaymentPaidAction } from "./actions";
import { PrescriptionForm, type PrescriptionInitial } from "./prescription-form";
import { StatusControls } from "./status-controls";

export const metadata = { title: "Verordnungen" };

export default async function PatientPrescriptionsPage(props: PageProps<"/kunden/[id]/verordnungen">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("medical.read");
  const data = await listPatientPrescriptions(auth, id);
  if (!data) notFound();
  const org = auth.organization.id;
  const canWrite = auth.can("medical.write");
  const editId = typeof sp.bearbeiten === "string" ? sp.bearbeiten : null;
  const showForm = canWrite && (sp.neu === "1" || !!editId);
  const catalog = showForm
    ? await withOrg(org, (tx) =>
        tx.select({ position: services.gkvPosition, label: services.name }).from(services).where(and(eq(services.organizationId, org), isNotNull(services.gkvPosition), eq(services.active, true))).orderBy(asc(services.gkvPosition)),
      )
    : [];
  const ocrInfo = showForm ? await ocrStatus(auth) : null;
  const editing = editId ? data.prescriptions.find((p) => p.id === editId && p.status === "open" && p.dates.length === 0) : undefined;
  const initial: PrescriptionInitial = editing
    ? {
        id: editing.id,
        issuedAt: editing.issuedAt,
        doctorName: editing.doctorName ?? "",
        doctorLanr: editing.doctorLanr ?? "",
        doctorBsnr: editing.doctorBsnr ?? "",
        diagnosisGroup: editing.diagnosisGroup as DiagnosisGroup,
        icd10: editing.icd10 ?? "",
        remedy: editing.remedy ?? "",
        units: editing.units,
        frequencyPerWeek: editing.frequencyPerWeek ?? "",
        homeVisit: editing.homeVisit,
        urgent: editing.urgent,
        copaymentExempt: editing.copaymentExempt,
        therapyReportRequested: editing.therapyReportRequested,
        positions: editing.positions,
        scanMediaId: editing.scanMediaId,
        icd10Second: editing.icd10Second ?? "",
        diagnosisText: editing.diagnosisText ?? "",
        leitsymptomatik: editing.leitsymptomatik ?? "",
        leitsymptomatikText: editing.leitsymptomatikText ?? "",
        insurerIk: editing.insurerIk ?? "",
        insuranceNumber: editing.insuranceNumber ?? "",
        insuredStatus: editing.insuredStatus ?? "",
        accident: editing.accident,
        bvg: editing.bvg,
        doctorSigned: editing.doctorSigned ?? false,
      }
    : {
        issuedAt: berlinDateIso(),
        doctorName: "",
        doctorLanr: "",
        doctorBsnr: "",
        diagnosisGroup: "DF",
        icd10: "",
        remedy: "",
        units: 6,
        frequencyPerWeek: DIAGNOSIS_GROUPS.DF.defaultFrequency,
        homeVisit: data.patient.homeVisit,
        urgent: false,
        copaymentExempt: false,
        therapyReportRequested: false,
        positions: [],
        icd10Second: "",
        diagnosisText: "",
        leitsymptomatik: "",
        leitsymptomatikText: "",
        // Personalienfeld aus der Akte vorbelegen (auf der Verordnung prüfen)
        insurerIk: data.patient.insurerIk ?? "",
        insuranceNumber: data.patient.insuranceNumber ?? "",
        insuredStatus: data.patient.insuredStatus ?? "",
        accident: false,
        bvg: false,
        doctorSigned: false,
      };
  const hints = typeof sp.hinweise === "string" ? sp.hinweise.split("\n").filter(Boolean).slice(0, 5) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <BackLink href={`/kunden/${id}`} label={`Akte ${fullName(data.patient)}`} />
          <h1 className={pageTitleCls}>Verordnungen</h1>
          <p className="text-sm text-muted">
            {data.patient.insuranceType === "gkv" ? `GKV${data.patient.insurerName ? ` · ${data.patient.insurerName}` : ""}${data.patient.insurerIk ? ` · IK ${data.patient.insurerIk}` : ""}${data.patient.insuranceNumber ? ` · Vers.-Nr. ${data.patient.insuranceNumber}` : " · Versichertennummer fehlt"}${data.patient.insuredStatus ? ` · Status ${data.patient.insuredStatus} (${INSURED_STATUS[data.patient.insuredStatus as keyof typeof INSURED_STATUS] ?? "?"})` : ""}` : "Hinweis: Patient ist nicht als GKV-versichert hinterlegt."}
          </p>
          {data.patient.insuranceType === "gkv" && kvnrProblem(data.patient.insuranceNumber) ? <p className="text-sm font-medium text-warn-soft-text">{kvnrProblem(data.patient.insuranceNumber)}</p> : null}
        </div>
        {canWrite && !showForm ? <LinkButton href={`/kunden/${id}/verordnungen?neu=1`}><Plus size={18} aria-hidden /> Neue Verordnung</LinkButton> : null}
      </header>

      {sp.gespeichert ? (
        <div className="mb-4 flex flex-col gap-2">
          <FormSuccess message="Verordnung gespeichert." />
          {hints.map((h) => <p key={h} className="rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">{h}</p>)}
        </div>
      ) : null}

      {showForm ? (
        <section className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-xl font-semibold">{editing ? "Verordnung bearbeiten" : "Neue Verordnung"}</h2>
            <Link href={`/kunden/${id}/verordnungen`} className="text-sm font-semibold text-primary">Abbrechen</Link>
          </div>
          <PrescriptionForm
            patientId={id}
            initial={initial}
            catalog={catalog.filter((c): c is { position: string; label: string } => !!c.position)}
            ocrInfo={ocrInfo ?? undefined}
            patient={{ name: [data.patient.firstName, data.patient.lastName].filter(Boolean).join(" "), birthDate: data.patient.birthDate, insuranceNumber: data.patient.insuranceNumber, insurerName: data.patient.insurerName }}
          />
        </section>
      ) : null}

      <ExemptionsCard patientId={id} exemptions={data.patient.copaymentExemptions} canWrite={canWrite} insurerName={data.patient.insurerName} insurerIk={data.patient.insurerIk} />

      {data.prescriptions.length === 0 ? (
        <Empty title="Noch keine Verordnungen">Ärztliche Heilmittelverordnungen (Muster 13) hier erfassen – Fristen, Einheiten und Zuzahlung werden automatisch geprüft.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.prescriptions.map((vo) => {
            const ev = vo.evaluation;
            const group = DIAGNOSIS_GROUPS[vo.diagnosisGroup as DiagnosisGroup];
            return (
              <Card key={vo.id}>
                <CardTitle
                  action={
                    <span className="flex items-center gap-2">
                      <TrafficLight light={ev.light} />
                      <Badge tone={vo.status === "billing_ready" ? "info" : vo.status === "active" || vo.status === "open" ? "primary" : "neutral"}>{STATUS_LABEL[vo.status as PrescriptionStatus] ?? vo.status}</Badge>
                    </span>
                  }
                >
                  {group?.label ?? vo.diagnosisGroup} · {dateDe(vo.issuedAt)}
                </CardTitle>
                <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div><dt className="text-muted">Einheiten</dt><dd className="font-semibold tabular-nums">{ev.unitsUsed} von {vo.units} erbracht · {ev.unitsRemaining} offen</dd></div>
                  <div><dt className="text-muted">Beginn spätestens</dt><dd className="font-semibold">{dateDe(ev.startBy)}{vo.urgent ? " (dringlich)" : ""}</dd></div>
                  <div><dt className="text-muted">Frequenz</dt><dd className="font-semibold">{vo.frequencyPerWeek ?? "–"}</dd></div>
                  <div><dt className="text-muted">ICD-10</dt><dd className="font-semibold">{vo.icd10 ?? "–"}</dd></div>
                  <div><dt className="text-muted">Arzt</dt><dd>{vo.doctorName ?? "–"}{vo.doctorLanr ? ` · LANR ${vo.doctorLanr}` : ""}{vo.doctorBsnr ? ` · BSNR ${vo.doctorBsnr}` : ""}</dd></div>
                  <div className="lg:col-span-2"><dt className="text-muted">Positionen</dt><dd>{vo.positions.map((p) => `${p.position ? `${p.position} ` : ""}${p.label} × ${p.units}`).join(", ") || "–"}</dd></div>
                  <div>
                    <dt className="text-muted">Zuzahlung</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      {/* neues Regelwerk: Befreiung nur per Bescheinigung je Behandlungstag – das Kreuz auf der VO ist nur Info */}
                      <span className="font-semibold">{vo.copaymentExempt && vo.rulesVersion !== RULES_VERSION ? "befreit" : money(vo.copaymentCents)}</span>
                      {vo.copaymentExempt && vo.rulesVersion === RULES_VERSION ? <Badge>„zuzahlungsfrei“ angekreuzt</Badge> : null}
                      {(vo.rulesVersion === RULES_VERSION || !vo.copaymentExempt) && (vo.copaymentCents ?? 0) > 0 ? (
                        vo.copaymentPaidAt ? <Badge tone="primary">erhalten {dateDe(vo.copaymentPaidAt)}</Badge> : <Badge tone="warn">offen</Badge>
                      ) : null}
                      {canWrite && (vo.rulesVersion === RULES_VERSION || !vo.copaymentExempt) && (vo.copaymentCents ?? 0) > 0 ? (
                        <form action={copaymentPaidAction}>
                          <input type="hidden" name="id" value={vo.id} />
                          <input type="hidden" name="patientId" value={id} />
                          <input type="hidden" name="paid" value={vo.copaymentPaidAt ? "0" : "1"} />
                          <button type="submit" className="text-xs font-semibold text-primary">{vo.copaymentPaidAt ? "zurücksetzen" : "als erhalten markieren"}</button>
                        </form>
                      ) : null}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  {vo.homeVisit ? <Badge tone="info">Hausbesuch</Badge> : null}
                  {vo.source === "ocr" ? <Badge tone="info">aus Foto ausgelesen, geprüft</Badge> : null}
                  {vo.rulesVersion?.startsWith("import-") ? <Badge tone="neutral">aus anderer Praxissoftware übernommen</Badge> : null}
                  {vo.therapyReportRequested ? <Badge tone="warn">Therapiebericht angefordert</Badge> : null}
                  {vo.scanMediaId && auth.can("medical.read") ? (
                    <a href={`/api/media/${vo.scanMediaId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary"><FileImage size={16} aria-hidden /> Foto der Verordnung</a>
                  ) : null}
                  {vo.rulesVersion && vo.rulesVersion !== RULES_VERSION && !vo.rulesVersion.startsWith("import-") ? <Badge>Regelwerk {vo.rulesVersion}</Badge> : null}
                </div>
                {vo.findings.length ? (
                  <ul className="mt-3 flex flex-col gap-1" aria-label="Prüfung der Pflichtangaben (Anlage 3)">
                    {vo.findings.map((f) => (
                      <li key={f.code} className={f.level === "warning" ? "rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-soft-text" : "rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-text"}>
                        {f.level === "start" ? "Fehler – Behandlung darf nicht beginnen: " : f.level === "billing" ? "Fehler – vor der Abrechnung korrigieren: " : "Bitte prüfen: "}
                        {f.message} <span className="text-xs opacity-80">({f.source})</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {vo.status === "expired" ? (
                  <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-text">
                    Frist überschritten{vo.expiredReason === "start_missed" ? " – Behandlungsbeginn verpasst" : vo.expiredReason === "interrupted" ? " – mehr als 12 Wochen Unterbrechung" : ""}. Die Verordnung bleibt zur Nachvollziehbarkeit gespeichert.
                  </p>
                ) : null}
                {vo.priceSnapshot ? <PriceSnapshotLine snap={vo.priceSnapshot as unknown as PriceSnapshot} /> : null}
                {ev.messages.length ? (
                  <ul className="mt-3 flex flex-col gap-1">
                    {ev.messages.map((m) => <li key={m} className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-soft-text">{m}</li>)}
                  </ul>
                ) : null}
                {vo.interruptionNote ? <p className="mt-3 text-sm"><span className="text-muted">Abbruch-/Unterbrechungsvermerk:</span> {vo.interruptionNote}</p> : null}
                {vo.dates.length ? <p className="mt-3 text-xs text-muted">Behandlungstage: {vo.dates.map((d) => dateDe(d)).join(", ")}</p> : null}
                {canWrite ? (
                  <div className="mt-4 flex flex-wrap items-start gap-3 border-t border-border pt-4">
                    <StatusControls id={vo.id} patientId={id} status={vo.status as PrescriptionStatus} unitsUsed={ev.unitsUsed} units={vo.units} />
                    {vo.status === "open" && vo.dates.length === 0 ? <LinkButton href={`/kunden/${id}/verordnungen?bearbeiten=${vo.id}`} variant="ghost" className="h-10 text-sm">Bearbeiten</LinkButton> : null}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-6 text-xs text-muted">Regelwerk {RULES_VERSION} (Quellen und Stand: docs/GKV.md). Einheiten werden über die Behandlungsdoku gezählt (Feld „Verordnung“).</p>
    </div>
  );
}

/** Preis-Snapshot (bei Abrechnungsreife): Heilmittelkosten, Zuzahlung, Tabellenstand */
function PriceSnapshotLine({ snap }: { snap: PriceSnapshot }) {
  const versions = [...new Set(snap.lines.map((l) => l.tableVersion).filter(Boolean))].join(", ");
  return (
    <p className="mt-3 text-sm">
      <span className="text-muted">Preis-Snapshot vom {dateDe(snap.computedOn)}:</span> Heilmittelkosten {money(snap.remedyCents)} · Zuzahlung {money(snap.copaymentCents)}
      {snap.flatFeeCents ? ` (davon ${money(snap.flatFeeCents)} je Verordnung)` : ""}
      {versions ? <span className="text-xs text-muted"> · Preisstand {versions}</span> : null}
      {!snap.complete ? <span className="ml-1 font-medium text-warn-soft-text">– unvollständig: {snap.notes.join(" ")}</span> : null}
    </p>
  );
}
