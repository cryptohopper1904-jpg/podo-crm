/**
 * Touren/Fahrtenbuch: Routen sind ohne Sitzung gesperrt und prüfen serverseitig die passenden Rechte.
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import path from "node:path";
import { proxy } from "@/proxy";
import { appRoutes, APP, read } from "./app-files";

const NEW_ROUTES = ["/touren", "/touren/losfahren", "/touren/fahrtenbuch", "/touren/fahrtenbuch/00000000-0000-4000-8000-000000000000", "/api/fahrtenbuch/export", "/einstellungen/fahrten"];

describe("Touren & Fahrtenbuch: Routen-Schutz", () => {
  it("alle neuen Routen existieren und leiten ohne Cookie zum Login", async () => {
    const paths = appRoutes().map((r) => r.path);
    for (const p of NEW_ROUTES) {
      expect(paths, p).toContain(p);
      const res = proxy(new NextRequest(new URL(`${p}?monat=2026-11&format=csv`, "https://praxis.example")));
      expect(res.status, p).toBeGreaterThanOrEqual(300);
      expect(new URL(res.headers.get("location") ?? "", "https://x").pathname, p).toBe("/login");
    }
  });

  it("Seiten und Export prüfen die Rechte serverseitig", () => {
    const src = (f: string) => read(path.join(APP, f));
    expect(src("(app)/touren/page.tsx")).toMatch(/requireAuth\("appointments\.read"\)/);
    expect(src("(app)/touren/losfahren/page.tsx")).toMatch(/requireAuth\("appointments\.write"\)/);
    expect(src("(app)/touren/fahrtenbuch/page.tsx")).toMatch(/canReadTripLog\(auth\)/);
    expect(src("(app)/touren/fahrtenbuch/[id]/page.tsx")).toMatch(/canReadTripLog\(auth\)/);
    expect(src("(app)/einstellungen/fahrten/page.tsx")).toMatch(/requireAuth\("settings\.manage"\)/);
    const exp = src("api/fahrtenbuch/export/route.ts");
    expect(exp).toMatch(/canReadTripLog\(auth\)/);
    expect(exp).toMatch(/downloadAllowed\(auth, "trip_log_export"\)/);
    const actions = src("(app)/touren/actions.ts");
    expect(actions.match(/requireAuth\("appointments\.write"\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
