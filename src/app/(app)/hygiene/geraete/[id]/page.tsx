import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, CardTitle, Empty, Field, Input, Select, Table, Textarea, BackLink } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { berlinDateIso, dateDe, dateTimeDe } from "@/lib/format";
import {
  DEADLINE_FIELDS,
  DEADLINE_LABELS,
  DEVICE_EVENT_KINDS,
  DEVICE_EVENT_LABELS,
  DEVICE_KIND_LABELS,
  type DeviceEventKind,
  type DeviceKind,
} from "@/lib/hygiene-rules";
import { getDevice } from "@/server/hygiene";
import { canEditHygiene, canViewHygiene, requireHygiene } from "../../access";
import { addDeviceEventAction, saveDeviceAction } from "../../actions";
import { BatchBadge, DeadlineBadge } from "../../badges";
import { DeviceFields } from "../device-fields";

export const metadata = { title: "Gerätebuch" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DevicePage(props: PageProps<"/hygiene/geraete/[id]">) {
  const auth = await requireHygiene(canViewHygiene);
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const data = await getDevice(auth, id);
  if (!data) notFound();
  const { device, events, batches } = data;
  const today = berlinDateIso();
  const edit = canEditHygiene(auth);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <BackLink href="/hygiene/geraete" label="Geräte" />
          <h2 className="font-display text-2xl font-semibold">{device.name}</h2>
          <p className="text-sm text-muted">
            {DEVICE_KIND_LABELS[device.kind as DeviceKind] ?? device.kind}
            {device.manufacturer ? ` · ${device.manufacturer}` : ""}
            {device.serialNumber ? ` · SN ${device.serialNumber}` : ""}
            {device.location ? ` · ${device.location}` : ""}
            {!device.active ? " · außer Betrieb" : ""}
          </p>
        </div>
        <PrintButton label="Gerätebuch drucken" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {DEADLINE_FIELDS.map((f) => (
          <div key={f} className="rounded-xl border border-border bg-surface p-4">
            <p className="text-sm font-medium">{DEADLINE_LABELS[f]}</p>
            <div className="mt-2"><DeadlineBadge date={device[f]} today={today} /></div>
          </div>
        ))}
      </div>

      {edit ? (
        <Card className="no-print">
          {/* key: nach dem Speichern leeres Formular – verhindert doppelte Einträge im unveränderbaren Gerätebuch */}
          <CardTitle>Eintrag ins Gerätebuch</CardTitle>
          <ActionForm key={events.length} action={addDeviceEventAction} submit="Eintrag speichern">
            <input type="hidden" name="deviceId" value={device.id} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Art *">
                <Select name="kind" defaultValue="maintenance">
                  {DEVICE_EVENT_KINDS.map((k) => <option key={k} value={k}>{DEVICE_EVENT_LABELS[k]}</option>)}
                </Select>
              </Field>
              <Field label="Datum *">
                <Input type="date" name="occurredAt" defaultValue={today} max={today} required />
              </Field>
              <Field label="Durchgeführt von" hint="Firma/Person">
                <Input name="performedBy" maxLength={120} />
              </Field>
              <Field label="Neue Frist" hint="nur bei Wartung/Validierung/Prüfung">
                <Input type="date" name="nextDueAt" min={today} placeholder="keine neue Frist" clearable />
              </Field>
              <Field label="Bemerkung / Ergebnis" className="sm:col-span-2 lg:col-span-4" hint="Prüfprotokolle bitte zusätzlich in Papierform bzw. im Praxisordner ablegen (Protokoll-Nr. hier notieren).">
                <Textarea name="note" maxLength={2000} rows={2} />
              </Field>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <section>
        <h3 className="mb-3 font-display text-xl font-semibold">Gerätebuch</h3>
        <p className="mb-3 text-sm text-muted">Einträge sind unveränderbar (MPBetreibV). Korrekturen als neuen Eintrag erfassen.</p>
        {events.length === 0 ? (
          <Empty title="Noch keine Einträge" />
        ) : (
          <Table label="Gerätebuch">
            <thead><tr><th>Datum</th><th>Art</th><th>Durchgeführt von</th><th>Bemerkung</th><th>Erfasst</th></tr></thead>
            <tbody>
              {events.map(({ e, author }) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{dateDe(e.occurredAt)}</td>
                  <td>{DEVICE_EVENT_LABELS[e.kind as DeviceEventKind] ?? e.kind}</td>
                  <td>{e.performedBy ?? "–"}</td>
                  <td className="whitespace-pre-line">{e.note ?? ""}</td>
                  <td className="text-sm text-muted">{dateTimeDe(e.createdAt)}{author ? ` · ${author}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {batches.length ? (
        <Card>
          <CardTitle>Letzte Chargen dieses Geräts</CardTitle>
          <ul className="flex flex-wrap gap-2">
            {batches.map((b) => (
              <li key={b.id}>
                <Link href={`/hygiene/charge/${encodeURIComponent(b.code)}`} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-surface-2">
                  <span className="font-mono">{b.code}</span>
                  <BatchBadge result={b.result} expiresAt={null} today={today} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {edit ? (
        <Card className="no-print">
          <details>
            <summary className="inline-flex min-h-11 cursor-pointer items-center font-display text-xl font-semibold">Stammdaten & Fristen bearbeiten</summary>
            <div className="mt-4">
              <ActionForm action={saveDeviceAction}>
                <DeviceFields device={device} />
              </ActionForm>
            </div>
          </details>
        </Card>
      ) : null}
    </div>
  );
}
