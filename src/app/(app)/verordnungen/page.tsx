import Link from "next/link";
import { FileInput, Receipt } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, Stat, Table } from "@/components/ui";
import { TrafficLight } from "@/components/traffic-light";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, fullName } from "@/lib/format";
import { RULES_VERSION, STATUS_LABEL, type PrescriptionStatus } from "@/lib/rules/prescription";
import { listRunningPrescriptions } from "@/server/prescriptions";

export const metadata = { title: "Verordnungen" };

const FILTERS = [
  { key: "", label: "Alle laufenden" },
  { key: "frist", label: "Frist kritisch" },
  { key: "rest", label: "Letzte Einheiten" },
  { key: "abrechnung", label: "Abrechnungsreif" },
] as const;

export default async function PrescriptionsOverviewPage(props: PageProps<"/verordnungen">) {
  const auth = await requireAuth("patients.read");
  const sp = await props.searchParams;
  const filter = typeof sp.filter === "string" ? sp.filter : "";
  const medical = auth.can("medical.read");
  const all = await listRunningPrescriptions(auth);
  const critical = all.filter((r) => r.evaluation.startState === "missed" || r.evaluation.startState === "soon");
  const lastUnits = all.filter((r) => (r.vo.status === "active" || r.vo.status === "open") && r.evaluation.unitsRemaining <= 1);
  const ready = all.filter((r) => r.vo.status === "billing_ready");
  const rows = filter === "frist" ? critical : filter === "rest" ? lastUnits : filter === "abrechnung" ? ready : all;
  const order = { red: 0, yellow: 1, blue: 2, green: 3, gray: 4 } as const;
  rows.sort((a, b) => order[a.evaluation.light] - order[b.evaluation.light] || a.evaluation.startBy.localeCompare(b.evaluation.startBy));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Verordnungen"
        subtitle="GKV-Heilmittelverordnungen Podologie"
        actions={
          <>
            {auth.can("medical.write") ? <LinkButton href="/verordnungen/import" variant="secondary"><FileInput size={18} aria-hidden /> eVerordnung importieren</LinkButton> : null}
            {auth.can("invoices.write") && auth.can("medical.read") ? <LinkButton href="/verordnungen/abrechnung" variant="secondary"><Receipt size={18} aria-hidden /> Abrechnung ({ready.length})</LinkButton> : null}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Beginn-Frist kritisch" value={critical.length} sub="verpasst oder in ≤ 5 Tagen" tone={critical.length ? "accent" : "neutral"} />
        <Stat label="Letzte Einheit" value={lastUnits.length} sub="Folgeverordnung anfragen" tone={lastUnits.length ? "warn" : "neutral"} />
        <Stat label="Abrechnungsreif" value={ready.length} tone="info" />
      </div>
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key ? `/verordnungen?filter=${f.key}` : "/verordnungen"} aria-current={filter === f.key ? "page" : undefined} className={filter === f.key ? "rounded-full bg-primary px-3.5 py-2 text-sm font-semibold text-on-primary" : "rounded-full border border-border bg-surface px-3.5 py-2 text-sm font-semibold"}>
            {f.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Empty title="Keine Verordnungen in dieser Ansicht">Neue Verordnungen werden in der Kundenakte unter „Verordnungen“ erfasst.</Empty>
      ) : (
        <Table>
          <thead>
            <tr><th>Ampel</th><th>Kunde</th><th>VO</th><th>Beginn bis</th><th>Einheiten</th><th>Status</th><th>Hinweis</th></tr>
          </thead>
          <tbody>
            {rows.map(({ vo, p, evaluation: ev }) => (
              <tr key={vo.id}>
                <td><TrafficLight light={ev.light} showLabel /></td>
                <td>{medical ? <Link href={`/kunden/${p.id}/verordnungen`} className="font-semibold hover:text-primary">{fullName(p)}</Link> : <Link href={`/kunden/${p.id}`} className="font-semibold hover:text-primary">{fullName(p)}</Link>}<div className="text-xs text-muted">#{p.number}{p.insurerName ? ` · ${p.insurerName}` : ""}</div></td>
                <td>{vo.diagnosisGroup || "GKV-VO"}<div className="text-xs text-muted">{dateDe(vo.issuedAt)}</div></td>
                <td className="tabular-nums">{ev.startState === "started" ? <span className="text-muted">begonnen</span> : <>{dateDe(ev.startBy)}<div className="text-xs text-muted">{ev.daysToStartDeadline >= 0 ? `noch ${ev.daysToStartDeadline} Tage` : `${-ev.daysToStartDeadline} Tage drüber`}</div></>}</td>
                <td className="tabular-nums">{ev.unitsUsed}/{vo.units}<div className="text-xs text-muted">{ev.unitsRemaining} offen</div></td>
                <td><Badge tone={vo.status === "billing_ready" ? "info" : "neutral"}>{STATUS_LABEL[vo.status as PrescriptionStatus] ?? vo.status}</Badge></td>
                <td className="max-w-72 text-sm text-muted">{medical ? (ev.messages[0] ?? "–") : ev.startState === "missed" || ev.startState === "soon" ? "Beginn-Frist beachten" : "–"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="mt-6 text-xs text-muted">Regelwerk {RULES_VERSION} – vor Echtbetrieb gegen aktuelle HeilM-RL/§125-Vertrag prüfen.</p>
    </div>
  );
}
