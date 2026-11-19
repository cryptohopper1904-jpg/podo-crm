import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, BackLink, Card, CardTitle, Empty, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { DEDUCTION_OUTCOME_LABEL, DEDUCTION_STATUS_LABEL, deductionTotals, type DeductionStatus } from "@/lib/rules/gkv-billing";
import { requireFeature } from "@/server/features";
import { listDeductions } from "@/server/gkv-billing";
import { DeductionStatusForm } from "./status-form";

export const metadata = { title: "Absetzungen" };

const FILTERS: { key: string; label: string; statuses?: DeductionStatus[] }[] = [
  { key: "", label: "Offen und Widerspruch", statuses: ["open", "objected"] },
  { key: "akzeptiert", label: "Akzeptiert", statuses: ["accepted"] },
  { key: "erledigt", label: "Erledigt", statuses: ["done"] },
  { key: "alle", label: "Alle" },
];

/**
 * Absetzungen/Retaxen der Kassen (GKV Paket C): Auswertung offener Absetzungen, Status pflegen. Rechte: Rechnungen
 * schreiben + medizinisch lesen (wie GKV-Abrechnung). Erfasst wird an der Verordnung in der Akte.
 */
export default async function DeductionsPage(props: PageProps<"/verordnungen/absetzungen">) {
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) redirect("/kein-zugriff");
  requireFeature(auth, "gkvBilling");
  const sp = await props.searchParams;
  const key = typeof sp.filter === "string" ? sp.filter : "";
  const filter = FILTERS.find((f) => f.key === key) ?? FILTERS[0];
  const listed = await listDeductions(auth);
  const all = "error" in listed ? [] : listed;
  const rows = filter.statuses ? all.filter((r) => filter.statuses!.includes(r.status)) : all;
  const totals = deductionTotals(all);
  const canEdit = !auth.support && !auth.readOnly;
  const year = berlinDateIso().slice(0, 4);
  const thisYear = all.filter((r) => r.deductedOn.startsWith(year));
  return (
    <div className="mx-auto max-w-6xl">
      <BackLink href="/verordnungen/abrechnung" label="GKV-Abrechnung" />
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight wrap-break-word">Absetzungen</h1>
      <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Absetzungen bzw. Retaxen der Krankenkassen zu abgerechneten Verordnungen. Erfassen an der Verordnung in der Akte („Absetzung erfassen“);
        ist die Verordnung zu korrigieren, dort „Korrektur nötig“ setzen – sie geht nach der Korrektur in den nächsten Abrechnungslauf.
      </p>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Offen" value={money(totals.open.cents)} tone={totals.open.count ? "warn" : "neutral"} sub={`${totals.open.count} Absetzung(en)`} />
        <Stat label="Im Widerspruch" value={money(totals.objected.cents)} tone="info" sub={`${totals.objected.count} Absetzung(en)`} />
        <Stat label="Akzeptiert" value={money(totals.accepted.cents)} tone="neutral" sub={`${totals.accepted.count} Absetzung(en)`} />
        <Stat label={`Summe ${year}`} value={money(thisYear.reduce((s, r) => s + r.amountCents, 0))} tone="neutral" sub={`${thisYear.length} Absetzung(en) mit Datum ${year}`} />
      </div>
      <nav aria-label="Filter" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link key={f.key} href={f.key ? `/verordnungen/absetzungen?filter=${f.key}` : "/verordnungen/absetzungen"} aria-current={f.key === filter.key ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold ${f.key === filter.key ? "bg-primary-soft text-primary-soft-text" : "hover:bg-surface-2"}`}>
            {f.label}
          </Link>
        ))}
      </nav>
      <Card>
        <CardTitle>{filter.label} ({rows.length})</CardTitle>
        {rows.length === 0 ? (
          <Empty title="Keine Absetzungen">Absetzungen der Kassen werden an der abgerechneten Verordnung in der Akte erfasst.</Empty>
        ) : (
          <Table label="Absetzungen" minWidth={960}>
            <thead>
              <tr><th>Datum</th><th>Person · Verordnung</th><th>Betrag</th><th>Code · Grund</th><th>Status</th>{canEdit ? <th>Bearbeiten</th> : <th>Notiz</th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{dateDe(r.deductedOn)}</td>
                  <td>
                    <Link href={`/kunden/${r.patientId}/verordnungen`} className="font-semibold text-primary">{r.patient} (#{r.patientNumber})</Link>
                    <div className="text-xs text-muted">VO vom {dateDe(r.issuedAt)}{r.prescriptionStatus === "correction_needed" ? " · Korrektur nötig" : ""}</div>
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{money(r.amountCents)}</td>
                  <td className="wrap-break-word">
                    {r.reasonCode ? <span className="font-semibold">{r.reasonCode} · </span> : null}{r.reason}
                    {r.letterRef || r.letterDate ? <div className="text-xs text-muted">Schreiben {r.letterRef ?? ""}{r.letterDate ? ` vom ${dateDe(r.letterDate)}` : ""}</div> : null}
                  </td>
                  <td><Badge tone={r.status === "done" ? "neutral" : r.status === "objected" ? "info" : r.status === "accepted" ? "primary" : "warn"}>{DEDUCTION_STATUS_LABEL[r.status]}{r.outcome ? ` · ${DEDUCTION_OUTCOME_LABEL[r.outcome]}` : ""}</Badge></td>
                  {canEdit ? (
                    <td>{r.status === "done" ? <span className="text-xs text-muted">{r.note ?? "abgeschlossen"}</span> : <DeductionStatusForm id={r.id} status={r.status} note={r.note} amount={(r.amountCents / 100).toFixed(2).replace(".", ",")} letterRef={r.letterRef} letterDate={r.letterDate} />}</td>
                  ) : (
                    <td className="text-xs">{r.note ?? ""}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
