import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { FileImage, Plus } from "lucide-react";
import { withOrg } from "@/db";
import { services } from "@/db/schema";
import { Badge, Card, CardTitle, Empty, FormSuccess, LinkButton } from "@/components/ui";
import { TrafficLight } from "@/components/traffic-light";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, fullName, money } from "@/lib/format";
import { DIAGNOSIS_GROUPS, RULES_VERSION, STATUS_LABEL, type DiagnosisGroup, type PrescriptionStatus } from "@/lib/rules/prescription";
import { ocrStatus } from "@/server/ocr";
import { listPatientPrescriptions } from "@/server/prescriptions";
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
      };
  const hints = typeof sp.hinweise === "string" ? sp.hinweise.split("\n").filter(Boolean).slice(0, 5) : [];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted"><Link href={`/kunden/${id}`} className="hover:text-primary">← {fullName(data.patient)}</Link></p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Verordnungen</h1>
          <p className="text-sm text-muted">
            {data.patient.insuranceType === "gkv" ? `GKV${data.patient.insurerName ? ` · ${data.patient.insurerName}` : ""}${data.patient.insuranceNumber ? ` · Vers.-Nr. ${data.patient.insuranceNumber}` : " · Versichertennummer fehlt"}` : "Hinweis: Kunde ist nicht als GKV-versichert hinterlegt."}
          </p>
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
                      <span className="font-semibold">{vo.copaymentExempt ? "befreit" : money(vo.copaymentCents)}</span>
                      {!vo.copaymentExempt && (vo.copaymentCents ?? 0) > 0 ? (
                        vo.copaymentPaidAt ? <Badge tone="primary">erhalten {dateDe(vo.copaymentPaidAt)}</Badge> : <Badge tone="warn">offen</Badge>
                      ) : null}
                      {canWrite && !vo.copaymentExempt && (vo.copaymentCents ?? 0) > 0 ? (
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
                  {vo.therapyReportRequested ? <Badge tone="warn">Therapiebericht angefordert</Badge> : null}
                  {vo.scanMediaId && auth.can("medical.read") ? (
                    <a href={`/api/media/${vo.scanMediaId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary"><FileImage size={16} aria-hidden /> Foto der Verordnung</a>
                  ) : null}
                  {vo.rulesVersion && vo.rulesVersion !== RULES_VERSION ? <Badge>Regelwerk {vo.rulesVersion}</Badge> : null}
                </div>
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
      <p className="mt-6 text-xs text-muted">Regelwerk {RULES_VERSION} – vor Echtbetrieb gegen aktuelle HeilM-RL/§125-Vertrag prüfen. Einheiten werden über die Behandlungsdoku gezählt (Feld „Verordnung“).</p>
    </div>
  );
}
