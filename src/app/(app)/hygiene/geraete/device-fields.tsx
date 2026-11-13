import { Checkbox, Field, FieldSlot, Input, Select, Textarea } from "@/components/ui";
import { DEVICE_KINDS, DEVICE_KIND_LABELS } from "@/lib/hygiene-rules";
import type { devices } from "@/db/schema";

type Device = typeof devices.$inferSelect;

export function DeviceFields({ device }: { device?: Device }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {device ? <input type="hidden" name="id" value={device.id} /> : null}
      <Field label="Bezeichnung *">
        <Input name="name" defaultValue={device?.name ?? ""} required maxLength={120} placeholder="z. B. Autoklav Melag" />
      </Field>
      <Field label="Art">
        <Select name="kind" defaultValue={device?.kind ?? "sterilizer"}>
          {DEVICE_KINDS.map((k) => <option key={k} value={k}>{DEVICE_KIND_LABELS[k]}</option>)}
        </Select>
      </Field>
      <Field label="Hersteller">
        <Input name="manufacturer" defaultValue={device?.manufacturer ?? ""} maxLength={120} />
      </Field>
      <Field label="Seriennummer">
        <Input name="serialNumber" defaultValue={device?.serialNumber ?? ""} maxLength={80} />
      </Field>
      <Field label="Standort">
        <Input name="location" defaultValue={device?.location ?? ""} maxLength={120} placeholder="z. B. Aufbereitungsraum" />
      </Field>
      <div />
      <Field label="Nächste Wartung">
        <Input type="date" name="nextMaintenanceAt" defaultValue={device?.nextMaintenanceAt ?? ""} />
      </Field>
      <Field label="Nächste Validierung" hint="Aufbereitungsprozess (z. B. jährlich)">
        <Input type="date" name="nextValidationAt" defaultValue={device?.nextValidationAt ?? ""} />
      </Field>
      <Field label="Nächste elektr. Prüfung" hint="DGUV V3">
        <Input type="date" name="nextElectricalCheckAt" defaultValue={device?.nextElectricalCheckAt ?? ""} />
      </Field>
      <Field label="Notizen" className="sm:col-span-2">
        <Textarea name="notes" defaultValue={device?.notes ?? ""} maxLength={1000} rows={2} />
      </Field>
      {device ? (
        <FieldSlot spacer="hidden sm:block">
          <Checkbox name="active" defaultChecked={device.active} label="in Betrieb" />
        </FieldSlot>
      ) : null}
    </div>
  );
}
