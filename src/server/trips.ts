import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg } from "@/db";
import { appointments, invoiceLines, invoices, organizations, patients, services, tripCorrections, trips, tripStartLocations, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { addressLine, haversineM, isValidPoint, roundPoint, type LatLon, type Leg } from "@/lib/routing/geo";
import { optimizeOrder, timeWarnings } from "@/lib/routing/optimize";
import {
  applyCorrections,
  cleanLabel,
  isPrivatePayer,
  monthTotals,
  travelKm,
  travelLineDescription,
  tripSettings,
  tripTargetLabel,
  type CorrectionRow,
  type EffectiveTrip,
  type TripRow,
  type TripSettings,
} from "@/lib/routing/trip-log";
import { geocodeAddress, routeLegs } from "./routing";

export class TripError extends Error {}

const UUID = z.uuid();
const isUuid = (v: unknown): v is string => UUID.safeParse(v).success;

// ───────────────────────── Einstellungen & Startorte ─────────────────────────
export async function loadTripSettings(org: string): Promise<TripSettings> {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  return tripSettings(o?.settings);
}

export async function saveTripSettings(auth: AuthContext, input: TripSettings) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  await db.transaction(async (tx) => {
    const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org)).for("update");
    await tx.update(organizations).set({ settings: { ...(o?.settings ?? {}), trips: input } }).where(eq(organizations.id, org));
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.trips", meta: { rateCents: input.rateCents, billing: input.billing, returnToStart: input.returnToStart } });
}

export type StartLocation = typeof tripStartLocations.$inferSelect;

export async function listStartLocations(org: string, includeInactive = false): Promise<StartLocation[]> {
  return withOrg(org, (tx) =>
    tx
      .select()
      .from(tripStartLocations)
      .where(includeInactive ? eq(tripStartLocations.organizationId, org) : and(eq(tripStartLocations.organizationId, org), eq(tripStartLocations.active, true)))
      .orderBy(desc(tripStartLocations.isDefault), asc(tripStartLocations.name)),
  );
}

export const startLocationInput = z.object({
  id: z.preprocess((v) => (v === "" ? undefined : v), z.uuid().optional()),
  name: z.string().trim().min(1, "Name fehlt").max(60),
  street: z.string().trim().max(120).optional().transform((v) => v || null),
  zip: z.string().trim().max(10).optional().transform((v) => v || null),
  city: z.string().trim().max(80).optional().transform((v) => v || null),
  isDefault: z.boolean().default(false),
});

/** Startort anlegen/ändern; Adresse wird geokodiert (Photon), Koordinaten gespeichert. */
export async function saveStartLocation(auth: AuthContext, input: z.infer<typeof startLocationInput>) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  const line = addressLine(input);
  if (!line) throw new TripError("Bitte eine Adresse (Straße, PLZ/Ort) angeben.");
  const point = await geocodeAddress(org, line);
  const values = { name: input.name, street: input.street, zip: input.zip, city: input.city, lat: point?.lat ?? null, lon: point?.lon ?? null, updatedAt: new Date() };
  const id = await withOrg(org, async (tx) => {
    if (input.isDefault) await tx.update(tripStartLocations).set({ isDefault: false }).where(eq(tripStartLocations.organizationId, org));
    if (input.id) {
      const [row] = await tx
        .update(tripStartLocations)
        .set({ ...values, ...(input.isDefault ? { isDefault: true } : {}) })
        .where(and(eq(tripStartLocations.organizationId, org), eq(tripStartLocations.id, input.id)))
        .returning({ id: tripStartLocations.id });
      if (!row) throw new TripError("Startort nicht gefunden.");
      return row.id;
    }
    const [any] = await tx.select({ id: tripStartLocations.id }).from(tripStartLocations).where(and(eq(tripStartLocations.organizationId, org), eq(tripStartLocations.active, true))).limit(1);
    const [row] = await tx
      .insert(tripStartLocations)
      .values({ organizationId: org, ...values, isDefault: input.isDefault || !any })
      .returning({ id: tripStartLocations.id });
    return row.id;
  });
  await audit({ organizationId: org, userId: auth.user.id, action: "trips.start_location.save", entity: "trip_start_location", entityId: id, meta: { geocoded: !!point } });
  return { id, geocoded: !!point };
}

