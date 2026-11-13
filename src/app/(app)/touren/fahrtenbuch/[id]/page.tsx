import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Field, Input, PageHeader } from "@/components/ui";
import { audit } from "@/lib/audit";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { dateDe, dateTimeDe } from "@/lib/format";
import { kmDe, minDe } from "@/lib/routing/geo";
import { distanceSourceLabel } from "@/lib/routing/trip-log";
import { canReadTripLog, getTrip } from "@/server/trips";
import { correctTripAction } from "../../actions";

export const metadata = { title: "Fahrt" };

const KIND: Record<string, string> = { arrival: "Ankunft", correction: "Korrektur", void: "Storno" };

export default async function TripDetailPage(props: PageProps<"/touren/fahrtenbuch/[id]">) {
  const auth = await requireAuth();
  if (!canReadTripLog(auth)) denyAccess(auth, "appointments.read");
  const { id } = await props.params;
  const data = await getTrip(auth, id);
  if (!data) notFound();
  const { trip: t, userNames } = data;
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "trip.view", entity: "trip", entityId: t.id });
  const who = (uid: string | null) => (uid ? (userNames[uid] ?? "unbekannt") : "–");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Fahrt am ${dateDe(t.tripDate)}`} back={{ href: `/touren/fahrtenbuch?monat=${t.tripDate.slice(0, 7)}`, label: "Fahrtenbuch" }} />
      <Card className="mb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[15px]">
          <dt className="text-muted">Start</dt><dd>{t.fromLabel}</dd>
          <dt className="text-muted">Ziel</dt><dd>{t.toLabel}</dd>
          <dt className="text-muted">Zweck</dt><dd>{t.purpose}</dd>
          <dt className="text-muted">Strecke</dt>
          <dd>
            <span className="font-semibold tabular-nums">{kmDe(t.distanceM)}</span> ({distanceSourceLabel(t.distanceSource)})
            {t.corrected ? <span className="text-muted"> · ursprünglich {kmDe(t.originalDistanceM)}</span> : null}
          </dd>
          <dt className="text-muted">Fahrzeit</dt><dd>{t.durationSec ? minDe(t.durationSec) : "–"}</dd>
          <dt className="text-muted">Abfahrt</dt><dd>{dateTimeDe(t.startedAt)} · {who(t.driverId)}</dd>
          <dt className="text-muted">Ankunft</dt><dd>{t.arrivedAt ? dateTimeDe(t.arrivedAt) : "–"}</dd>
          <dt className="text-muted">Fahrzeug</dt><dd>{[t.vehicleLabel, t.plate].filter(Boolean).join(" · ") || "–"}</dd>
          <dt className="text-muted">km-Stand</dt><dd>{t.odometerStart ?? "–"} → {t.odometerEnd ?? "–"}</dd>
          <dt className="text-muted">Status</dt><dd>{t.voided ? <Badge>storniert</Badge> : t.corrected ? <Badge tone="info">korrigiert</Badge> : <Badge tone="neutral">original</Badge>}</dd>
        </dl>
      </Card>

      <Card className="mb-6">
        <CardTitle>Verlauf (unveränderbar)</CardTitle>
        <ol className="flex flex-col gap-2 text-sm">
          <li>{dateTimeDe(t.startedAt)} · {who(t.driverId)} · Fahrt erfasst: {kmDe(t.originalDistanceM)}</li>
          {t.corrections.map((c) => (
            <li key={c.id}>
              {dateTimeDe(c.createdAt)} · {who(c.createdBy)} · <strong>{KIND[c.kind] ?? c.kind}</strong>
              {c.distanceM !== null ? ` · km → ${kmDe(c.distanceM)}` : ""}
              {c.purpose ? ` · Zweck → ${c.purpose}` : ""}
              {c.odometerStart !== null ? ` · km-Stand Beginn ${c.odometerStart}` : ""}
              {c.odometerEnd !== null ? ` · km-Stand Ende ${c.odometerEnd}` : ""}
              {c.reason ? ` · Grund: ${c.reason}` : ""}
            </li>
          ))}
        </ol>
      </Card>

      {auth.can("appointments.write") && !t.voided ? (
        <Card>
          <CardTitle>Korrektur anlegen</CardTitle>
          <ActionForm action={correctTripAction} submit="Korrektur speichern">
            <input type="hidden" name="tripId" value={t.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="km"><Input name="km" inputMode="decimal" placeholder={(Math.round(t.distanceM / 100) / 10).toString().replace(".", ",")} /></Field>
              <Field label="Zweck" hint="keine Namen oder Diagnosen"><Input name="purpose" maxLength={80} placeholder={t.purpose} /></Field>
              <Field label="km-Stand Beginn"><Input name="odometerStart" inputMode="numeric" /></Field>
              <Field label="km-Stand Ende"><Input name="odometerEnd" inputMode="numeric" /></Field>
            </div>
            <Field label="Grund *"><Input name="reason" required maxLength={300} placeholder="z. B. Umleitung, Tankstopp" /></Field>
            <Checkbox name="void" label="Fahrt stornieren (bleibt sichtbar, zählt nicht mehr)" />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
