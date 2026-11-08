import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { Badge, Card, Empty, LinkButton } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, fullName, weekdayLong } from "@/lib/format";
import { visitDay } from "@/server/care-homes";
import { QuickRow } from "./quick-row";

export const metadata = { title: "Besuchstag" };

export default async function VisitDayPage(props: PageProps<"/pflegeheime/[id]/besuchstag">) {
  const { id } = await props.params;
  const auth = await requireAuth("patients.read");
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await visitDay(auth, id);
  if (!data) notFound();
  const canDoc = auth.can("medical.write");
  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted"><Link href={`/pflegeheime/${id}`} className="hover:text-primary">← {data.home.name}</Link></p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Besuchstag · {weekdayLong(new Date())}</h1>
          <p className="text-sm text-muted">{data.residents.length} Bewohner:innen · Listen-Doku: je Zeile ein unveränderbarer Behandlungseintrag</p>
        </div>
        {auth.can("invoices.write") ? <LinkButton href={`/rechnungen/neu?pflegeheim=${id}`} variant="secondary"><FileText size={18} aria-hidden /> Sammelrechnung</LinkButton> : null}
      </header>
      {data.residents.length === 0 ? (
        <Empty title="Keine Bewohner:innen zugeordnet"><Link href={`/pflegeheime/${id}`} className="font-semibold text-primary">Bewohner:innen zuordnen</Link></Empty>
      ) : (
        <ol className="flex flex-col gap-3">
          {data.residents.map((r) => (
            <li key={r.id}>
              <Card className="p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <Link href={`/kunden/${r.id}`} className="font-display text-lg font-semibold hover:text-primary">{fullName(r)}</Link>
                  <RiskBadges flags={r.riskFlags} compact />
                  {r.prescriptions.length ? <Badge tone="info">Verordnung</Badge> : null}
                  <span className="ml-auto text-sm text-muted">{r.lastTreatedAt ? `zuletzt ${dateDe(r.lastTreatedAt)}` : auth.can("medical.read") ? "noch keine Behandlung" : ""}</span>
                </div>
                {r.notes ? <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn-soft-text">{r.notes}</p> : null}
                {canDoc ? (
                  <QuickRow careHomeId={id} patientId={r.id} services={data.services} prescriptions={r.prescriptions} />
                ) : (
                  <p className="text-sm text-muted">Dokumentieren ist nur für Behandler:innen möglich.</p>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-6 text-xs text-muted">Ausführliche Doku (Fotos, Fußschema, Spange): Name anklicken → „Behandlung dokumentieren“.</p>
    </div>
  );
}