export async function deactivateStartLocation(auth: AuthContext, id: string) {
  assertCan(auth, "settings.manage");
  const org = auth.organization.id;
  if (!isUuid(id)) throw new TripError("Startort nicht gefunden.");
  await withOrg(org, (tx) => tx.update(tripStartLocations).set({ active: false, isDefault: false, updatedAt: new Date() }).where(and(eq(tripStartLocations.organizationId, org), eq(tripStartLocations.id, id))));
  await audit({ organizationId: org, userId: auth.user.id, action: "trips.start_location.remove", entity: "trip_start_location", entityId: id });
}

/** Praxisadresse als Vorschlag für den ersten Startort */
export async function practiceAddress(org: string) {
  const [o] = await db.select({ street: organizations.street, zip: organizations.zip, city: organizations.city }).from(organizations).where(eq(organizations.id, org));
  return o ?? { street: null, zip: null, city: null };
}

const pointOf = (l: { lat: number | null; lon: number | null }): LatLon | null => (l.lat !== null && l.lon !== null ? { lat: l.lat, lon: l.lon } : null);

// ───────────────────────── Hausbesuche eines Tages ─────────────────────────
export type Visit = {
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  therapistId: string | null;
  patientId: string;
  patientNumber: number;
  patientName: string;
  insuranceType: string;
  address: string;
  label: string;
  point: LatLon | null;
  tripId: string | null;
};

async function loadVisits(auth: AuthContext, dateIso: string, opts: { mine?: boolean } = {}): Promise<Visit[]> {
  const org = auth.organization.id;
  const from = berlinToUtc(dateIso, "00:00");
  const to = new Date(from.getTime() + 26 * 3600_000);
  const rows = await withOrg(org, async (tx) => {
    const conds = [
      eq(appointments.organizationId, org),
      gte(appointments.startsAt, from),
      lt(appointments.startsAt, to),
      notInArray(appointments.status, ["cancelled", "no_show"]),
      or(eq(appointments.homeVisit, true), eq(patients.homeVisit, true)),
    ];
    if (opts.mine) conds.push(eq(appointments.therapistId, auth.user.id));
    const list = await tx
      .select({ a: appointments, p: patients })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(...conds))
      .orderBy(asc(appointments.startsAt));
    const ids = list.map((r) => r.a.id);
    const tripRows = ids.length
      ? await tx.select({ id: trips.id, appointmentId: trips.appointmentId }).from(trips).where(and(eq(trips.organizationId, org), inArray(trips.appointmentId, ids)))
      : [];
    const voided = tripRows.length
      ? await tx.select({ tripId: tripCorrections.tripId }).from(tripCorrections).where(and(eq(tripCorrections.organizationId, org), inArray(tripCorrections.tripId, tripRows.map((t) => t.id)), eq(tripCorrections.voided, true)))
      : [];
    const voidSet = new Set(voided.map((v) => v.tripId));
    const tripByAppt = new Map(tripRows.filter((t) => !voidSet.has(t.id)).map((t) => [t.appointmentId, t.id]));
    return list.map((r) => ({ ...r, tripId: tripByAppt.get(r.a.id) ?? null }));
  });
  // nur Tagesgrenze in Berlin (26 h-Fenster wegen Zeitumstellung)
  const day = rows.filter((r) => berlinDateIso(r.a.startsAt) === dateIso);
  const out: Visit[] = [];
  for (const r of day) {
    const address = addressLine(r.p);
    out.push({
      appointmentId: r.a.id,
      startsAt: r.a.startsAt,
      endsAt: r.a.endsAt,
      status: r.a.status,
      therapistId: r.a.therapistId,
      patientId: r.p.id,
      patientNumber: r.p.number,
      patientName: [r.p.firstName, r.p.lastName].filter(Boolean).join(" "),
      insuranceType: r.p.insuranceType,
      address,
      label: tripTargetLabel(r.p.number),
      point: address ? await geocodeAddress(org, address) : null,
      tripId: r.tripId,
    });
  }
  return out;
}

export type TourStart = { kind: "location"; id: string } | { kind: "last" };
export type TourStop = { kind: "start" | "visit" | "end"; label: string; address: string; point: LatLon | null; visit?: Visit; locationId?: string };
export type TourLeg = { from: TourStop; to: TourStop; leg: Leg | null };

