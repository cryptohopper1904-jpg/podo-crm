/**
 * Fahrten & Touren gegen PostgreSQL (App-Rolle, RLS aktiv):
 *  - neue Tabellen sind mandantengetrennt (RLS + FORCE), ohne Mandant unsichtbar
 *  - Fahrtenbuch ist append-only (Trigger), Korrekturen nur zur eigenen Praxis
 *  - „Ich fahre los“: Ziel pseudonymisiert, Schätzung ohne Routing-Dienst, Nachtrag „Angekommen“
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { addressLine, normalizeAddress } from "@/lib/routing/geo";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Fahrten & Touren (DB)", () => {
  const f = fixtures(TEST_DB!);
  let trips: typeof import("./trips");
  let orgA: string, orgB: string, user: string;
  const auth = (org: string) => ({ role: "owner", support: null, organization: { id: org }, user: { id: user, name: "Test" }, can: () => true }) as unknown as AuthContext;
  const addrHash = (a: { street: string; zip: string; city: string }) => createHash("sha256").update(`v1|${normalizeAddress(addressLine(a))}`).digest("hex");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.ROUTING_PROVIDER = "off";
    trips = await import("./trips");
    orgA = await f.org();
    orgB = await f.org();
    user = await f.user();
  });
  afterAll(async () => {
    delete process.env.ROUTING_PROVIDER;
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("RLS: neue Tabellen sind mandantengetrennt", async () => {
    const tripId = await f.asOrg(orgA, async (c) => {
      await c.query("insert into trip_start_locations (organization_id, name, lat, lon) values ($1, 'Praxis', 52.4, 13.06)", [orgA]);
      await c.query("insert into route_cache (organization_id, key_hash, provider, distance_m, duration_sec) values ($1, 'k', 'osrm', 1000, 60)", [orgA]);
      await c.query("insert into geocode_cache (organization_id, address_hash, lat, lon) values ($1, 'h', 52.4, 13.06)", [orgA]);
      return (await c.query("insert into trips (organization_id, trip_date, from_label, to_label, distance_m, distance_source) values ($1, current_date, 'Praxis', 'Hausbesuch K-1', 1000, 'route') returning id", [orgA])).rows[0].id as string;
    });
    for (const t of ["trip_start_locations", "trips", "route_cache", "geocode_cache"]) {
      const a = await f.asOrg(orgA, async (c) => (await c.query(`select 1 from ${t} where organization_id = $1`, [orgA])).rowCount);
      const b = await f.asOrg(orgB, async (c) => (await c.query(`select 1 from ${t} where organization_id = $1`, [orgA])).rowCount);
      const none = (await f.pool.query(`select 1 from ${t} where organization_id = $1`, [orgA])).rowCount;
      expect([t, a]).toEqual([t, 1]);
      expect([t, b]).toEqual([t, 0]);
      expect([t, none]).toEqual([t, 0]);
    }
    await expect(f.asOrg(orgB, (c) => c.query("insert into trips (organization_id, trip_date, from_label, to_label, distance_m, distance_source) values ($1, current_date, 'X', 'Y', 1, 'route')", [orgA]))).rejects.toThrow();
    // Korrektur aus fremder Praxis zu dieser Fahrt
    await expect(f.asOrg(orgB, (c) => c.query("insert into trip_corrections (organization_id, trip_id, kind, created_by) values ($1, $2, 'correction', $3)", [orgB, tripId, user]))).rejects.toThrow(/Praxis/);
  });

  it("Fahrtenbuch ist append-only", async () => {
    const tripId = await f.asOrg(orgA, async (c) => (await c.query("insert into trips (organization_id, trip_date, from_label, to_label, distance_m, distance_source) values ($1, current_date, 'Praxis', 'Hausbesuch K-2', 5000, 'route') returning id", [orgA])).rows[0].id as string);
    await expect(f.asOrg(orgA, (c) => c.query("update trips set distance_m = 1 where id = $1", [tripId]))).rejects.toThrow(/unveränderbar/);
    await expect(f.asOrg(orgA, (c) => c.query("delete from trips where id = $1", [tripId]))).rejects.toThrow(/unveränderbar/);
    const corrId = await f.asOrg(orgA, async (c) => (await c.query("insert into trip_corrections (organization_id, trip_id, kind, distance_m, reason, created_by) values ($1, $2, 'correction', 5200, 'Umleitung', $3) returning id", [orgA, tripId, user])).rows[0].id as string);
    await expect(f.asOrg(orgA, (c) => c.query("update trip_corrections set distance_m = 1 where id = $1", [corrId]))).rejects.toThrow(/unveränderbar/);
    await expect(f.asOrg(orgA, (c) => c.query("delete from trip_corrections where id = $1", [corrId]))).rejects.toThrow(/unveränderbar/);
  });

  it("„Ich fahre los“: pseudonymisiertes Ziel, Schätzung, Ankunft mit km-Korrektur", async () => {
    const org = await f.org({ settings: { trips: { plate: "P-AB 123", rateCents: 30 } } });
    const patientAddr = { street: "Brandenburger Straße 10", zip: "14467", city: "Potsdam" };
    const patientId = await f.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    const number = await f.asOrg(org, async (c) => {
      await c.query("update patients set street=$2, zip=$3, city=$4, home_visit=true where id=$1", [patientId, patientAddr.street, patientAddr.zip, patientAddr.city]);
      await c.query("insert into geocode_cache (organization_id, address_hash, lat, lon) values ($1, $2, 52.4009, 13.0567)", [org, addrHash(patientAddr)]);
      return (await c.query("select number from patients where id=$1", [patientId])).rows[0].number as number;
    });
    const loc = await f.asOrg(org, async (c) => (await c.query("insert into trip_start_locations (organization_id, name, lat, lon, is_default) values ($1, 'Praxis', 52.3906, 13.0645, true) returning id", [org])).rows[0].id as string);
    const start = new Date(Date.now() + 3600_000);
    const appt = await f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, home_visit) values ($1,$2,$3,$4,true) returning id", [org, patientId, start, new Date(start.getTime() + 45 * 60_000)])).rows[0].id as string);

    const r = await trips.startTrip(auth(org), { kind: "location", locationId: loc, appointmentId: appt, odometerStart: 48210 });
    expect(r.estimated).toBe(true);
    expect(r.distanceM).toBeGreaterThan(1000);
    const row = (await f.asOrg(org, (c) => c.query("select * from trips where id = $1", [r.id]))).rows[0];
    expect(row.to_label).toBe(`Hausbesuch K-${number}`);
    expect(row.from_label).toBe("Praxis");
    expect(row.purpose).toBe("Hausbesuch");
    expect(row.distance_source).toBe("estimate");
    expect(row.plate).toBe("P-AB 123");
    expect(JSON.stringify(row)).not.toMatch(/Musterfrau|Erika|Brandenburger/);
    // Kein Routing-Ergebnis ohne Dienst im Cache
    expect((await f.asOrg(org, (c) => c.query("select 1 from route_cache where organization_id = $1", [org]))).rowCount).toBe(0);

    await expect(trips.startTrip(auth(org), { kind: "location", locationId: loc, appointmentId: appt })).rejects.toThrow(/bereits eine Fahrt/);

    await trips.addTripCorrection(auth(org), { tripId: r.id, kind: "arrival", km: 3.4, odometerEnd: 48214 });
    await expect(trips.addTripCorrection(auth(org), { tripId: r.id, kind: "correction", km: 3 })).rejects.toThrow(/Grund/);
    const month = berlinDateIso().slice(0, 7);
    const list = await trips.listTripsMonth(auth(org), month);
    const t = list.trips.find((x) => x.id === r.id)!;
    expect(t.distanceM).toBe(3400);
    expect(t.originalDistanceM).toBe(r.distanceM);
    expect(t.odometerEnd).toBe(48214);
    expect(t.arrivedAt).toBeInstanceOf(Date);

    // Wegegeld-Vorschlag (Selbstzahler)
    const travel = await trips.travelSuggestions(auth(org), patientId);
    expect(travel?.eligible).toBe(true);
    expect(travel?.suggestions[0]).toMatchObject({ tripId: r.id, km: 3.4 });

    // Storno: bleibt sichtbar, zählt nicht
    await trips.addTripCorrection(auth(org), { tripId: r.id, kind: "void", reason: "Doppelt erfasst" });
    const after = await trips.listTripsMonth(auth(org), month);
    expect(after.trips.find((x) => x.id === r.id)?.voided).toBe(true);
    expect(after.totals.count).toBe(0);
  });

  it("aktueller Standort wird nicht gespeichert und Tour ohne Startort funktioniert", async () => {
    const org = await f.org();
    const patientAddr = { street: "Lindenstraße 5", zip: "14467", city: "Potsdam" };
    const patientId = await f.patient(org, { lastName: "Beispiel" });
    await f.asOrg(org, async (c) => {
      await c.query("update patients set street=$2, zip=$3, city=$4 where id=$1", [patientId, patientAddr.street, patientAddr.zip, patientAddr.city]);
      await c.query("insert into geocode_cache (organization_id, address_hash, lat, lon) values ($1, $2, 52.399, 13.051)", [org, addrHash(patientAddr)]);
    });
    const start = new Date(Date.now() + 2 * 3600_000);
    const appt = await f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, home_visit) values ($1,$2,$3,$4,true) returning id", [org, patientId, start, new Date(start.getTime() + 30 * 60_000)])).rows[0].id as string);
    const r = await trips.startTrip(auth(org), { kind: "here", lat: 52.41234567, lon: 13.07654321, appointmentId: appt });
    const row = (await f.asOrg(org, (c) => c.query("select * from trips where id = $1", [r.id]))).rows[0];
    expect(row.from_label).toBe("Aktueller Standort");
    expect(JSON.stringify(row)).not.toMatch(/52\.41|13\.07/);
    expect((await f.asOrg(org, (c) => c.query("select 1 from route_cache where organization_id = $1", [org]))).rowCount).toBe(0);

    const tour = await trips.dayTour(auth(org), { date: berlinDateIso(start) });
    expect(tour.visits.map((v) => v.appointmentId)).toContain(appt);
    expect(tour.notes.join(" ")).toMatch(/Kein Startort/);
  });
});
