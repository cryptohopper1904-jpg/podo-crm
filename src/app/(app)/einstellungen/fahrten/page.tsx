import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Field, Input, Select } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { TRIP_LOG_DISCLAIMER } from "@/lib/routing/trip-log";
import { routingStatus } from "@/server/routing";
import { listStartLocations, loadTripSettings, practiceAddress } from "@/server/trips";
import { removeStartLocationAction, saveStartLocationAction, saveTripSettingsAction } from "./actions";

export const metadata = { title: "Fahrten & Startorte" };

const euro = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2).replace(".", ","));

function LocationFields({ l }: { l?: { id?: string; name: string; street: string | null; zip: string | null; city: string | null; isDefault?: boolean } }) {
  return (
    <>
      {l?.id ? <input type="hidden" name="id" value={l.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name"><Input name="name" defaultValue={l?.name ?? ""} placeholder="z. B. Praxis, Zuhause, Lager" required maxLength={60} /></Field>
        <Field label="Straße"><Input name="street" defaultValue={l?.street ?? ""} maxLength={120} /></Field>
        <Field label="PLZ"><Input name="zip" defaultValue={l?.zip ?? ""} maxLength={10} inputMode="numeric" /></Field>
        <Field label="Ort"><Input name="city" defaultValue={l?.city ?? ""} maxLength={80} /></Field>
      </div>
      <Checkbox name="isDefault" defaultChecked={l?.isDefault} label="Standard-Startort" />
    </>
  );
}

export default async function TripSettingsPage() {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  const [settings, locations, practice] = await Promise.all([loadTripSettings(org), listStartLocations(org), practiceAddress(org)]);
  const status = routingStatus();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardTitle>Routing-Dienst</CardTitle>
        <p className="text-sm">
          {status.ok ? <Badge tone={status.demo ? "warn" : "primary"}>{status.demo ? "Entwicklung" : "aktiv"}</Badge> : <Badge tone="warn">nicht eingerichtet</Badge>} {status.message}
        </p>
        {!status.ok || status.demo ? (
          <p className="mt-2 text-sm text-muted">
            Ohne Routing-Dienst werden Strecken als Luftlinie × 1,3 geschätzt und als „geschätzt“ gekennzeichnet. Betrieb: <code>ROUTING_PROVIDER=osrm</code> mit
            eigenem <code>OSRM_URL</code> oder <code>ROUTING_PROVIDER=ors</code> mit <code>ORS_API_KEY</code> (openrouteservice, Heidelberg). Übermittelt werden nur
            Koordinaten, nie Namen; Ergebnisse werden 30 Tage zwischengespeichert. Adressen werden über Photon (OpenStreetMap) in Koordinaten umgewandelt.
          </p>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Fahrzeug & Wegegeld</CardTitle>
        <ActionForm action={saveTripSettingsAction}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Fahrzeug (optional)"><Input name="vehicleLabel" defaultValue={settings.vehicleLabel ?? ""} placeholder="z. B. VW Polo" maxLength={60} /></Field>
            <Field label="Kennzeichen (optional)"><Input name="plate" defaultValue={settings.plate ?? ""} placeholder="z. B. P-AB 123" maxLength={15} /></Field>
            <Field label="Wegegeld je km (€)" hint="Selbst festlegen (Preisliste/Vereinbarung) – es gibt hier keinen voreingestellten Satz.">
              <Input name="rate" defaultValue={euro(settings.rateCents)} placeholder="z. B. 0,30" inputMode="decimal" />
            </Field>
            <Field label="Wegegeld für">
              <Select name="billing" defaultValue={settings.billing}>
                <option value="oneway">nur Hinweg</option>
                <option value="roundtrip">Hin- und Rückweg (× 2)</option>
              </Select>
            </Field>
          </div>
          <Checkbox name="returnToStart" defaultChecked={settings.returnToStart} label="Tagesroute: Rückfahrt zum Startort einplanen" />
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>Startorte</CardTitle>
        <p className="mb-4 text-sm text-muted">Von hier aus startet ihr zu Hausbesuchen. Die Adresse wird einmalig in Koordinaten umgewandelt und gespeichert.</p>
        <div className="flex flex-col gap-4">
          {locations.map((l) => (
            <div key={l.id} className="rounded-xl border border-border p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{l.name}</span>
                {l.isDefault ? <Badge tone="primary">Standard</Badge> : null}
                {l.lat === null ? <Badge tone="warn">Adresse nicht gefunden</Badge> : <Badge tone="neutral">Koordinaten gespeichert</Badge>}
                <form action={removeStartLocationAction} className="ml-auto">
                  <input type="hidden" name="id" value={l.id} />
                  <button className="h-10 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2">Entfernen</button>
                </form>
              </div>
              <ActionForm action={saveStartLocationAction} submit="Ändern">
                <LocationFields l={l} />
              </ActionForm>
            </div>
          ))}
          <div className="rounded-xl border border-dashed border-border-strong p-4">
            <p className="mb-2 font-semibold">Neuer Startort</p>
            <ActionForm action={saveStartLocationAction} submit="Startort anlegen">
              <LocationFields l={locations.length ? undefined : { name: "Praxis", street: practice.street, zip: practice.zip, city: practice.city, isDefault: true }} />
            </ActionForm>
          </div>
        </div>
      </Card>
      <p className="text-xs text-muted">{TRIP_LOG_DISCLAIMER}</p>
    </div>
  );
}