export type DayTour = {
  date: string;
  visits: Visit[];
  stops: TourStop[];
  legs: TourLeg[];
  totals: { distanceM: number; durationSec: number; estimated: boolean; missing: number };
  warnings: string[];
  notes: string[];
  optimized: boolean;
  startLocations: StartLocation[];
  settings: TripSettings;
};

/**
 * Tagesroute: Start (Startort oder „vom letzten Patienten“) → Hausbesuche → optional Rückkehr.
 * optimize = Nearest-Neighbour + 2-opt auf Luftlinie (keine Daten nach außen); Terminzeiten nur als Warnung.
 */
export async function dayTour(auth: AuthContext, input: { date: string; start?: TourStart | null; returnTo?: string | null; optimize?: boolean; mine?: boolean }): Promise<DayTour> {
  assertCan(auth, "appointments.read");
  const org = auth.organization.id;
  const settings = await loadTripSettings(org);
  const locations = await listStartLocations(org);
  let visits = await loadVisits(auth, input.date, { mine: input.mine });
  const notes: string[] = [];

  const locStop = (l: StartLocation, kind: "start" | "end"): TourStop => ({ kind, label: l.name, address: addressLine(l), point: pointOf(l), locationId: l.id });
  const defaultLoc = locations.find((l) => l.isDefault) ?? locations[0];
  let start: TourStop | null = null;
  let remaining = visits;
  if (input.start?.kind === "last") {
    const visited = visits.filter((v) => v.status === "done" || v.tripId);
    const last = visited[visited.length - 1];
    if (last) {
      start = { kind: "start", label: `${last.label} (zuletzt)`, address: last.address, point: last.point, visit: last };
      remaining = visits.filter((v) => !visited.includes(v));
    } else notes.push("Noch kein Hausbesuch erledigt – Start am Standard-Startort.");
  }
  if (!start) {
    const wantedId = input.start?.kind === "location" ? input.start.id : null;
    const chosen = wantedId ? locations.find((l) => l.id === wantedId) : undefined;
    const loc = chosen ?? defaultLoc;
    if (loc) start = locStop(loc, "start");
    else notes.push("Kein Startort angelegt (Einstellungen → Fahrten & Startorte) – die Route beginnt beim ersten Hausbesuch.");
  }
  if (start && !start.point) notes.push(`Startort „${start.label}“ konnte nicht geokodiert werden.`);

  const retLoc = input.returnTo === "none" ? undefined : input.returnTo ? locations.find((l) => l.id === input.returnTo) : settings.returnToStart ? (start?.locationId ? locations.find((l) => l.id === start?.locationId) : defaultLoc) : undefined;
  const end: TourStop | null = retLoc ? locStop(retLoc, "end") : null;

  // Reihenfolge
  let ordered = remaining;
  if (input.optimize && remaining.length > 1) {
    const withPt = remaining.filter((v) => v.point);
    const without = remaining.filter((v) => !v.point);
    const nodes: (LatLon | null)[] = [start?.point ?? null, ...withPt.map((v) => v.point), end?.point ?? null];
    const endIdx = end?.point ? nodes.length - 1 : null;
    const dist = (i: number, j: number) => {
      const a = nodes[i];
      const b = nodes[j];
      return a && b ? haversineM(a, b) : 0;
    };
    ordered = [...optimizeOrder(withPt.length, dist, endIdx).map((i) => withPt[i]), ...without];
  }
  visits = ordered;
  const missing = visits.filter((v) => !v.point).length;
  if (missing) notes.push(`${missing} Adresse(n) nicht gefunden – bitte in der Patientenakte prüfen.`);

  const stops: TourStop[] = [...(start ? [start] : []), ...visits.map((v) => ({ kind: "visit" as const, label: v.label, address: v.address, point: v.point, visit: v })), ...(end ? [end] : [])];
  const legsRaw = await routeLegs(org, stops.map((s) => ({ point: s.point })));
  const legs: TourLeg[] = legsRaw.map((leg, i) => ({ from: stops[i], to: stops[i + 1], leg }));
  const known = legs.filter((l) => l.leg).map((l) => l.leg as Leg);
  const totals = {
    distanceM: known.reduce((s, l) => s + l.distanceM, 0),
    durationSec: known.reduce((s, l) => s + l.durationSec, 0),
    estimated: known.some((l) => l.estimated),
    missing: legs.length - known.length,
  };
  // Warnungen zu Terminzeiten (Etappe i führt zu Besuch i)
  const visitLegs = visits.map((v) => {
    const idx = stops.findIndex((s) => s.visit === v && s.kind === "visit");
    return idx > 0 ? (legsRaw[idx - 1]?.durationSec ?? null) : null;
  });
  const warnings = timeWarnings(
    visits.map((v) => ({ label: v.label, startsAt: v.startsAt, endsAt: v.endsAt })),
    visitLegs,
  );
  return { date: input.date, visits, stops, legs, totals, warnings, notes, optimized: !!input.optimize, startLocations: locations, settings };
}

