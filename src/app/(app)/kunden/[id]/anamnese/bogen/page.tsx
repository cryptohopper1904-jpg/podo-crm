import Link from "next/link";
import { notFound } from "next/navigation";
import { SheetHeader } from "@/components/sheet-header";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { initialFromRiskFlags } from "@/lib/anamnesis";
import { dateDe, fullName, timeDe } from "@/lib/format";
import { anamnesisSheet } from "@/server/anamnesis";
import { AnamnesisForm } from "../anamnesis-form";

export const metadata = { title: "Anamnesebogen" };

/**
 * Anamnesebogen in der Praxis – zum gemeinsamen Ausfüllen mit dem Patienten am iPad im Behandlungsraum.
 * Datum, Name und Patientennummer sind vorausgefüllt (aus der Akte bzw. dem heutigen Termin).
 * Gespeichert wird wie gewohnt als neue Praxis-Version (unveränderbar, frühere Versionen bleiben).
 */
export default async function AnamnesisSheetPage(props: PageProps<"/kunden/[id]/anamnese/bogen">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("medical.write");
  const termin = typeof sp.termin === "string" ? sp.termin : null;
  const data = await anamnesisSheet(auth, id, { mode: "fill", appointmentId: termin });
  if (!data) notFound();
  const { patient: p, appointment, latest } = data;
  const day = appointment ? appointment.startsAt : new Date();
  return (
    <div className="mx-auto max-w-4xl">
      <p className="no-print mb-3 flex flex-wrap gap-x-4 text-sm text-muted">
        <Link href={`/kunden/${id}/anamnese`} className="inline-flex min-h-11 items-center hover:text-primary">← Anamnese von {fullName(p)}</Link>
        <Link href={`/kunden/${id}/anamnese/drucken`} className="inline-flex min-h-11 items-center font-semibold text-primary">Druckfassung / PDF</Link>
      </p>
      <SheetHeader
        organizationId={auth.organization.id}
        practiceName={auth.organization.name}
        title="Anamnesebogen"
        fields={[
          ["Datum", dateDe(day) + (appointment ? ` · ${timeDe(appointment.startsAt)} Uhr` : "")],
          ["Patient:in", fullName(p)],
          ["Patientennummer", String(p.number)],
          ["Geburtsdatum", p.birthDate ? dateDe(p.birthDate) : null],
        ]}
      />
      {/* Datenschutz (Art. 9 DSGVO): Das Gerät zeigt die ganze App – nur gemeinsam mit dem Personal ausfüllen */}
      <p className="no-print mb-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">
        Bitte gemeinsam mit dem Patienten ausfüllen und das iPad nicht unbeaufsichtigt weitergeben – auf diesem Gerät sind auch andere Kundenakten erreichbar.
      </p>
      <div className="mb-4"><RiskBadges flags={p.riskFlags} /></div>
      {latest ? (
        <p className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-info-soft-text">
          Vorausgefüllt mit der letzten Anamnese vom {dateDe(latest.createdAt)}{latest.source === "online" ? " (online vom Kunden, bitte gemeinsam prüfen)" : ""}. Bitte Punkt für Punkt gemeinsam durchgehen.
        </p>
      ) : (
        <p className="mb-4 rounded-xl bg-info-soft px-4 py-3 text-info-soft-text">Erstanamnese – bitte gemeinsam mit dem Patienten ausfüllen.</p>
      )}
      <AnamnesisForm patientId={id} initial={latest?.data ?? initialFromRiskFlags(p.riskFlags)} touch />
    </div>
  );
}
