import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ current: null as null | { user: { id: string }; organization: { id: string } } }));
vi.mock("@/lib/auth/session", () => ({ getAuth: async () => auth.current }));
// DB-Zugriff für die Ortsgewichtung: Praxis ohne Adresse → keine Gewichtung
vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ street: null, zip: null, city: null, settings: {} }] }) }), update: vi.fn() },
}));

import { GET } from "@/app/api/adresse/vorschlaege/route";
import { addressLimiter, clearAddressCache, setAddressFetch, suggestAddresses, TIMEOUT_MS } from "./address-suggest";

const PHOTON = {
  features: [{ properties: { type: "house", street: "Friedrich-Herder-Straße", housenumber: "12", postcode: "14467", city: "Potsdam", countrycode: "DE" } }],
};
const call = (qs: string) => GET(new NextRequest(new URL(`https://praxis.example/api/adresse/vorschlaege${qs}`), { headers: { "x-forwarded-for": "203.0.113.9", cookie: "x=y" } }));

let calls: { url: string; init?: RequestInit }[] = [];
beforeEach(() => {
  calls = [];
  clearAddressCache();
  addressLimiter.reset();
  auth.current = { user: { id: "u1" }, organization: { id: "o1" } };
  setAddressFetch(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(PHOTON), { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  setAddressFetch(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/adresse/vorschlaege", () => {
  it("ohne Anmeldung: 401, kein Aufruf beim Geocoder", async () => {
    auth.current = null;
    const res = await call("?q=Friedrich-Herder-Str.");
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("liefert normalisierte Vorschläge; nur Adresstext + fester User-Agent gehen raus", async () => {
    const res = await call("?q=Friedrich-Herder-Str.%2012");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [{ street: "Friedrich-Herder-Straße", houseNumber: "12", zip: "14467", city: "Potsdam", label: "Friedrich-Herder-Straße 12, 14467 Potsdam" }] });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.host).toBe("photon.komoot.io");
    expect(u.searchParams.get("q")).toBe("Friedrich-Herder-Straße 12");
    expect(u.searchParams.get("bbox")).toBe("5.87,47.27,15.04,55.06");
    const h = new Headers(calls[0].init?.headers);
    expect(h.get("user-agent")).toBe("PodoHero/1.0 (+https://podo.algoverdict.com)");
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect([...h.keys()].sort()).toEqual(["accept", "user-agent"]);
  });

  it("prüft die Anfrage (min. 3, max. 120 Zeichen)", async () => {
    expect((await call("?q=ab")).status).toBe(400);
    expect((await call("")).status).toBe(400);
    expect((await call(`?q=${"a".repeat(121)}`)).status).toBe(400);
    expect((await call("?plz=1234")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("gleiche Anfragen kommen 10 min aus dem Cache", async () => {
    await call("?q=Hauptstr. 5");
    await call("?q=Hauptstr. 5");
    expect(calls).toHaveLength(1);
  });

  it("Rate-Limit: 60 Anfragen je Benutzer:in und Minute", async () => {
    for (let i = 0; i < 60; i++) expect((await call(`?q=Weg ${i}`)).status).toBe(200);
    const res = await call("?q=Weg x");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    auth.current = { user: { id: "u2" }, organization: { id: "o1" } };
    expect((await call("?q=Weg x")).status).toBe(200);
  });

  it("PLZ-Suche liefert Orte", async () => {
    setAddressFetch(async (url) => {
      calls.push({ url });
      return Response.json({ features: [{ properties: { type: "city", name: "Potsdam", postcode: "14467", countrycode: "DE" } }] });
    });
    const res = await call("?plz=14467");
    expect(await res.json()).toEqual({ cities: ["Potsdam"] });
  });

  it("ADDRESS_PROVIDER=off: keine Vorschläge, kein Aufruf", async () => {
    vi.stubEnv("ADDRESS_PROVIDER", "off");
    const res = await call("?q=Hauptstraße");
    expect(await res.json()).toMatchObject({ disabled: true, suggestions: [] });
    expect(calls).toHaveLength(0);
  });

  it("PHOTON_URL: eigene Instanz", async () => {
    vi.stubEnv("PHOTON_URL", "https://photon.praxis.example");
    await call("?q=Hauptstraße");
    expect(new URL(calls[0].url).host).toBe("photon.praxis.example");
  });

  it("Dienst nicht erreichbar/Fehlerstatus: leere Liste statt Fehler", async () => {
    setAddressFetch(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await (await call("?q=Hauptstraße")).json()).toEqual({ suggestions: [] });
    setAddressFetch(async () => new Response("boom", { status: 502 }));
    expect(await (await call("?q=Nebenstraße")).json()).toEqual({ suggestions: [] });
  });
});

describe("suggestAddresses", () => {
  it("bricht nach 3 s ab", async () => {
    vi.useFakeTimers();
    setAddressFetch((_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const p = suggestAddresses("Hauptstraße", null);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 10);
    expect(await p).toEqual([]);
  });

  it("standardmäßig über net-guard (keine privaten Ziele)", async () => {
    setAddressFetch(null);
    vi.stubEnv("PHOTON_URL", "http://127.0.0.1:2322");
    expect(await suggestAddresses("Hauptstraße", null)).toEqual([]);
  });
});