// ───────────────────────── „Ich fahre los“ ─────────────────────────
async function loadAppointmentVisit(auth: AuthContext, appointmentId: string) {
  const org = auth.organization.id;
  if (!isUuid(appointmentId)) return null;
  const [r] = await withOrg(org, (tx) =>
    tx
      .select({ a: appointments, p: patients })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, appointmentId))),
  );
  return r ?? null;
}

/** Vorheriger Patient: letzte eigene (nicht stornierte) Fahrt heute, sonst der vorherige Hausbesuch am selben Tag. */
async function previousCustomer(auth: AuthContext, appt: typeof appointments.$inferSelect) {
  const org = auth.organization.id;
  const day = berlinDateIso(appt.startsAt);
  return withOrg(org, async (tx) => {
    const myTrips = await tx
      .select({ id: trips.id, appointmentId: trips.appointmentId })
      .from(trips)
      .where(and(eq(trips.organizationId, org), eq(trips.tripDate, day), eq(trips.driverId, auth.user.id), isNotNull(trips.appointmentId), ne(trips.appointmentId, appt.id)))
      .orderBy(desc(trips.startedAt))
      .limit(5);
    const voided = myTrips.length
      ? new Set((await tx.select({ tripId: tripCorrections.tripId }).from(tripCorrections).where(and(eq(tripCorrections.organizationId, org), inArray(tripCorrections.tripId, myTrips.map((t) => t.id)), eq(tripCorrections.voided, true)))).map((x) => x.tripId))
      : new Set<string>();
    let prevApptId = myTrips.find((t) => !voided.has(t.id))?.appointmentId ?? null;
    if (!prevApptId) {
      const from = berlinToUtc(day, "00:00");
      const conds = [
        eq(appointments.organizationId, org),
        gte(appointments.startsAt, from),
        lt(appointments.startsAt, appt.startsAt),
        notInArray(appointments.status, ["cancelled", "no_show"]),
        or(eq(appointments.homeVisit, true), eq(patients.homeVisit, true)),
        ne(appointments.id, appt.id),
      ];
      if (appt.therapistId) conds.push(eq(appointments.therapistId, appt.therapistId));
      const [prev] = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .innerJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(...conds))
        .orderBy(desc(appointments.startsAt))
        .limit(1);
      prevApptId = prev?.id ?? null;
    }
    if (!prevApptId) return null;
    const [p] = await tx
      .select({ number: patients.number, street: patients.street, zip: patients.zip, city: patients.city, startsAt: appointments.startsAt })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, prevApptId)));
    if (!p) return null;
    return { label: tripTargetLabel(p.number), address: addressLine(p), startsAt: p.startsAt };
  });
}

/** Daten für die Seite „Ich fahre los“ */
export async function departureOptions(auth: AuthContext, appointmentId: string) {
  assertCan(auth, "appointments.read");
  const r = await loadAppointmentVisit(auth, appointmentId);
  if (!r) return null;
  const org = auth.organization.id;
  const [locations, prev, existing, settings] = await Promise.all([listStartLocations(org), previousCustomer(auth, r.a), tripForAppointment(auth, appointmentId), loadTripSettings(org)]);
  await audit({ organizationId: org, userId: auth.user.id, action: "trips.departure.view", entity: "appointment", entityId: appointmentId });
  return {
    appointment: { id: r.a.id, startsAt: r.a.startsAt, endsAt: r.a.endsAt, status: r.a.status, homeVisit: r.a.homeVisit || r.p.homeVisit },
    patient: { id: r.p.id, number: r.p.number, name: [r.p.firstName, r.p.lastName].filter(Boolean).join(" "), address: addressLine(r.p) },
    label: tripTargetLabel(r.p.number),
    locations: locations.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault, geocoded: l.lat !== null && l.lon !== null })),
    previous: prev ? { label: prev.label, startsAt: prev.startsAt, hasAddress: !!prev.address } : null,
    existing,
    settings,
  };
}

