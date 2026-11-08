import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Card, CardTitle, Empty, LinkButton, Table } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { berlinDateIso, dateDe, dateTimeDe, fullName } from "@/lib/format";
import { getBatchByCode, traceBatch } from "@/server/hygiene";
import { canViewHygiene, requireHygiene } from "../../access";
import { BatchBadge } from "../../badges";
import { codeFromParam } from "../code-param";

export const metadata = { title: "Charge – Rückverfolgung" };

/** Rückverfolgung: welche Behandlungen haben diese Charge verwendet (Rückruf bei Sterilisationsfehler). */
export default async function BatchTracePage(props: PageProps<"/hygiene/charge/[code]">) {
  const auth = await requireHygiene(canViewHygiene);
  const code = codeFromParam((await props.params).code);
  if (!code) notFound();
  const org = auth.organization.id;
  const today = berlinDateIso();
  const [batch, records] = await Promise.all([getBatchByCode(org, code), traceBatch(auth, code)]);
  const patientsById = new Map<string, (typeof records)[number] & { count: number; last: Date }>();
  for (const r of records) {
    const p = patientsById.get(r.patientId);
    if (p) p.count++;
    else patientsById.set(r.patientId, { ...r, count: 1, last: r.treatedAt });
  }
  const people = [...patientsById.values()].sort((a, b) => a.number - b.number);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted no-print"><Link href="/hygiene/chargen" className="underline">Sterilgut-Chargen</Link></p>
          <h2 className="font-mono text-2xl font-semibold">{code}</h2>
        </div>
        <div className="flex gap-2 no-print">
          {batch ? <LinkButton variant="secondary" href={`/hygiene/charge/${encodeURIComponent(code)}/etikett`}>Etikett drucken</LinkButton> : null}
          <PrintButton label="Rückrufliste drucken" />
        </div>
      </div>

      <Card>
        <CardTitle>Charge</CardTitle>
        {batch ? (
          <dl className="grid gap-x-6 gap-y-2 text-[15px] sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Status</dt><dd><BatchBadge result={batch.b.result} expiresAt={batch.b.expiresAt} today={today} /></dd>
            <dt className="text-muted">Aufbereitet</dt><dd>{dateTimeDe(batch.b.processedAt)}</dd>
            <dt className="text-muted">Gerät / Zyklus</dt><dd>{batch.device ?? batch.b.sterilizer ?? "–"}{batch.b.cycleNo ? ` · Zyklus ${batch.b.cycleNo}` : ""}</dd>
            <dt className="text-muted">Indikator</dt><dd>{batch.b.indicatorOk === null ? "–" : batch.b.indicatorOk ? "OK" : "nicht OK / nicht bestätigt"}</dd>
            <dt className="text-muted">Lagerfrist bis</dt><dd>{dateDe(batch.b.expiresAt)}</dd>
            <dt className="text-muted">Entschieden</dt><dd>{batch.b.releasedAt ? `${dateTimeDe(batch.b.releasedAt)} · ${batch.releasedByName ?? ""}` : "noch offen"}</dd>
            {batch.b.note ? (<><dt className="text-muted">Bemerkung</dt><dd className="whitespace-pre-line">{batch.b.note}</dd></>) : null}
          </dl>
        ) : (
          <p className="flex items-center gap-2 text-[15px]"><AlertTriangle size={18} aria-hidden className="text-accent" /> Diese Chargennummer ist nicht im Chargenbuch erfasst.</p>
        )}
      </Card>

      <Card>
        <CardTitle>Betroffene Kund:innen ({people.length})</CardTitle>
        <p className="mb-3 text-sm text-muted">Behandlungen, in deren Dokumentation diese Charge eingetragen ist. Der Abruf wird protokolliert.</p>
        {people.length === 0 ? (
          <Empty title="Keine Behandlung mit dieser Charge dokumentiert" />
        ) : (
          <Table>
            <thead><tr><th>Nr.</th><th>Name</th><th>Telefon</th><th>Behandlungen</th><th>zuletzt</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.patientId}>
                  <td className="tabular-nums">{p.number}</td>
                  <td><Link href={`/kunden/${p.patientId}`} className="font-semibold hover:underline">{fullName({ firstName: p.firstName, lastName: p.lastName })}</Link></td>
                  <td>{[p.phoneMobile, p.phoneLandline].filter(Boolean).join(" / ") || "–"}</td>
                  <td className="tabular-nums">{p.count}</td>
                  <td>{dateTimeDe(p.last)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {records.length ? (
        <Card>
          <CardTitle>Einzelne Behandlungen</CardTitle>
          <ul className="flex flex-col gap-1 text-[15px]">
            {records.map((r) => (
              <li key={r.recordId}>
                <Link href={`/kunden/${r.patientId}/doku/${r.recordId}`} className="hover:underline">
                  {dateTimeDe(r.treatedAt)} · Nr. {r.number} {fullName({ firstName: r.firstName, lastName: r.lastName })}
                </Link>
                <span className="text-muted"> · {r.author ?? "–"}{r.servicesText ? ` · ${r.servicesText.slice(0, 80)}` : ""}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
