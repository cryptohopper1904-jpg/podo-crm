import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Empty, Table } from "@/components/ui";
import { berlinDateIso } from "@/lib/format";
import { DEADLINE_FIELDS, DEVICE_KIND_LABELS, deadlineStatus, worstDeadline, type DeviceKind } from "@/lib/hygiene-rules";
import { listDevices } from "@/server/hygiene";
import { canEditHygiene, canViewHygiene, requireHygiene } from "../access";
import { saveDeviceAction } from "../actions";
import { DeadlineBadge } from "../badges";
import { DeviceFields } from "./device-fields";

export const metadata = { title: "Geräte & Gerätebuch" };

const LIGHT = {
  overdue: { cls: "bg-accent", label: "Frist überfällig" },
  soon: { cls: "bg-warn-soft ring-2 ring-inset ring-warn-soft-text", label: "Frist in ≤ 30 Tagen" },
  ok: { cls: "bg-primary", label: "Fristen ok" },
  none: { cls: "bg-border-strong", label: "keine Fristen" },
} as const;

export default async function DevicesPage() {
  const auth = await requireHygiene(canViewHygiene);
  const today = berlinDateIso();
  const devs = await listDevices(auth);

  return (
    <div className="flex flex-col gap-6">
      {devs.length === 0 ? (
        <Empty title="Noch keine Geräte erfasst">Sterilisator, Thermodesinfektor, Fräse, Ultraschallbad … mit Prüffristen anlegen.</Empty>
      ) : (
        <Table>
          <thead>
            <tr><th>Ampel</th><th>Gerät</th><th>Wartung</th><th>Validierung</th><th>Elektr. Prüfung</th></tr>
          </thead>
          <tbody>
            {devs.map((d) => {
              const worst = worstDeadline(DEADLINE_FIELDS.map((f) => deadlineStatus(d[f], today)));
              return (
                <tr key={d.id} className={d.active ? undefined : "opacity-60"}>
                  <td>
                    <span className={`inline-block size-4 rounded-full ${LIGHT[worst].cls}`} aria-hidden />
                    <span className="sr-only">{LIGHT[worst].label}</span>
                  </td>
                  <td>
                    <Link href={`/hygiene/geraete/${d.id}`} className="font-semibold hover:underline">{d.name}</Link>
                    <span className="block text-sm text-muted">
                      {DEVICE_KIND_LABELS[d.kind as DeviceKind] ?? d.kind}{d.serialNumber ? ` · SN ${d.serialNumber}` : ""}
                    </span>
                    {!d.active ? <Badge>außer Betrieb</Badge> : null}
                  </td>
                  <td><DeadlineBadge date={d.nextMaintenanceAt} today={today} /></td>
                  <td><DeadlineBadge date={d.nextValidationAt} today={today} /></td>
                  <td><DeadlineBadge date={d.nextElectricalCheckAt} today={today} /></td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {canEditHygiene(auth) ? (
        <Card>
          <CardTitle>Gerät hinzufügen</CardTitle>
          <ActionForm action={saveDeviceAction} submit="Gerät anlegen">
            <DeviceFields />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