export const startTripInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("here"), lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }),
  z.object({ kind: z.literal("location"), locationId: z.uuid() }),
  z.object({ kind: z.literal("last") }),
]);
export type StartTripInput = z.infer<typeof startTripInput> & { appointmentId: string; odometerStart?: number | null };

/**
 * Fahrt anlegen: Strecke über den Routing-Dienst (nur Koordinaten), sonst Schätzung.
 * Aktueller Standort: nur für diese eine Berechnung, auf 3 Nachkommastellen gerundet, nie gespeichert/gecacht.
 */
export async function startTrip(auth: AuthContext, input: StartTripInput) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  const r = await loadAppointmentVisit(auth, input.appointmentId);
  if (!r) throw new TripError("Termin nicht gefunden.");
  if (r.a.status === "cancelled") throw new TripError("Der Termin ist abgesagt.");
  const existing = await tripForAppointment(auth, input.appointmentId);
  if (existing && !existing.voided) throw new TripError("Für diesen Termin ist bereits eine Fahrt erfasst – ggf. im Fahrtenbuch stornieren.");
  const destAddress = addressLine(r.p);
  if (!destAddress) throw new TripError("In der Patientenakte fehlt die Adresse.");
  const dest = await geocodeAddress(org, destAddress);
  if (!dest) throw new TripError("Die Adresse der Patientin/des Patienten wurde nicht gefunden – bitte in der Akte prüfen oder km später manuell eintragen.");

  let from: LatLon | null = null;
  let fromLabel: string;
  let cacheable = true;
  if (input.kind === "here") {
    const p = roundPoint({ lat: input.lat, lon: input.lon }, 3);
    if (!isValidPoint(p)) throw new TripError("Standort ungültig.");
    from = p;
    fromLabel = "Aktueller Standort";
    cacheable = false;
  } else if (input.kind === "location") {
    const [l] = await withOrg(org, (tx) => tx.select().from(tripStartLocations).where(and(eq(tripStartLocations.organizationId, org), eq(tripStartLocations.id, input.locationId), eq(tripStartLocations.active, true))));
    if (!l) throw new TripError("Startort nicht gefunden.");
    from = pointOf(l);
    if (!from) throw new TripError(`Startort „${l.name}“ hat keine Koordinaten – bitte Adresse in den Einstellungen prüfen.`);
    fromLabel = cleanLabel(l.name);
  } else {
    const prev = await previousCustomer(auth, r.a);
    if (!prev) throw new TripError("Kein vorheriger Hausbesuch heute gefunden.");
    from = prev.address ? await geocodeAddress(org, prev.address) : null;
    if (!from) throw new TripError("Adresse des letzten Patienten nicht gefunden.");
    fromLabel = prev.label;
  }

  const [leg] = await routeLegs(org, [{ point: from, cacheable }, { point: dest }]);
  if (!leg) throw new TripError("Strecke konnte nicht berechnet werden.");
  const settings = await loadTripSettings(org);
  const odo = input.odometerStart ?? null;
  const [row] = await withOrg(org, (tx) =>
    tx
      .insert(trips)
      .values({
        organizationId: org,
        driverId: auth.user.id,
        tripDate: berlinDateIso(),
        fromLabel,
        toLabel: tripTargetLabel(r.p.number),
        purpose: "Hausbesuch",
        distanceM: leg.distanceM,
        durationSec: leg.durationSec,
        distanceSource: leg.estimated ? "estimate" : "route",
        provider: leg.provider,
        appointmentId: r.a.id,
        vehicleLabel: settings.vehicleLabel,
        plate: settings.plate,
        odometerStart: odo,
        createdBy: auth.user.id,
      })
      .returning(),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "trip.start", entity: "trip", entityId: row.id, meta: { appointmentId: r.a.id, start: input.kind, distanceM: leg.distanceM, estimated: leg.estimated } });
  return { id: row.id, distanceM: leg.distanceM, durationSec: leg.durationSec, estimated: leg.estimated, destination: destAddress };
}

