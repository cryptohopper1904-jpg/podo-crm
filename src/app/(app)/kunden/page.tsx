import Link from "next/link";
import { ChevronRight, Phone, Plus, Upload } from "lucide-react";
import { Badge, Empty, LinkButton, PageHeader, SearchInput, SegmentedControl, Table } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { ageYears, dateDe, money } from "@/lib/format";
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
      <form role="search" className="mb-4 flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
        <SearchInput
          id="search"
          name="q"
          label="Patienten suchen"
          defaultValue={q}
          // App-Verknüpfung „Patientensuche“ (src/app/manifest.ts): /kunden?suche=1 setzt den Cursor direkt ins Feld
          autoFocus={sp.suche === "1"}
          placeholder="Name, Telefon, Ort, Nr. …"
          className="md:max-w-md"
        />
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <SegmentedControl
          label="Filter nach Status"
          items={filters.map((f) => ({
            href: { pathname: "/kunden", query: { ...(q ? { q } : {}), ...(f.key ? { status: f.key } : {}) } },
            label: f.label,
            active: status === f.key,
          }))}
        />
      </form>
      {rows.length === 0 ? (
        <Empty
          title={q || status ? "Keine Treffer" : "Noch keine Patienten"}
          action={
            q || status ? (
              <LinkButton href="/kunden" variant="secondary">Alle anzeigen</LinkButton>
            ) : auth.can("patients.write") ? (
              <LinkButton href="/kunden/neu"><Plus size={18} aria-hidden /> Neuer Patient</LinkButton>
            ) : null
          }
        >
          {q ? "Andere Schreibweise versuchen." : status ? "In diesem Filter ist gerade niemand." : "Lege den ersten Patienten an oder importiere deine Excel-Liste."}
        </Empty>
      ) : (
        <>
          {/* Handy/kleines Tablet: Karten statt 640-px-Tabelle – ganze Karte ist der Link zur Akte, Anruf daneben */}
          <ul aria-label="Patienten" className="flex flex-col gap-2 md:hidden">
            {rows.map((p) => {
              const phone = p.phoneMobile ?? p.phoneLandline;
              const age = ageYears(p.birthDate);
              const place = [p.zip, p.city].filter(Boolean).join(" ");
              return (
                <li key={p.id} className="flex min-w-0 items-stretch overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
                  <Link href={withReturn(`/kunden/${p.id}`, from)} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 px-4 py-3 hover:bg-surface-2">
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 text-[17px] leading-6 font-semibold wrap-break-word">
                          {p.lastName}{p.firstName ? `, ${p.firstName}` : ""}
                        </span>
                        {p.deceased ? <Badge>{DECEASED_LABEL}</Badge> : <Badge tone={statusTone[p.status]}>{STATUS_LABEL[p.status]}</Badge>}
                      </span>
                      <span className="text-sm text-muted">
                        Nr. {p.number}{age !== null ? ` · ${age} J.` : ""}{place ? ` · ${place}` : ""}{p.homeVisit ? " · Hausbesuch" : ""}
                      </span>
                      <RiskBadges flags={p.riskFlags} compact />
                      <span className="text-sm text-muted">
                        Letzter Besuch: <span className="tabular-nums">{dateDe(p.lastVisit)}</span>
                        {p.openCents > 0 ? <> · <span className="font-semibold text-danger">offen {money(p.openCents)}</span></> : null}
                      </span>
                    </span>
                    <ChevronRight size={18} aria-hidden className="shrink-0 text-muted" />
                  </Link>
                  {phone ? (
                    <a
                      href={`tel:${phone}`}
                      aria-label={`${p.firstName ?? ""} ${p.lastName} anrufen`.trim()}
                      title={phone}
                      className="flex w-14 shrink-0 items-center justify-center border-l border-border text-primary hover:bg-surface-2"
                    >
                      <Phone size={20} aria-hidden />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
            <Table label="Patienten">
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
                      {/* Block-Link: ganze Namenszeile treffbar (≥ 44 px), nicht nur die Schrift */}
                      <Link href={withReturn(`/kunden/${p.id}`, from)} className="-my-1 flex min-h-11 items-center font-semibold hover:text-primary">
                        {p.lastName}{p.firstName ? `, ${p.firstName}` : ""}
                      </Link>
                      <RiskBadges flags={p.riskFlags} compact />
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
          </div>
        </>
      )}
    </div>
  );
}
