import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Card, CardTitle, Checkbox, Empty, Field, Input, Select, Table } from "@/components/ui";
import { berlinDateIso, dateDe, dateTimeDe } from "@/lib/format";
import { addMonthsIso, normalizeBatchCode } from "@/lib/hygiene-rules";
import { canReleaseBatch, listBatches, listDevices, suggestCodeForToday } from "@/server/hygiene";
import { canEditHygiene, canViewHygiene, requireHygiene } from "../access";
import { createBatchAction } from "../actions";
import { BatchBadge } from "../badges";
import { DecideBatchForm } from "../hygiene-forms";

export const metadata = { title: "Sterilgut-Chargen" };

export default async function BatchesPage(props: PageProps<"/hygiene/chargen">) {
  const auth = await requireHygiene(canViewHygiene);
  const sp = await props.searchParams;
  if (typeof sp.code === "string" && sp.code.trim()) redirect(`/hygiene/charge/${encodeURIComponent(normalizeBatchCode(sp.code))}`);
  const org = auth.organization.id;
  const today = berlinDateIso();
  const edit = canEditHygiene(auth);
  const release = canReleaseBatch(auth);
  const [batches, devs, suggestion] = await Promise.all([
    listBatches(auth, 200),
    listDevices(auth, { activeOnly: true }),
    edit ? suggestCodeForToday(org, today) : Promise.resolve(""),
  ]);
  const sterilizers = devs.filter((d) => d.kind === "sterilizer");
  const pending = batches.filter((b) => b.b.result === "pending");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Charge suchen / Rückverfolgung</CardTitle>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <Field label="Chargennummer" className="min-w-60 flex-1">
            <Input name="code" placeholder="ST-20261108-01" autoComplete="off" required />
          </Field>
          <Button type="submit" variant="secondary">Anzeigen</Button>
        </form>
      </Card>

      {edit ? (
        <Card>
          <CardTitle>Neue Charge (Sterilisationszyklus)</CardTitle>
          {/* key: nach dem Anlegen neu aufbauen, damit der nächste Nummernvorschlag erscheint */}
          <ActionForm key={suggestion} action={createBatchAction} submit="Charge anlegen">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Chargennummer *" hint="Vorschlag: ST-JJJJMMTT-NN">
                <Input name="code" defaultValue={suggestion} required maxLength={60} className="font-mono" />
              </Field>
              <Field label="Sterilisator" hint={sterilizers.length ? undefined : <Link href="/hygiene/geraete" className="underline">Gerät anlegen</Link>}>
                <Select name="deviceId" defaultValue={sterilizers[0]?.id ?? ""}>
                  <option value="">– ohne Gerät –</option>
                  {sterilizers.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}{d.serialNumber ? ` (SN ${d.serialNumber})` : ""}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Zyklus-Nr.">
                <Input name="cycleNo" maxLength={40} inputMode="numeric" />
              </Field>
              <Field label="Lagerfrist bis" hint="Standard 6 Monate (Sterilgutverpackung)">
                <Input type="date" name="expiresAt" defaultValue={addMonthsIso(today, 6)} min={today} />
              </Field>
              <Field label="Bemerkung" className="sm:col-span-2 lg:col-span-3">
                <Input name="note" maxLength={500} placeholder="z. B. Programm 134 °C, Beladung" />
              </Field>
              <div className="flex items-end">
                <Checkbox name="indicatorOk" label="Indikator OK" />
              </div>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {pending.length ? (
        <Card>
          <CardTitle>Freigabe ausstehend ({pending.length})</CardTitle>
          {!release ? <p className="mb-3 text-sm text-muted">Freigabe/Sperre nur durch Inhaber:in oder Podolog:in.</p> : null}
          <div className="grid gap-4 md:grid-cols-2">
            {pending.map((b) => (
              <div key={b.b.id} className="rounded-xl border border-border p-4">
                <p className="font-mono text-lg font-semibold">{b.b.code}</p>
                <p className="mb-3 text-sm text-muted">
                  {dateTimeDe(b.b.processedAt)} · {b.device ?? b.b.sterilizer ?? "ohne Gerät"}
                  {b.b.cycleNo ? ` · Zyklus ${b.b.cycleNo}` : ""} · Indikator {b.b.indicatorOk ? "OK" : "nicht bestätigt"}
                </p>
                {release ? <DecideBatchForm id={b.b.id} code={b.b.code} /> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <section>
        <h2 className="mb-3 font-display text-xl font-semibold">Alle Chargen</h2>
        {batches.length === 0 ? (
          <Empty title="Noch keine Chargen" />
        ) : (
          <Table>
            <thead>
              <tr><th>Charge</th><th>Aufbereitet</th><th>Gerät / Zyklus</th><th>Status</th><th>Lagerfrist</th><th>Entschieden</th><th></th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.b.id}>
                  <td className="font-mono font-semibold">{b.b.code}</td>
                  <td>{dateTimeDe(b.b.processedAt)}</td>
                  <td>{b.device ?? b.b.sterilizer ?? "–"}{b.b.cycleNo ? ` · ${b.b.cycleNo}` : ""}</td>
                  <td><BatchBadge result={b.b.result} expiresAt={b.b.expiresAt} today={today} /></td>
                  <td>{dateDe(b.b.expiresAt)}</td>
                  <td>{b.b.releasedAt ? <>{dateDe(b.b.releasedAt)}<span className="block text-xs text-muted">{b.releasedByName}</span></> : "–"}</td>
                  <td className="whitespace-nowrap text-sm">
                    <Link href={`/hygiene/charge/${encodeURIComponent(b.b.code)}`} className="font-semibold text-primary">Details</Link>
                    {" · "}
                    <Link href={`/hygiene/charge/${encodeURIComponent(b.b.code)}/etikett`} className="font-semibold text-primary">Etikett</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
