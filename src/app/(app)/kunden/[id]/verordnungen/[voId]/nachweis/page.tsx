import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import { withOrg } from "@/db";
import { Badge, BackLink, Card, Empty, LinkButton, Table, pageTitleBox, pageTitleCls } from "@/components/ui";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { downloadAllowed } from "@/lib/auth/access";
import { berlinDateIso, dateDe, dateTimeDe, fullName } from "@/lib/format";
import { PAPER_SIGNATURE_LABEL, SIGNER_ROLE_LABEL } from "@/lib/signature";
import { loadPrescriptionWithPatient, positionsByDay } from "@/server/gkv-documents";
import { proofRows, signatureRequired } from "@/server/signatures";
import { SignatureLater } from "./signature-later";
import { PaperBulkForm } from "./paper-bulk";
import { requireFeature } from "@/server/features";

export const metadata = { title: "Leistungsnachweis" };

/**
 * Leistungsnachweis je Verordnung: alle Behandlungen mit Unterschrift der versicherten Person (bzw. Papier-Vermerk),
 * Nachtrag fehlender Unterschriften und PDF zum Ausdruck/Beilegen (GKV Paket B).
 */
export default async function ProofPage(props: PageProps<"/kunden/[id]/verordnungen/[voId]/nachweis">) {
  const { id, voId } = await props.params;
  const auth = await requireAuth("medical.read");
  // GKV-Bereich (Layout prüft schon; hier ausdrücklich, falls die Seite einmal anders eingebunden wird – Review R2-16)
  requireFeature(auth, "verordnungen");
  if (!/^[0-9a-f-]{36}$/.test(voId)) notFound();
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const row = await loadPrescriptionWithPatient(tx, org, voId, id);
    if (!row) return null;
    const rows = (await proofRows(tx, org, [voId])).get(voId) ?? [];
    return { ...row, rows };
  });
  if (!data) notFound();
  await audit({ organizationId: org, userId: auth.user.id, action: "prescription.proof_view", entity: "prescription", entityId: voId, meta: { patientId: id } });
  const canWrite = auth.can("medical.write");
  const byDay = positionsByDay(data.vo, [...new Set(data.rows.map((r) => r.date))], data.p.birthDate);
  const missing = data.rows.filter((r) => !r.signature).length;
  const patientName = [data.p.firstName, data.p.lastName].filter(Boolean).join(" ");
  const pdf = downloadAllowed(auth, "gkv_document");
  const seen = new Set<string>();
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <BackLink href={`/kunden/${id}/verordnungen`} label={`Verordnungen ${fullName(data.p)}`} />
          <h1 className={pageTitleCls}>Leistungsnachweis</h1>
          <p className="text-sm text-muted">
            Verordnung vom {dateDe(data.vo.issuedAt)}{data.vo.doctorName ? ` · ${data.vo.doctorName}` : ""} · {data.rows.length} von {data.vo.units} Einheiten dokumentiert
          </p>
        </div>
        {pdf ? <LinkButton href={`/api/verordnungen/${voId}/leistungsnachweis`} target="_blank" variant="secondary"><FileDown size={18} aria-hidden /> PDF zum Ausdruck</LinkButton> : null}
      </header>
      {missing ? (
        <p className="mb-4 rounded-xl bg-warn-soft px-4 py-3 text-sm font-medium text-warn-soft-text">
          Unterschrift fehlt bei {missing} {missing === 1 ? "Behandlung" : "Behandlungen"}.
          {signatureRequired(data.vo.rulesVersion) ? " „Abrechnungsreif“ ist erst möglich, wenn jede Behandlung unterschrieben bzw. „Unterschrift auf der Papier-Verordnung“ vermerkt ist." : " (Übernommene Verordnung: nur Hinweis.)"}
        </p>
      ) : null}
      {canWrite && missing ? <PaperBulkForm prescriptionId={voId} patientId={id} maxDate={berlinDateIso()} defaultDate={data.rows.filter((r) => !r.signature).at(-1)!.date} /> : null}
      {data.rows.length === 0 ? (
        <Empty title="Noch keine Behandlung">Behandlungen auf diese Verordnung werden in der Doku erfasst (Feld „Verordnung“).</Empty>
      ) : (
        <Card className="p-0">
          <Table label="Behandlungen mit Unterschrift" minWidth={720}>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Position(en)</th>
                <th>Unterschrift</th>
                <th>Unterschrieben von</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const first = !seen.has(r.date);
                seen.add(r.date);
                const day = first ? byDay.get(r.date) : undefined;
                return (
                  <tr key={r.recordId}>
                    <td className="whitespace-nowrap">{dateDe(r.date)}</td>
                    <td>{day?.text ?? (first ? "–" : "(gleicher Tag)")}</td>
                    <td>
                      {r.signature?.kind === "device" ? (
                        // eslint-disable-next-line @next/next/no-img-element -- geschütztes Bild aus der verschlüsselten Ablage (kein next/image-Cache)
                        <img src={`/api/signaturen/${r.signature.id}`} alt={`Unterschrift vom ${dateDe(r.date)}`} className="h-12 w-auto rounded border border-border bg-white" />
                      ) : r.signature?.kind === "paper" ? (
                        <Badge tone="info">{PAPER_SIGNATURE_LABEL}</Badge>
                      ) : canWrite ? (
                        <SignatureLater recordId={r.recordId} patientId={id} prescriptionId={voId} patientName={patientName} />
                      ) : (
                        <Badge tone="warn">Unterschrift fehlt</Badge>
                      )}
                    </td>
                    <td className="text-sm">
                      {r.signature ? (
                        <>
                          {[r.signature.signerName, r.signature.signerRole ? SIGNER_ROLE_LABEL[r.signature.signerRole] : null].filter(Boolean).join(", ") || "–"}
                          <span className="block text-xs text-muted">{dateTimeDe(r.signature.signedAt)}{r.signature.createdByName ? ` · erfasst von ${r.signature.createdByName}` : ""}</span>
                          {r.signature.late ? <span className="mt-1 block text-xs font-medium text-warn-soft-text">Nicht am Behandlungstag unterschrieben (nachgetragen)</span> : null}
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">Erfasste Unterschriften sind unveränderbar. Die Positionen je Tag stammen aus dem Preis-Snapshot bzw. der Zuordnung in zeitlicher Reihenfolge (docs/GKV.md).</p>
    </div>
  );
}
