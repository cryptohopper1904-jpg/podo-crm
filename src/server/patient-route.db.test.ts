/**
 * Echte 404 für unbekannte Akten (src/server/patient-route.ts): Pfaderkennung ohne DB, Existenzprüfung mit echter DB
 * (RLS aktiv, erfundene Daten) – unbekannt, kaputt und fremde Praxis gleich „nicht gefunden“.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
import type { AuthContext } from "@/lib/auth/session";
import { akteIdFromPath } from "./patient-route";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

describe("akteIdFromPath", () => {
  it("erkennt Akte und Unterseiten, sonst null", () => {
    expect(akteIdFromPath("/kunden/abc")).toBe("abc");
    expect(akteIdFromPath("/kunden/abc/doku/neu")).toBe("abc");
    expect(akteIdFromPath("/kunden/neu")).toBeNull();
    expect(akteIdFromPath("/kunden")).toBeNull();
    expect(akteIdFromPath("/kunden/")).toBeNull();
    expect(akteIdFromPath("/heute")).toBeNull();
    expect(akteIdFromPath("/rechnungen/kunden/abc")).toBeNull();
    expect(akteIdFromPath(null)).toBeNull();
  });
});

(TEST_DB ? describe : describe.skip)("assertPatientRouteExists (DB)", () => {
  const f = fixtures(TEST_DB!);
  let mod: typeof import("./patient-route");
  let orgA: string;
  let orgB: string;
  let own: string;
  let foreign: string;
  const auth = (org: string, perms = ["patients.read"]) => ({ organization: { id: org }, can: (p: string) => perms.includes(p) }) as unknown as AuthContext;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./patient-route");
    orgA = await f.org();
    orgB = await f.org();
    own = await f.patient(orgA, { lastName: "Eigen" });
    foreign = await f.patient(orgB, { lastName: "Fremd" });
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("eigene Akte: kein 404, auch für Unterseiten", async () => {
    await expect(mod.assertPatientRouteExists(auth(orgA), `/kunden/${own}`)).resolves.toBeUndefined();
    await expect(mod.assertPatientRouteExists(auth(orgA), `/kunden/${own}/doku/neu`)).resolves.toBeUndefined();
  });

  it("unbekannt, kaputte Kennung und fremde Praxis: gleich 404", async () => {
    await expect(mod.assertPatientRouteExists(auth(orgA), "/kunden/00000000-0000-4000-8000-000000000000")).rejects.toThrow("NOT_FOUND");
    await expect(mod.assertPatientRouteExists(auth(orgA), "/kunden/gibt-es-nicht/doku/neu")).rejects.toThrow("NOT_FOUND");
    await expect(mod.assertPatientRouteExists(auth(orgA), `/kunden/${foreign}`)).rejects.toThrow("NOT_FOUND");
  });

  it("ohne Leserecht oder außerhalb der Akte: keine Prüfung", async () => {
    await expect(mod.assertPatientRouteExists(auth(orgA, []), "/kunden/gibt-es-nicht")).resolves.toBeUndefined();
    await expect(mod.assertPatientRouteExists(auth(orgA), "/kunden/neu")).resolves.toBeUndefined();
    await expect(mod.assertPatientRouteExists(auth(orgA), "/heute")).resolves.toBeUndefined();
  });
});
