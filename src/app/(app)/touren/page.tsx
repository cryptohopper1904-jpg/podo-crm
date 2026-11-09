import Link from "next/link";
import { AlertTriangle, Car, Flag, Home, MapPin } from "lucide-react";
import { Badge, Button, Card, Empty, Field, Input, LinkButton, PageHeader, Select, Stat } from "@/components/ui";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, timeDe, weekdayLong } from "@/lib/format";
import { kmDe, minDe } from "@/lib/routing/geo";
import { osmLegLink } from "@/lib/routing/trip-log";
import { dayTour, type TourStart } from "@/server/trips";
import { NavLinks } from "./nav-links";

export const metadata = { title: "Touren" };

const STATUS: Record<string, string> = { planned: "geplant", confirmed: "bestätigt", done: "erledigt" };

export default async function ToursPage(props: PageProps<"/touren">) {
  const auth = await requireAuth("appointments.read");
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(one("datum")) ? one("datum") : berlinDateIso();
  const startParam = one("start");
  const start: TourStart | null = startParam === "letzter" ? { kind: "last" } : /^[0-9a-f-]{36}$/.test(startParam) ? { kind: "location", id: startParam } : null;
  const returnTo = one("rueck") === "keine" ? "none" : /^[0-9a-f-]{36}$/.test(one("rueck")) ? one("rueck") : null;
  const optimize = one("opt") === "1";
  const mine = one("wer") === "ich";
  const tour = await dayTour(auth, { date, start, returnTo, optimize, mine });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "tour.view", meta: { date, visits: tour.visits.length, optimize } });
  const canDrive = auth.can("appointments.write");
  const qs = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ datum: date, ...(startParam ? { start: startParam } : {}), ...(one("rueck") ? { rueck: one("rueck") } : {}), ...(mine ? { wer: "ich" } : {}), ...(optimize ? { opt: "1" } : {}), ...patch });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `/touren?${p}`;
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Touren"
        subtitle={`Hausbesuche · ${weekdayLong(`${date}T12:00:00Z`)}`}
        actions={
          <>
            <LinkButton href="/touren/fahrtenbuch" variant="secondary">Fahrtenbuch</LinkButton>
            {auth.can("settings.manage") ? <LinkButton href="/einstellungen/fahrten" variant="ghost">Startorte</LinkButton> : null}
          </>
        }
      />

      <Card className="mb-6">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <Field label="Datum"><Input type="date" name="datum" defaultValue={date} /></Field>
          <Field label="Start">
            <Select name="start" defaultValue={startParam}>
              <option value="">Standard-Startort</option>
              {tour.startLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="letzter">vom letzten Kunden (Resttour)</option>
            </Select>
          </Field>
          <Field label="Rückfahrt">
            <Select name="rueck" defaultValue={one("rueck")}>
              <option value="">{tour.settings.returnToStart ? "zum Startort (Standard)" : "keine (Standard)"}</option>
              {tour.startLocations.map((l) => <option key={l.id} value={l.id}>zu {l.name}</option>)}
              <option value="keine">keine Rückfahrt</option>
            </Select>
          </Field>
          <Field label="Termine">
            <Select name="wer" defaultValue={mine ? "ich" : ""}>
              <option value="">alle Behandler:innen</option>
              <option value="ich">nur meine</option>
            </Select>
          </Field>
          <div className="flex gap-2">
            {optimize ? <input type="hidden" name="opt" value="1" /> : null}
            <Button type="submit" variant="secondary" className="flex-1">Anzeigen</Button>
          </div>
        </form>
      </Card>

      {tour.visits.length === 0 ? (
        <Empty title="Keine Hausbesuche an diesem Tag">Termine mit Kennzeichen „Hausbesuch“ (am Termin oder in der Kundenakte) erscheinen hier.</Empty>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Hausbesuche" value={tour.visits.length} tone="primary" />
            <Stat label="Strecke gesamt" value={kmDe(tour.totals.distanceM)} sub={tour.totals.estimated ? "teilweise geschätzt (Luftlinie × 1,3)" : tour.totals.missing ? `${tour.totals.missing} Etappe(n) ohne Adresse` : "berechnet"} tone="info" />
            <Stat label="Fahrzeit gesamt" value={minDe(tour.totals.durationSec)} sub="ohne Behandlungszeit" tone="neutral" />
          </div>

          <div className="mb-6 flex flex-wrap gap-2">
            {optimize ? (
              <LinkButton href={qs({ opt: "" })} variant="secondary">Reihenfolge nach Uhrzeit</LinkButton>
            ) : (
              <LinkButton href={qs({ opt: "1" })} variant="secondary">Reihenfolge optimieren</LinkButton>
            )}
            {optimize ? <p className="self-center text-sm text-muted">Vorschlag nach kürzester Strecke – feste Terminzeiten bitte prüfen.</p> : null}
          </div>

          {[...tour.notes, ...tour.warnings].length ? (
            <Card className="mb-6 border-warn-soft-text/40 bg-warn-soft text-warn-soft-text">
              <ul className="flex flex-col gap-1.5 text-sm">
                {[...tour.notes, ...tour.warnings].map((w) => (
                  <li key={w} className="flex gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {w}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <ol className="flex flex-col">
            {tour.stops.map((s, i) => {
              const leg = i > 0 ? tour.legs[i - 1] : null;
              const v = s.visit;
              return (
                <li key={`${s.kind}-${i}`}>
                  {leg ? (
                    <div className="ml-5 flex flex-wrap items-center gap-2 border-l-2 border-dashed border-border-strong py-3 pl-6 text-sm text-muted">
                      <Car size={16} aria-hidden />
                      {leg.leg ? (
                        <>
                          <span className="font-semibold text-text tabular-nums">{kmDe(leg.leg.distanceM)}</span>
                          <span className="tabular-nums">· {minDe(leg.leg.durationSec)}</span>
                          {leg.leg.estimated ? <Badge tone="warn">geschätzt</Badge> : null}
                          {leg.from.point && leg.to.point ? (
                            <a href={osmLegLink(leg.from.point, leg.to.point)} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary">Strecke auf OpenStreetMap</a>
                          ) : null}
                        </>
                      ) : (
                        <span>Strecke unbekannt (Adresse fehlt)</span>
                      )}
                    </div>
                  ) : null}
                  <Card className="flex flex-wrap items-center gap-3 !p-4">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2" aria-hidden>
                      {s.kind === "visit" ? <MapPin size={18} /> : s.kind === "start" ? <Home size={18} /> : <Flag size={18} />}
                    </span>
                    <div className="min-w-0 flex-[1_1_14rem]">
                      {v && s.kind === "visit" ? (
                        <>
                          <p className="font-semibold">
                            <span className="tabular-nums">{timeDe(v.startsAt)}–{timeDe(v.endsAt)}</span> ·{" "}
                            <Link href={`/kunden/${v.patientId}`} className="hover:text-primary">{v.patientName}</Link>{" "}
                            <span className="text-sm font-normal text-muted">(K-{v.patientNumber})</span>
                          </p>
                          <p className="text-sm text-muted">{v.address || "Adresse fehlt"}{v.point ? "" : " · nicht gefunden"}</p>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold">{s.kind === "start" ? "Start" : "Rückfahrt"}: {s.label}</p>
                          <p className="text-sm text-muted">{s.address}</p>
                        </>
                      )}
                    </div>
                    {v && s.kind === "visit" ? (
                      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                        <Badge tone={v.status === "done" ? "primary" : "neutral"}>{STATUS[v.status] ?? v.status}</Badge>
                        {v.tripId ? <Badge tone="info">Fahrt erfasst</Badge> : null}
                        <NavLinks address={v.address} />
                        {canDrive && v.status !== "done" ? (
                          <Link href={`/touren/losfahren?termin=${v.appointmentId}`} className="inline-flex h-10 items-center rounded-xl bg-primary px-3 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                            {v.tripId ? "Fahrt / Ankunft" : "Ich fahre los"}
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ol>
          <p className="mt-6 text-xs text-muted">
            Keine eingebettete Karte (Datenschutz): Kartendienste öffnen sich erst auf Klick. An den Routing-Dienst gehen nur Koordinaten, keine Namen.
          </p>
        </>
      )}
    </div>
  );
}
