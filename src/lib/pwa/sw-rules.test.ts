import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildServiceWorker, swCacheName } from "./service-worker";
import { classifyRequest, type SwDecision } from "./sw-rules";

const ORIGIN = "https://praxis.example";
const get = (p: string, mode = "cors") => classifyRequest({ url: new URL(p, ORIGIN).toString(), method: "GET", mode, origin: ORIGIN });
const nav = (p: string) => get(p, "navigate");

describe("Service Worker: was gecacht werden darf", () => {
  it("statische, gehashte Dateien und Icons → cache-first", () => {
    for (const p of [
      "/_next/static/chunks/app-3f2a.js",
      "/_next/static/css/9a1b.css",
      "/_next/static/media/inter-latin.woff2",
      "/icons/icon-192.png",
      "/icons/icon.svg",
      "/splash/apple-splash-1170x2532.png",
      "/brand/podohero-mark.svg",
    ])
      expect(get(p), p).toBe("static");
  });

  it("niemals: Praxis-Seiten als Daten, API, RSC, Bilder-Optimierung, PDFs, Exporte, Uploads", () => {
    const never = [
      "/heute",
      "/kunden/0b6f5d1e-0000-4000-8000-000000000000",
      "/api/patienten/vorschlaege?q=mei",
      "/api/rechnungen/123/pdf",
      "/api/export/doctolib",
      "/api/files/abc",
      "/kalender?_rsc=1x2y",
      "/heute?_rsc=abc",
      "/_next/image?url=%2Fx.png&w=64&q=75",
      "/manifest.webmanifest",
      "/sw.js",
      "/icons/../api/secret",
      "/icons/icon-192.png?v=2",
      "/icons/readme.txt",
      "/screenshots/heute-tagesueberblick.webp",
      "/offline",
      "/_next/static/chunks/a.js?v=1",
      "/_next/static/%2e%2e/api/x",
      "/_next/static/chunks/a%20b.js",
      "/brand/sub/logo.svg",
    ];
    for (const p of never) expect(get(p), p).toBe("network");
  });

  it("Server Actions und andere schreibende Anfragen laufen nie über den Cache", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const p of ["/kunden/neu", "/_next/static/chunks/a.js", "/heute"]) {
        expect(classifyRequest({ url: ORIGIN + p, method, mode: "navigate", origin: ORIGIN }), `${method} ${p}`).toBe("network");
        expect(classifyRequest({ url: ORIGIN + p, method, mode: "cors", origin: ORIGIN }), `${method} ${p}`).toBe("network");
      }
    }
  });

  it("fremde Herkunft wird nicht angefasst", () => {
    expect(classifyRequest({ url: "https://cdn.example/_next/static/a.js", method: "GET", mode: "cors", origin: ORIGIN })).toBe("network");
    expect(classifyRequest({ url: "https://evil.example/heute", method: "GET", mode: "navigate", origin: ORIGIN })).toBe("network");
    expect(classifyRequest({ url: "kaputt", method: "GET", mode: "cors", origin: ORIGIN })).toBe("network");
  });

  it("Seitenaufrufe der Praxis-App: nur Netz mit Offline-Ersatz (die Seite selbst wird nie gespeichert)", () => {
    for (const p of ["/heute", "/kalender?ansicht=woche", "/kunden/abc", "/login", "/einstellungen/app", "/"]) expect(nav(p), p).toBe("navigate");
  });

  it("Patientenseiten und Datei-Downloads als Seite: kein Eingriff (kein PodoHero-Offline-Hinweis)", () => {
    for (const p of ["/p/praxis-muster", "/p/praxis-muster/impressum", "/portal", "/portal/abc", "/buchen/praxis", "/anamnese/tok", "/abmelden/tok", "/aktion/CODE", "/api/rechnungen/1/pdf", "/robots.txt", "/rechnung.pdf"])
      expect(nav(p), p).toBe("network");
    // ähnlich benannte Praxis-Seiten bleiben App-Seiten
    for (const p of ["/portalx", "/pflegeheime", "/plattform", "/buchenx"]) expect(nav(p), p).toBe("navigate");
  });
});

describe("Service Worker: erzeugtes Skript", () => {
  const src = buildServiceWorker("20261113120000");

  it("ist gültiges JavaScript und übernimmt classifyRequest unverändert (in sich geschlossen)", () => {
    const listeners: Record<string, unknown> = {};
    const self = { addEventListener: (t: string, fn: unknown) => (listeners[t] = fn), location: { origin: ORIGIN } };
    const ctx = vm.createContext({ self, URL, caches: {}, fetch: () => Promise.reject(new Error("offline")), Response, Promise });
    vm.runInContext(src, ctx);
    expect(Object.keys(listeners).sort()).toEqual(["activate", "fetch", "install", "message"]);
    const inner = ctx.classifyRequest as typeof classifyRequest;
    const cases: [string, string, string, SwDecision][] = [
      ["/_next/static/a.js", "GET", "cors", "static"],
      ["/heute", "GET", "navigate", "navigate"],
      ["/heute", "POST", "navigate", "network"],
      ["/api/x", "GET", "cors", "network"],
      ["/portal", "GET", "navigate", "network"],
    ];
    for (const [p, method, mode, want] of cases) expect(inner({ url: ORIGIN + p, method, mode, origin: ORIGIN })).toBe(want);
  });

  it("versionierter Cache-Name, alte Caches werden beim Aktivieren gelöscht, kein ungefragtes skipWaiting", () => {
    expect(src).toContain(JSON.stringify(swCacheName("20261113120000")));
    expect(swCacheName("a b/../c")).toBe("podo-static-ab..c");
    expect(src).toMatch(/caches\.delete/);
    // skipWaiting nur als Reaktion auf die Nachricht SKIP_WAITING (Nutzer:in hat „Neu laden“ bestätigt)
    expect(src.match(/skipWaiting\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/type === "SKIP_WAITING"\) self\.skipWaiting\(\)/);
    // Offline-Seite ohne Cookies laden
    expect(src).toContain('credentials: "omit"');
  });
});
