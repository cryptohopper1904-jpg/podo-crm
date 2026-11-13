import Link from "next/link";
import { redirect } from "next/navigation";
import { Download } from "lucide-react";
import { Badge, Card, CardTitle, Empty, Table } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { listBillingBatches, listRunningPrescriptions } from "@/server/prescriptions";
import { BatchForm, type ReadyRow } from "./batch-form";

export const metadata = { title: "GKV-Abrechnung" };

const PARTNER: Record<string, string> = { manual: "manuell", "opta-data": "opta data", optica: "Optica", azh: "azh / noventi", rzh: "RZH", other: "anderes" };

export default async function BillingPage() {
  const auth = await requireAuth("invoices.write");
  // Abrechnungsdaten enthalten Diagnosen (ICD-10)
  if (!auth.can("medical.read")) redirect("/kein-zugriff");
  const [ready, batches] = [await listRunningPrescriptions(auth, ["billing_ready"]), await listBillingBatches(auth)];
  const rows: ReadyRow[] = ready.map(({ vo, p, evaluation: ev }) => {
    const missing = [!vo.icd10 && "ICD-10", !vo.doctorLanr && "LANR", !vo.doctorBsnr && "BSNR"].filter(Boolean);
    return {
      id: vo.id,
      patient: `${fullName(p)} (#${p.number})`,
      group: vo.diagnosisGroup,
      issuedAt: dateDe(vo.issuedAt),
      units: `${ev.unitsUsed}/${vo.units}`,
      copayment: vo.copaymentExempt ? "befreit" : `${money(vo.copaymentCents)}${vo.copaymentPaidAt ? " ✓" : " (offen)"}`,
      warning: missing.length ? `Fehlt: ${missing.join(", ")}` : null,
    };
  });
  return (
    <div className="mx-auto max-w-6xl">
      <p className="text-sm text-muted"><Link href="/verordnungen" className="hover:text-primary">← Verordnungen</Link></p>
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">GKV-Abrechnung</h1>
      <p className="mb-6 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Hier werden abrechnungsreife Verordnungen zu einem Abrechnungslauf zusammengefasst und als CSV (neutrales Format) exportiert.
        Die eigentliche Abrechnung nach § 302 SGB V (Datenübermittlung an die Krankenkassen) erfolgt über das Abrechnungszentrum (Partner).
        Die Papierverordnungen gehen wie gewohnt per Post an den Partner.
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
            <thead><tr><th>Erstellt</th><th>Partner</th><th>Verordnungen</th><th>Summe Zuzahlungen</th><th>Status</th><th>Export</th></tr></thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{dateTimeDe(b.createdAt)}{b.note ? <div className="text-xs text-muted">{b.note}</div> : null}</td>
                  <td>{PARTNER[b.partner] ?? b.partner}</td>
                  <td className="tabular-nums">{b.prescriptionCount}</td>
                  <td className="tabular-nums">{money(b.totalCents)}</td>
                  <td>{b.exportedAt ? <Badge tone="primary">exportiert {dateDe(b.exportedAt)}</Badge> : <Badge tone="warn">noch nicht exportiert</Badge>}</td>
                  <td><a href={`/api/export/gkv-batch/${b.id}`} className="inline-flex items-center gap-1 font-semibold text-primary"><Download size={16} aria-hidden /> CSV</a></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
