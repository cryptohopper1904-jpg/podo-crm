import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, BackLink, Card, CardTitle, Empty, Field, Input, Stat, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, dateTimeDe, money } from "@/lib/format";
import { batchHandoverInfo } from "@/server/gkv-handover";
import { manualPayoutAction } from "./actions";
import { PayoutImport } from "./payout-import";

export const metadata = { title: "Abrechnungslauf" };

const PARTNER: Record<string, string> = { manual: "manuell / noch offen", "opta-data": "opta data", optica: "Optica", azh: "azh / noventi", rzh: "RZH", other: "anderes" };

/**
 * Abrechnungslauf (GKV Paket E): neutrales Übergabepaket (Archiv, Nachdruck), Rückmeldung des Abrechnungszentrums
 * einlesen und Auszahlungen. Rechte wie die GKV-Abrechnung (invoices.write + medical.read).
 */
export default async function BatchPage(props: PageProps<"/verordnungen/abrechnung/[id]">) {
  const { id } = await props.params;
  const auth = await requireAuth("invoices.write");
  if (!auth.can("medical.read")) redirect("/kein-zugriff");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const info = await batchHandoverInfo(auth, id);
  if (!info) notFound();
  const { batch: b, archive } = info;
  const downloads = !auth.support;
  const writes = !auth.support && !auth.readOnly && !!b.exportedAt;
  const open = info.sollInsurerCents === null ? null : info.sollInsurerCents - info.paidCents - info.deductionCents;
  return (
    <div className="mx-auto max-w-6xl">
      <BackLink href="/verordnungen/abrechnung" label="GKV-Abrechnung" />
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight wrap-break-word">Abrechnungslauf vom {dateDe(b.createdAt)}</h1>
      <p className="mb-6 text-sm text-muted">
        Abrechnungszentrum: {PARTNER[b.partner] ?? b.partner} · {b.prescriptionCount} Verordnung(en){b.note ? ` · ${b.note}` : ""} ·{" "}
        {b.exportedAt ? <Badge tone="primary">übergeben {dateDe(b.exportedAt)}</Badge> : <Badge tone="warn">noch nicht übergeben</Badge>}
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Kassenanteil laut Lauf (Soll)" value={info.sollInsurerCents === null ? "–" : money(info.sollInsurerCents)} tone="info" sub={`Heilmittelkosten ${b.remedyTotalCents === null ? "–" : money(b.remedyTotalCents)} − Zuzahlungen ${money(b.copaymentTotalCents ?? b.totalCents)}`} />
        <Stat label="Ausgezahlt (erfasst)" value={money(info.paidCents)} tone="primary" sub={`${info.payouts.length} Auszahlung(en)`} />
        <Stat label="Absetzungen laut Rückmeldungen" value={money(info.deductionCents)} tone={info.deductionCents ? "warn" : "neutral"} sub="Bearbeitung unter „Absetzungen“" />
        <Stat label="Noch offen (Soll − Auszahlung − Absetzung)" value={open === null ? "–" : money(open)} tone={open ? "warn" : "neutral"} sub="Hilfsrechnung, keine Buchung" />
      </div>

      <Card className="mb-6">
        <CardTitle>Übergabepaket (neutrales Format)</CardTitle>
        <p className="mb-4 text-sm text-muted">
          ZIP mit Verordnungen und Behandlungen (CSV und JSON), Begleitzettel, Leistungsnachweisen/Therapieberichten als PDF und Prüfsummen – für jedes Abrechnungszentrum.
          Der erste Download erzeugt das Paket und archiviert es verschlüsselt; jeder weitere Download liefert exakt dieselbe Datei („Nachdruck“). Kein Datensatz nach § 302 SGB V.
        </p>
        {archive ? (
          <dl className="mb-4 grid gap-1 text-sm">
            <div className="flex flex-wrap gap-2"><dt className="text-muted">Archiviert:</dt><dd>{dateTimeDe(archive.createdAt)} · {archive.filename} · {(archive.sizeBytes / 1024).toFixed(0)} KB · Format {archive.schemaVersion}</dd></div>
            <div className="flex flex-wrap gap-2"><dt className="text-muted">SHA-256:</dt><dd className="break-all font-mono text-xs">{archive.sha256}</dd></div>
            {archive.afterFirstHandover ? <dd className="text-warn-soft-text">Der Lauf war schon vor dem Archiv übergeben – das Archiv gibt den Stand beim Archivieren wieder.</dd> : null}
          </dl>
        ) : null}
        {downloads ? (
          <div className="flex flex-wrap gap-3">
            <a href={`/api/export/gkv-batch/${b.id}/paket`} className="inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-on-primary"><Download size={18} aria-hidden /> {archive ? "Übergabepaket (Nachdruck)" : "Übergabepaket erzeugen und herunterladen"}</a>
            <a href={`/api/export/gkv-batch/${b.id}`} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 font-semibold"><Download size={18} aria-hidden /> nur Verordnungen (CSV)</a>
          </div>
        ) : (
          <p className="text-sm text-muted">Im Support-Modus sind Downloads gesperrt.</p>
        )}
      </Card>

      <Card className="mb-6">
        <CardTitle>Rückmeldung des Abrechnungszentrums einlesen</CardTitle>
        {!b.exportedAt ? <p className="mb-3 text-sm text-muted">Erst nach der Übergabe (Download des Übergabepakets) möglich.</p> : null}
        {auth.support ? <p className="mb-3 text-sm text-muted">Im Support-Modus nicht möglich – das erledigt die Praxis selbst.</p> : null}
        <PayoutImport batchId={b.id} disabled={!writes} />
      </Card>

      <Card>
        <CardTitle>Auszahlungen</CardTitle>
        {info.payouts.length ? (
          <Table label="Auszahlungen zu diesem Lauf">
            <thead><tr><th>Ausgezahlt am</th><th>Betrag</th><th>Absetzungen</th><th>Referenz</th><th>Quelle</th><th>Erfasst</th></tr></thead>
            <tbody>
              {info.payouts.map((p) => (
                <tr key={p.id}>
                  <td>{dateDe(p.paidAt)}</td>
                  <td className="tabular-nums">{money(p.amountCents)}</td>
                  <td className="tabular-nums">{p.deductionCents ? money(p.deductionCents) : "–"}</td>
                  <td>{p.reference ?? "–"}</td>
                  <td>{p.source === "import" ? `Rückmeldung (${p.lineCount} Zeilen)` : "von Hand"}</td>
                  <td>{dateTimeDe(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <Empty title="Noch keine Auszahlung erfasst" />
        )}
        <p className="mt-3 text-xs text-muted">Auszahlungen sind unveränderlich. Eine Fehleingabe bitte mit der Steuerberatung klären (offene Fachfrage) – es gibt bewusst keine Lösch- oder Minusbuchung.</p>
        {writes ? (
          <div className="mt-6">
            <h3 className="mb-2 font-semibold">Auszahlung von Hand erfassen</h3>
            <ActionForm action={manualPayoutAction} submit="Auszahlung erfassen" className="grid gap-4 sm:grid-cols-[160px_180px_1fr_auto] sm:items-end">
              <input type="hidden" name="batchId" value={b.id} />
              <Field label="Betrag (€)"><Input name="amount" inputMode="decimal" required placeholder="0,00" /></Field>
              <Field label="Ausgezahlt am"><Input name="paidAt" type="date" required max={berlinDateIso()} /></Field>
              <Field label="Referenz (optional)"><Input name="reference" maxLength={60} placeholder="z. B. Sammelrechnung / Avis" /></Field>
            </ActionForm>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
