import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { Badge, Card, CardTitle, Empty, Table, BackLink } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { listBillingBatches, listRunningPrescriptions } from "@/server/prescriptions";
import { payoutTotals } from "@/server/gkv-handover";
import { BatchForm, type ReadyRow } from "./batch-form";
import { Direktabrechnung, quelleAus } from "./direktabrechnung";

export const metadata = { title: "GKV-Abrechnung" };

const PARTNER: Record<string, string> = { manual: "manuell", "opta-data": "opta data", optica: "Optica", azh: "azh / noventi", rzh: "RZH", other: "anderes" };

export default async function BillingPage({ searchParams }: PageProps<"/verordnungen/abrechnung">) {
  const auth = await requireAuth("invoices.write");
  // Abrechnungsdaten enthalten Diagnosen (ICD-10)
  if (!auth.can("medical.read")) redirect("/kein-zugriff");
  const quelle = quelleAus((await searchParams).p302);
  const [ready, batches, payouts] = [await listRunningPrescriptions(auth, ["billing_ready"]), await listBillingBatches(auth), await payoutTotals(auth)];
  const rows: ReadyRow[] = ready.map(({ vo, p, evaluation: ev }) => {
    const missing = [!vo.icd10 && "ICD-10", !vo.doctorLanr && "LANR", !vo.doctorBsnr && "BSNR"].filter(Boolean);
    return {
      id: vo.id,
      patient: `${fullName(p)} (#${p.number})`,
      group: vo.diagnosisGroup,
      issuedAt: dateDe(vo.issuedAt),
      units: `${ev.unitsUsed}/${vo.units}`,
      remedy: vo.remedyCostCents === null ? "–" : money(vo.remedyCostCents),
      copayment: `${money(vo.copaymentCents)}${(vo.copaymentCents ?? 0) > 0 ? (vo.copaymentPaidAt ? " ✓" : " (offen)") : ""}`,
      warning:
        [
          missing.length ? `Fehlt: ${missing.join(", ")}` : null,
          vo.remedyCostCents === null ? "Kein Preis-Snapshot (erneut auf abrechnungsreif setzen)" : null,
          // GKV Paket C: ohne bestätigtes Kennzeichen kein Abrechnungslauf (Bestand vor Paket C)
          !vo.prescriptionKind ? "Verordnungsart nicht bestätigt (Akte → Abrechnungsangaben)" : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
    };
  });
  return (
    <div className="mx-auto max-w-6xl">
      <BackLink href="/verordnungen" label="Verordnungen" />
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight wrap-break-word">GKV-Abrechnung</h1>
      <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Hier werden abrechnungsreife Verordnungen zu einem Abrechnungslauf zusammengefasst und als neutrales Übergabepaket (ZIP mit CSV, JSON, Begleitzettel und
        Leistungsnachweisen) an ein beliebiges Abrechnungszentrum übergeben. Das Paket wird beim ersten Download archiviert; die Rückmeldung (Auszahlung,
        Absetzungen) lässt sich am Lauf wieder einlesen.
        Die eigentliche Abrechnung nach § 302 SGB V (Datenübermittlung an die Krankenkassen) erfolgt über das Abrechnungszentrum (Partner).
        Die Papierverordnungen gehen wie gewohnt per Post an den Partner.
      </p>
      <p className="mb-6 text-sm">
        <Link href="/verordnungen/absetzungen" className="font-semibold text-primary">Absetzungen der Kassen</Link>
        <span className="text-muted"> – offene Absetzungen und Retaxen; korrigierte Verordnungen erscheinen nach erneutem „abrechnungsreif“ hier.</span>
      </p>
      <Card className="mb-6">
        <CardTitle>Abrechnungsreif ({rows.length})</CardTitle>
        {rows.length ? <BatchForm rows={rows} /> : <Empty title="Keine abrechnungsreifen Verordnungen">Abgeschlossene Verordnungen in der Patientenakte als „abrechnungsreif“ markieren.</Empty>}
      </Card>
      <Card>
        <CardTitle>Abrechnungsläufe</CardTitle>
        {batches.length === 0 ? (
          <Empty title="Noch keine Abrechnungsläufe" />
        ) : (
          <Table>
            <thead><tr><th>Erstellt</th><th>Partner</th><th>Verordnungen</th><th>Heilmittelkosten</th><th>Summe Zuzahlungen</th><th>Status</th><th>Ausgezahlt</th><th>Übergabe</th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{dateTimeDe(b.createdAt)}{b.note ? <div className="text-xs text-muted">{b.note}</div> : null}</td>
                  <td>{PARTNER[b.partner] ?? b.partner}</td>
                  <td className="tabular-nums">{b.prescriptionCount}</td>
                  <td className="tabular-nums">{b.remedyTotalCents === null ? "–" : money(b.remedyTotalCents)}</td>
                  <td className="tabular-nums">{money(b.copaymentTotalCents ?? b.totalCents)}</td>
                  <td>{b.exportedAt ? <Badge tone="primary">exportiert {dateDe(b.exportedAt)}</Badge> : <Badge tone="warn">noch nicht exportiert</Badge>}</td>
                  <td className="tabular-nums">{payouts.get(b.id) ? `${money(payouts.get(b.id)!.cents)} (${dateDe(payouts.get(b.id)!.last)})` : "–"}</td>
                  <td className="whitespace-nowrap">
                    <Link href={`/verordnungen/abrechnung/${b.id}`} className="font-semibold text-primary">Öffnen</Link>
                    {auth.support ? null : (
                      <a href={`/api/export/gkv-batch/${b.id}/paket`} className="ml-3 inline-flex items-center gap-1 font-semibold text-primary"><Download size={16} aria-hidden /> Paket</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Direktabrechnung auth={auth} quelle={quelle} batches={batches} />
    </div>
  );
}
