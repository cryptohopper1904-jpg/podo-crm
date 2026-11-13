import { describe, expect, it } from "vitest";
import { OverpassError, PAGE_MAX_BYTES, PoliteFetcher, queryOverpass } from "./web";

const publicIp = async () => [{ address: "93.184.216.34" }];

describe("PoliteFetcher (ohne echtes Netz)", () => {
  it("1 Anfrage/Sekunde, keine Cookies, eigener User-Agent", async () => {
    let t = 0;
    const waits: number[] = [];
    const inits: RequestInit[] = [];
    const f = new PoliteFetcher({
      fetchImpl: async (_u, i) => (inits.push(i ?? {}), new Response("ok", { headers: { "content-type": "text/html" } })),
      resolver: publicIp,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await f.get("https://a.example/");
    t += 200;
    await f.get("https://a.example/x");
    expect(waits).toEqual([800]);
    expect(inits[0]).toMatchObject({ credentials: "omit", redirect: "manual" });
    expect((inits[0].headers as Record<string, string>)["User-Agent"]).toMatch(/^PodoHero-Praxissuche/);
    expect(JSON.stringify(inits[0].headers)).not.toMatch(/cookie/i);
  });

  it("private Ziele und Weiterleitungen dorthin werden nicht abgerufen", async () => {
    const calls: string[] = [];
    const f = new PoliteFetcher({
      fetchImpl: async (u) => (calls.push(u), new Response(null, { status: 301, headers: { location: "http://intern.example/" } })),
      resolver: async (h) => [{ address: h === "intern.example" ? "10.0.0.1" : "93.184.216.34" }],
      sleep: async () => {},
    });
    expect(await f.get("https://a.example/")).toBeNull();
    expect(calls).toEqual(["https://a.example/"]);
    expect(await f.get("https://127.0.0.1/")).toBeNull();
  });

  it("Weiterleitung auf anderen Host: auch dessen robots.txt gilt", async () => {
    const calls: string[] = [];
    const f = new PoliteFetcher({
      fetchImpl: async (u) => {
        calls.push(u);
        if (u === "https://a.example/") return new Response(null, { status: 301, headers: { location: "https://b.example/" } });
        if (u === "https://b.example/robots.txt") return new Response("User-agent: *\nDisallow: /", { headers: { "content-type": "text/plain" } });
        return new Response("ok", { headers: { "content-type": "text/html" } });
      },
      resolver: publicIp,
      sleep: async () => {},
    });
    expect(await f.get("https://a.example/")).toBeNull();
    expect(calls).toEqual(["https://a.example/", "https://b.example/robots.txt"]);
  });

  it("Weiterleitung auf demselben Host zu verbotenem Pfad wird nicht abgerufen; überlange Pfade gelten als verboten", async () => {
    const calls: string[] = [];
    const f = new PoliteFetcher({
      fetchImpl: async (u) => {
        calls.push(u);
        if (u === "https://a.example/") return new Response(null, { status: 302, headers: { location: "/privat/" } });
        if (u === "https://a.example/robots.txt") return new Response("User-agent: *\nDisallow: /privat/", { headers: { "content-type": "text/plain" } });
        return new Response("ok", { headers: { "content-type": "text/html" } });
      },
      resolver: publicIp,
      sleep: async () => {},
    });
    expect(await f.get("https://a.example/")).toBeNull();
    expect(calls).toEqual(["https://a.example/", "https://a.example/robots.txt"]);
    expect(await f.allowed("https://a.example/" + "x".repeat(3000))).toBe(false);
  });

  it("liest höchstens 200 KB", async () => {
    const f = new PoliteFetcher({ fetchImpl: async () => new Response("x".repeat(PAGE_MAX_BYTES * 3), { headers: { "content-type": "text/html" } }), resolver: publicIp, sleep: async () => {} });
    expect((await f.get("https://a.example/"))!.body.length).toBe(PAGE_MAX_BYTES);
  });

  it("robots.txt: 404 → erlaubt, 5xx/nicht erreichbar → nicht erlaubt", async () => {
    const mk = (status: number) => new PoliteFetcher({ fetchImpl: async () => new Response("", { status }), resolver: publicIp, sleep: async () => {} });
    expect(await mk(404).allowed("https://a.example/")).toBe(true);
    expect(await mk(500).allowed("https://a.example/")).toBe(false);
  });
});

describe("queryOverpass", () => {
  it("POST mit Abfrage, Fehler werden zu OverpassError", async () => {
    let body = "";
    const ok = await queryOverpass("[out:json];", { fetchImpl: async (_u, i) => ((body = String(i?.body)), new Response('{"elements":[]}')) });
    expect(ok).toEqual({ elements: [] });
    expect(body).toBe("data=%5Bout%3Ajson%5D%3B");
    await expect(queryOverpass("x", { fetchImpl: async () => new Response("", { status: 429 }) })).rejects.toBeInstanceOf(OverpassError);
    await expect(queryOverpass("x", { fetchImpl: async () => new Response('{"elements":[],"remark":"runtime error: Query timed out"}') })).rejects.toThrow(/abgebrochen/);
  });
});