// ───────────────────────── Fahrtenbuch ─────────────────────────
async function effectiveTrips(org: string, where: ReturnType<typeof and>): Promise<EffectiveTrip[]> {
  return withOrg(org, async (tx) => {
    const rows = await tx.select().from(trips).where(where).orderBy(asc(trips.tripDate), asc(trips.startedAt));
    if (!rows.length) return [];
    const corr = await tx
      .select()
      .from(tripCorrections)
      .where(and(eq(tripCorrections.organizationId, org), inArray(tripCorrections.tripId, rows.map((t) => t.id))));
    return rows.map((t) => applyCorrections(t as TripRow, corr as CorrectionRow[]));
  });
}

export async function tripForAppointment(auth: AuthContext, appointmentId: string): Promise<EffectiveTrip | null> {
  const org = auth.organization.id;
  if (!isUuid(appointmentId)) return null;
  const list = await effectiveTrips(org, and(eq(trips.organizationId, org), eq(trips.appointmentId, appointmentId)));
  return list.filter((t) => !t.voided).pop() ?? list.pop() ?? null;
}

export const canReadTripLog = (auth: AuthContext) => auth.can("appointments.read") || auth.can("finance.read");

function monthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TripError("Monat ungültig.");
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

export async function listTripsMonth(auth: AuthContext, month: string) {
  if (!canReadTripLog(auth)) throw new TripError("Kein Zugriff.");
  const org = auth.organization.id;
  const { from, to } = monthRange(month);
  const list = await effectiveTrips(org, and(eq(trips.organizationId, org), gte(trips.tripDate, from), lt(trips.tripDate, to)));
  return { trips: list, totals: monthTotals(list) };
}

export async function getTrip(auth: AuthContext, id: string) {
  if (!canReadTripLog(auth)) throw new TripError("Kein Zugriff.");
  const org = auth.organization.id;
  if (!isUuid(id)) return null;
  const [t] = await effectiveTrips(org, and(eq(trips.organizationId, org), eq(trips.id, id)));
  if (!t) return null;
  const ids = [...new Set([t.driverId, ...t.corrections.map((c) => c.createdBy)].filter((x): x is string => !!x))];
  const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  return { trip: t, userNames: Object.fromEntries(names.map((n) => [n.id, n.name])) as Record<string, string> };
}

