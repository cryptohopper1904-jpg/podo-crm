import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, Field, Input, PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe, timeDe } from "@/lib/format";
import { kmDe, minDe } from "@/lib/routing/geo";
import { distanceSourceLabel } from "@/lib/routing/trip-log";
import { departureOptions } from "@/server/trips";
import { arriveTripAction } from "../actions";
import { NavLinks } from "../nav-links";
import { DepartureForm } from "./departure-form";

export const metadata = { title: "Ich fahre los" };

export default async function DeparturePage(props: PageProps<"/touren/losfahren">) {
  const auth = await requireAuth("appointments.write");
  const sp = await props.searchParams;
  const id = typeof sp.termin === "string" ? sp.termin : "";
  const data = id ? await departureOptions(auth, id) : null;
  if (!data) notFound();
  const { appointment: a, patient: p, existing } = data;
  const trip = existing && !existing.voided ? existing : null;

  const options = [
    { value: "here", label: "Aktueller Standort", sub: "Standort wird nur jetzt einmal abgefragt", icon: "here" as const },
    ...data.locations.map((l) => ({ value: `loc:${l.id}`, label: l.name, sub: l.geocoded ? (l.isDefault ? "Standard-Startort" : undefined) : "Adresse nicht gefunden", icon: "loc" as const, disabled: !l.geocoded })),
    ...(data.previous ? [{ value: "last", label: `Vom letzten Patienten (${data.previous.label})`, sub: `Termin ${timeDe(data.previous.startsAt)}`, icon: "last" as const, disabled: !data.previous.hasAddress }] : []),
  ];
  const initial = data.previous?.hasAddress ? "last" : (options.find((o) => o.value.startsWith("loc:") && !("disabled" in o && o.disabled))?.value ?? "here");

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Ich fahre los" back={{ href: "/touren", label: "Touren" }} />
      <Card className="mb-4">
        <p className="text-sm text-muted">{dateTimeDe(a.startsAt)}–{timeDe(a.endsAt)} {a.homeVisit ? null : <Badge tone="warn">nicht als Hausbesuch markiert</Badge>}</p>
        <p className="mt-1 text-lg font-semibold">{p.name} <span className="text-sm font-normal text-muted">(K-{p.number})</span></p>
        <p className="text-muted">{p.address || "Adresse fehlt in der Patientenakte"}</p>
        <p className="mt-2 text-xs text-muted">Im Fahrtenbuch steht nur: „{data.label}“.</p>
      </Card>

      {trip ? (
        <div className="flex flex-col gap-4">
          <Card>
            <p className="text-sm text-muted">Fahrt erfasst · ab {trip.fromLabel}</p>
            <p className="mt-1 font-display text-3xl font-bold tabular-nums">{kmDe(trip.distanceM)}</p>
            <p className="text-sm text-muted">
              {trip.durationSec ? `ca. ${minDe(trip.durationSec)} · ` : ""}
              {distanceSourceLabel(trip.distanceSource)}
              {trip.distanceSource === "estimate" ? " (Luftlinie × 1,3)" : ""}
              {trip.arrivedAt ? ` · angekommen ${timeDe(trip.arrivedAt)}` : ""}
            </p>
          </Card>
          {p.address ? <div className="flex flex-col gap-2 sm:flex-row"><NavLinks address={p.address} big /></div> : null}
          {trip.arrivedAt ? (
            <Card>
              <p className="text-sm">Ankunft gespeichert. Korrekturen bitte im <Link href={`/touren/fahrtenbuch/${trip.id}`} className="font-semibold text-primary">Fahrtenbuch</Link>.</p>
            </Card>
          ) : (
            <Card>
              <h2 className="mb-3 font-display text-lg font-semibold">Angekommen</h2>
              <ActionForm action={arriveTripAction} submit="Angekommen">
                <input type="hidden" name="tripId" value={trip.id} />
                <Field label="Gefahrene km (optional korrigieren)" hint={`berechnet: ${kmDe(trip.distanceM)}`}>
                  <Input name="km" inputMode="decimal" placeholder={(Math.round(trip.distanceM / 100) / 10).toString().replace(".", ",")} />
                </Field>
                <Field label="Kilometerstand bei Ankunft (optional)">
                  <Input name="odometerEnd" inputMode="numeric" pattern="[0-9]*" />
                </Field>
              </ActionForm>
            </Card>
          )}
        </div>
      ) : a.status === "cancelled" ? (
        <Empty title="Termin abgesagt" />
      ) : (
        <Card>
          <DepartureForm appointmentId={a.id} options={options} initial={initial} />
        </Card>
      )}
    </div>
  );
}
