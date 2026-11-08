import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { braceEpisodes, integrationConnections, patients, services } from "@/db/schema";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { fullName } from "@/lib/format";
import { DokuForm } from "../doku-form";

export const metadata = { title: "Behandlung dokumentieren" };

export default async function NewRecordPage(props: PageProps<"/kunden/[id]/doku/neu">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const appointmentId = typeof sp.termin === "string" ? sp.termin : undefined;
  const auth = await requireAuth("medical.write");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, id)));
    if (!p) return null;
    const svc = await tx.select({ id: services.id, code: services.code, name: services.name }).from(services).where(and(eq(services.organizationId, org), eq(services.active, true))).orderBy(asc(services.code));
    const [brace] = await tx.select().from(braceEpisodes).where(and(eq(braceEpisodes.organizationId, org), eq(braceEpisodes.patientId, id), eq(braceEpisodes.status, "active"))).limit(1);
    const [voice] = await tx.select().from(integrationConnections).where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, "transcription")));
    return { p, svc, brace, voiceEnabled: !!voice && voice.status !== "disconnected" };
  });
  if (!data) notFound();
  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <p className="text-sm text-muted"><Link href={`/kunden/${id}`} className="hover:text-primary">← Kundenakte</Link></p>
        <h1 className="font-display text-3xl font-semibold">{fullName(data.p)}</h1>
        <div className="mt-2"><RiskBadges flags={data.p.riskFlags} /></div>
      </header>
      <DokuForm
        patientId={id}
        appointmentId={appointmentId}
        services={data.svc}
        activeBrace={data.brace ? { id: data.brace.id, side: data.brace.side, toe: data.brace.toe, braceType: data.brace.braceType, stage: data.brace.stage } : null}
        voiceEnabled={data.voiceEnabled}
      />
    </div>
  );
}