export const correctionInput = z.object({
  tripId: z.uuid(),
  kind: z.enum(["arrival", "correction", "void"]),
  km: z.number().min(0).max(2000).nullable().optional(),
  purpose: z.string().trim().max(80).nullable().optional(),
  odometerStart: z.number().int().min(0).max(9_999_999).nullable().optional(),
  odometerEnd: z.number().int().min(0).max(9_999_999).nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

/** Nachtrag (Ankunft, Korrektur, Storno) – append-only, mit Person und Zeitpunkt. */
export async function addTripCorrection(auth: AuthContext, input: z.infer<typeof correctionInput>) {
  assertCan(auth, "appointments.write");
  const org = auth.organization.id;
  if ((input.kind === "correction" || input.kind === "void") && !input.reason) throw new TripError("Bitte einen Grund für die Korrektur angeben.");
  const current = await getTrip(auth, input.tripId);
  if (!current) throw new TripError("Fahrt nicht gefunden.");
  if (current.trip.voided) throw new TripError("Die Fahrt ist storniert.");
  if (input.kind === "arrival" && current.trip.arrivedAt) throw new TripError("Ankunft ist bereits erfasst – Änderungen bitte als Korrektur im Fahrtenbuch.");
  const odoStart = input.odometerStart ?? current.trip.odometerStart;
  if (odoStart !== null && input.odometerEnd !== null && input.odometerEnd !== undefined && input.odometerEnd < odoStart) throw new TripError("Kilometerstand Ende liegt unter dem Beginn.");
  const [row] = await withOrg(org, (tx) =>
    tx
      .insert(tripCorrections)
      .values({
        organizationId: org,
        tripId: input.tripId,
        kind: input.kind,
        distanceM: input.km !== null && input.km !== undefined ? Math.round(input.km * 1000) : null,
        purpose: input.purpose ? cleanLabel(input.purpose, 80) : null,
        odometerStart: input.odometerStart ?? null,
        odometerEnd: input.odometerEnd ?? null,
        arrivedAt: input.kind === "arrival" ? new Date() : null,
        voided: input.kind === "void",
        reason: input.reason ?? null,
        createdBy: auth.user.id,
      })
      .returning({ id: tripCorrections.id }),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: `trip.${input.kind}`, entity: "trip", entityId: input.tripId, meta: { correctionId: row.id, km: input.km ?? null } });
  return row.id;
}

// ───────────────────────── Wegegeld auf der Rechnung ─────────────────────────
export type TravelSuggestion = { tripId: string; date: string; distanceM: number; km: number; description: string; maybeBilled: boolean };

/**
 * Vorschläge für „Wegegeld hinzufügen“ im Rechnungsformular (vor dem Ausstellen = Entwurf, GoBD):
 * nur Privat/Selbstzahler; Fahrten der letzten 120 Tage zu Terminen dieser Person.
 */
export async function travelSuggestions(auth: AuthContext, patientId: string | null) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!patientId || !isUuid(patientId)) return null;
  const settings = await loadTripSettings(org);
  return withOrg(org, async (tx) => {
    const [p] = await tx.select({ id: patients.id, insuranceType: patients.insuranceType }).from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, patientId)));
    if (!p) return null;
    const flat = await tx
      .select({ id: services.id, name: services.name, priceCents: services.priceCents })
      .from(services)
      .where(and(eq(services.organizationId, org), eq(services.active, true), or(eq(services.category, "travel"), eq(services.code, "HB"))))
      .orderBy(asc(services.name));
    const base = { patientId: p.id, eligible: isPrivatePayer(p.insuranceType), rateCents: settings.rateCents, billing: settings.billing, flatServices: flat };
    if (!base.eligible) return { ...base, suggestions: [] as TravelSuggestion[] };
    const since = berlinDateIso(new Date(Date.now() - 120 * 86400_000));
    const appts = await tx.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.organizationId, org), eq(appointments.patientId, p.id), gte(appointments.startsAt, berlinToUtc(since, "00:00"))));
    if (!appts.length) return { ...base, suggestions: [] as TravelSuggestion[] };
    const rows = await tx.select().from(trips).where(and(eq(trips.organizationId, org), inArray(trips.appointmentId, appts.map((a) => a.id)))).orderBy(desc(trips.tripDate));
    const corr = rows.length ? await tx.select().from(tripCorrections).where(and(eq(tripCorrections.organizationId, org), inArray(tripCorrections.tripId, rows.map((r) => r.id)))) : [];
    const billedLines = await tx
      .select({ description: invoiceLines.description })
      .from(invoiceLines)
      .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
      .where(and(eq(invoiceLines.organizationId, org), eq(invoices.patientId, p.id), ne(invoices.status, "cancelled")));
    const billedText = billedLines.map((l) => l.description).join("\n");
    const suggestions: TravelSuggestion[] = rows
      .map((t) => applyCorrections(t as TripRow, corr as CorrectionRow[]))
      .filter((t) => !t.voided)
      .slice(0, 10)
      .map((t) => {
        const description = travelLineDescription(t.tripDate, t.distanceM, settings.billing);
        const dateDe = `${t.tripDate.slice(8, 10)}.${t.tripDate.slice(5, 7)}.${t.tripDate.slice(0, 4)}`;
        return { tripId: t.id, date: t.tripDate, distanceM: t.distanceM, km: travelKm(t.distanceM, settings.billing), description, maybeBilled: billedText.includes(`Wegegeld Hausbesuch am ${dateDe}`) };
      });
    return { ...base, suggestions };
  });
}

/** Für den Export: Kopfangaben */
export async function tripLogHeader(org: string) {
  const [o] = await db.select({ name: organizations.name, legalName: organizations.legalName, settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const s = tripSettings(o?.settings);
  return { practice: o?.legalName ?? o?.name ?? "", vehicle: s.vehicleLabel, plate: s.plate };
}
