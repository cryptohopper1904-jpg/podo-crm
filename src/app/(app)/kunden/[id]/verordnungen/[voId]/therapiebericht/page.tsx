import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import { BackLink, Card, FormSuccess, LinkButton, pageTitleBox, pageTitleCls } from "@/components/ui";
import { audit } from "@/lib/audit";
import { downloadAllowed } from "@/lib/auth/access";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, fullName } from "@/lib/format";
import { requireFeature } from "@/server/features";
import { getTherapyReport, reportOrdered } from "@/server/therapy-reports";
import { TherapyReportForm } from "./report-form";

export const metadata = { title: "Therapiebericht" };

/** Therapiebericht je Verordnung (Position 78530) – anlegen/ändern mit medical.write, ansehen/PDF mit medical.read */
export default async function TherapyReportPage(props: PageProps<"/kunden/[id]/verordnungen/[voId]/therapiebericht">) {
  const { id, voId } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("medical.read");
  requireFeature(auth, "verordnungen");
  if (!/^[0-9a-f-]{36}$/.test(voId)) notFound();
  const data = await getTherapyReport(auth, voId, id);
  if (!data) notFound();
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "prescription.therapy_report_view", entity: "prescription", entityId: voId, meta: { patientId: id } });
  const locked = data.vo.status === "billing_ready" || data.vo.status === "billed" || data.vo.status === "cancelled";
  const canEdit = auth.can("medical.write") && !locked;
  const r = data.report;
  const sections: [string, string | null | undefined][] = [
    ["Befund", r?.findings],
    ["Verlauf", r?.course],
    ["Ergebnis", r?.result],
    ["Empfehlung", r?.recommendation],
    ["Weitere Angaben", r?.notes],
  ];
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <BackLink href={`/kunden/${id}/verordnungen`} label={`Verordnungen ${fullName(data.p)}`} />
          <h1 className={pageTitleCls}>Therapiebericht</h1>
          <p className="text-sm text-muted">
            Verordnung vom {dateDe(data.vo.issuedAt)}{data.vo.doctorName ? ` · an ${data.vo.doctorName}` : ""}
            {reportOrdered(data.vo.positions) ? " · Position 78530 verordnet" : data.vo.therapyReportRequested ? " · von der Ärztin/dem Arzt angefordert" : ""}
          </p>
        </div>
        {r && downloadAllowed(auth, "gkv_document") ? <LinkButton href={`/api/verordnungen/${voId}/therapiebericht`} target="_blank" variant="secondary"><FileDown size={18} aria-hidden /> PDF für die Ärztin/den Arzt</LinkButton> : null}
      </header>
      {sp.gespeichert ? <div className="mb-4"><FormSuccess message="Therapiebericht gespeichert." /></div> : null}
      {canEdit ? (
        <TherapyReportForm
          prescriptionId={voId}
          patientId={id}
          maxDate={berlinDateIso()}
          initial={{ reportDate: r?.reportDate ?? berlinDateIso(), findings: r?.findings ?? "", course: r?.course ?? "", result: r?.result ?? "", recommendation: r?.recommendation ?? "", notes: r?.notes ?? "" }}
        />
      ) : r ? (
        <Card className="flex flex-col gap-4">
          <p className="text-sm text-muted">Berichtsdatum {dateDe(r.reportDate)}{locked ? " · Verordnung abrechnungsreif/abgerechnet – nicht mehr änderbar" : ""}</p>
          {sections.filter(([, t]) => t).map(([label, t]) => (
            <section key={label}>
              <h2 className="font-semibold">{label}</h2>
              <p className="whitespace-pre-wrap text-sm">{t}</p>
            </section>
          ))}
        </Card>
      ) : (
        <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">Noch kein Therapiebericht erstellt.</p>
      )}
      <p className="mt-4 text-xs text-muted">Versand an die Ärztin/den Arzt: PDF herunterladen bzw. drucken (Fax/Post/KIM außerhalb von PodoHero). Der Bericht zählt mit dem Berichtsdatum als Einheit 78530.</p>
    </div>
  );
}
