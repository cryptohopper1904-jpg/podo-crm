/**
 * Routing: Konfiguration (Produktion nur mit eigenem Dienst), nur Koordinaten an den Dienst,
 * Rückfall auf Luftlinie × 1,3 („geschätzt“) – ohne Netz und ohne Datenbank.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DETOUR_FACTOR, estimateLeg, haversineM, normalizeAddress, roundPoint } from "./geo";
import { fetchRouteLegs, OSRM_DEMO_URL, photonGeocode, routingConfig, USER_AGENT } from "./provider";

const POTSDAM = { lat: 52.3906, lon: 13.0645 };
const BERLIN = { lat: 52.5200, lon: 13.4050 };

describe("Entfernung (Rückfall)", () => {
  it("Luftlinie Potsdam–Berlin ≈ 27 km, Schätzung × 1,3 und als geschätzt markiert", () => {
    const d = haversineM(POTSDAM, BERLIN);
    expect(d).toBeGreaterThan(26_000);
    expect(d).toBeLessThan(28_500);
    const leg = estimateLeg(POTSDAM, BERLIN);
    expect(leg.estimated).toBe(true);
    expect(leg.provider).toBe("estimate");
    expect(leg.distanceM).toBe(Math.round(d * DETOUR_FACTOR));
    expect(leg.durationSec).toBeGreaterThan(40 * 60);
  });

  it("Standort wird auf 3 Nachkommastellen gerundet", () => {
    expect(roundPoint({ lat: 52.390612, lon: 13.064549 })).toEqual({ lat: 52.391, lon: 13.065 });
  });

  it("Adress-Normalisierung für den Cache", () => {
    expect(normalizeAddress("Hauptstraße 1, 14467 Potsdam")).toBe(normalizeAddress("hauptstr. 1  14467 potsdam"));
  });
});

describe("Routing-Konfiguration", () => {
  it("Entwicklung: öffentlicher OSRM-Demo-Server, Produktion: nur mit eigener URL oder ORS-Schlüssel", () => {
    expect(routingConfig({ NODE_ENV: "development" })).toMatchObject({ provider: "osrm", baseUrl: OSRM_DEMO_URL, demo: true });
    expect(routingConfig({ NODE_ENV: "production" })).toMatchObject({ provider: "off" });
    expect(routingConfig({ NODE_ENV: "production", OSRM_URL: "https://osrm.example.org/" })).toMatchObject({ provider: "osrm", baseUrl: "https://osrm.example.org", demo: false });
    expect(routingConfig({ NODE_ENV: "production", ORS_API_KEY: "k" })).toMatchObject({ provider: "ors", demo: false });
    expect(routingConfig({ NODE_ENV: "production", ROUTING_PROVIDER: "ors" })).toMatchObject({ provider: "off" });
    expect(routingConfig({ ROUTING_PROVIDER: "off", OSRM_URL: "https://x.example" })).toMatchObject({ provider: "off" });
  });

  it("OSRM: sendet nur Koordinaten, liest die Etappen", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: "Ok", routes: [{ legs: [{ distance: 31_234.6, duration: 1980.2 }, { distance: 900, duration: 120 }] }] }), { status: 200 });
    };
    const cfg = routingConfig({ OSRM_URL: "https://osrm.example.org" });
    const legs = await fetchRouteLegs(cfg, [POTSDAM, BERLIN, POTSDAM], fetchImpl);
    expect(legs).toEqual([
      { distanceM: 31_235, durationSec: 1980, estimated: false, provider: "osrm" },
      { distanceM: 900, durationSec: 120, estimated: false, provider: "osrm" },
    ]);
    expect(calls[0].url).toBe("https://osrm.example.org/route/v1/driving/13.0645,52.3906;13.405,52.52;13.0645,52.3906?overview=false&steps=false");
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("ORS: Schlüssel im Header, im Body nur Koordinaten", async () => {
    let body = "";
    let auth = "";
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ routes: [{ segments: [{ distance: 5000, duration: 400 }] }] }), { status: 200 });
    };
    const legs = await fetchRouteLegs(routingConfig({ ROUTING_PROVIDER: "ors", ORS_API_KEY: "geheim" }), [POTSDAM, BERLIN], fetchImpl);
    expect(legs[0]).toMatchObject({ distanceM: 5000, provider: "ors" });
    expect(auth).toBe("geheim");
    expect(JSON.parse(body)).toEqual({ coordinates: [[13.0645, 52.3906], [13.405, 52.52]], instructions: false });
  });

  it("Photon-Geokodierung: nur die Adresse wird gesendet", async () => {
    let url = "";
    const p = await photonGeocode("Hauptstraße 1, 14467 Potsdam", {
      baseUrl: "https://photon.example.org",
      fetchImpl: async (u) => {
        url = u;
        return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [13.06, 52.4] } }] }), { status: 200 });
      },
    });
    expect(p).toEqual({ lat: 52.4, lon: 13.06 });
    expect(url).toBe("https://photon.example.org/api/?q=Hauptstra%C3%9Fe%201%2C%2014467%20Potsdam&limit=1&lang=de");
  });
});

describe("routeLegs: Rückfall auf Schätzung", () => {
  it("Routing abgeschaltet → Luftlinie × 1,3; Lücke ohne Koordinaten → null", async () => {
    const { routeLegs } = await import("@/server/routing");
    const legs = await routeLegs("00000000-0000-4000-8000-000000000000", [{ point: POTSDAM }, { point: BERLIN }, { point: null }, { point: POTSDAM }], {
      config: { provider: "off", reason: "Test" },
    });
    expect(legs[0]).toEqual(estimateLeg(POTSDAM, BERLIN));
    expect(legs[1]).toBeNull();
    expect(legs[2]).toBeNull();
  });

  it("Dienst nicht erreichbar → Schätzung (aktueller Standort wird nicht gecacht)", async () => {
    const { routeLegs } = await import("@/server/routing");
    const legs = await routeLegs("00000000-0000-4000-8000-000000000000", [{ point: POTSDAM, cacheable: false }, { point: BERLIN, cacheable: false }], {
      config: { provider: "osrm", baseUrl: "https://osrm.example.org", demo: false, minIntervalMs: 0 },
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    expect(legs[0]?.estimated).toBe(true);
  });
});
