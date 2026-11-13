import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, Table } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, money } from "@/lib/format";
import { STATUS_LABEL, type PatientStatus } from "@/lib/patient-status";
import { DECEASED_LABEL } from "@/lib/patient-deceased";
import { withOrg } from "@/db";
import { listPatients } from "@/server/patients";
import { patientQuota } from "@/server/patient-limit";
import { returnPath, withReturn } from "@/lib/back-link";

export const metadata = { title: "Patienten" };

const statusTone: Record<PatientStatus, "primary" | "info" | "warn" | "neutral"> = {
  new: "info",
  active: "primary",
  overdue: "warn",
  inactive: "neutral",
};

export default async function PatientsPage(props: PageProps<"/kunden">) {
  const auth = await requireAuth("patients.read");
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const rows = await listPatients(auth, { q, status });
  const from = returnPath("/kunden", { q, status }); // Akte → „Zurück“ landet wieder auf dieser gefilterten Liste
  // Kostenlos-Tarif: „x von 20 Patient:innen“
  const quota = await withOrg(auth.organization.id, (tx) => patientQuota(tx, auth.organization.id));
  const filters: { key: string; label: string }[] = [
    { key: "", label: "Alle" },
    { key: "active", label: "Aktiv" },
    { key: "overdue", label: "Überfällig" },
    { key: "new", label: "Neu" },
    { key: "inactive", label: "Inaktiv" },
    { key: "deceased", label: "Verstorben" },
  ];
  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Patienten"
        subtitle={`${rows.length} ${rows.length === 1 ? "Eintrag" : "Einträge"}`}
        actions={
          <>
            {auth.can("import.run") ? (
              <LinkButton href="/einstellungen/import" variant="secondary"><Upload size={18} aria-hidden /> Import</LinkButton>
            ) : null}
            {auth.can("patients.write") ? (
              <LinkButton href="/kunden/neu"><Plus size={18} aria-hidden /> Neuer Patient</LinkButton>
            ) : null}
          </>
        }
      />
      {quota ? (
        <p className={`mb-4 rounded-xl px-4 py-3 text-sm ${quota.used >= quota.limit ? "bg-warn-soft font-medium text-warn-soft-text" : "bg-info-soft text-info-soft-text"}`}>
          Kostenloser Tarif: {quota.used} von {quota.limit} Patient:innen (archivierte zählen mit)
          {quota.used >= quota.limit ? " – die Grenze ist erreicht. Für weitere Patient:innen bitte einen Tarif wählen." : "."}
          {auth.role === "owner" ? <> <Link href="/einstellungen/abo" className="font-semibold underline">Tarif ansehen</Link></> : null}
        </p>
      ) : null}
      <form className="mb-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="search">Suchen</label>
        <input
          id="search"
          name="q"
          type="search"
          enterKeyHint="search"
          defaultValue={q}
          // App-Verknüpfung „Patientensuche“ (src/app/manifest.ts): /kunden?suche=1 setzt den Cursor direkt ins Feld
          autoFocus={sp.suche === "1"}
          placeholder="Name, Telefon, E-Mail, Ort oder Nummer"
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3.5 text-[15px] placeholder:text-muted focus:border-primary focus:outline-none sm:max-w-md"
        />
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <Link
              key={f.key}
              href={{ pathname: "/kunden", query: { ...(q ? { q } : {}), ...(f.key ? { status: f.key } : {}) } }}
              className={`inline-flex h-11 items-center rounded-xl px-3.5 text-sm font-semibold ${status === f.key ? "bg-primary text-on-primary" : "border border-border bg-surface"}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </form>
      {rows.length === 0 ? (
        <Empty title={q ? "Keine Treffer" : "Noch keine Patienten"}>
          {q ? "Andere Schreibweise versuchen." : "Lege den ersten Patienten an oder importiere deine Excel-Liste."}
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Name</th>
              <th>Kontakt</th>
              <th>Ort</th>
              <th>Letzter Besuch</th>
              <th>Offen</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-surface-2">
                <td className="tabular-nums text-muted">{p.number}</td>
                <td>
                  <Link href={withReturn(`/kunden/${p.id}`, from)} className="font-semibold hover:text-primary">
                    {p.lastName}{p.firstName ? `, ${p.firstName}` : ""}
                  </Link>
                  <div className="mt-1"><RiskBadges flags={p.riskFlags} compact /></div>
                </td>
                <td className="text-sm">{p.phoneMobile ?? p.phoneLandline ?? p.email ?? "–"}</td>
                <td className="text-sm">{[p.zip, p.city].filter(Boolean).join(" ") || "–"}{p.homeVisit ? " · Hausbesuch" : ""}</td>
                <td className="text-sm tabular-nums">{dateDe(p.lastVisit)}</td>
                <td className="tabular-nums">{p.openCents > 0 ? <span className="font-semibold text-danger">{money(p.openCents)}</span> : "–"}</td>
                <td>{p.deceased ? <Badge>{DECEASED_LABEL}</Badge> : <Badge tone={statusTone[p.status]}>{STATUS_LABEL[p.status]}</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
