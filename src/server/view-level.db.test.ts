/**
 * Ansicht (users.prefs.view) gegen PostgreSQL: Speichern lässt übrige Einstellungen (Neuigkeiten) unangetastet.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Ansicht (DB)", () => {
  const f = fixtures(TEST_DB!);
  let view: typeof import("@/server/view-level");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    view = await import("@/server/view-level");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const prefs = async (user: string) => (await f.pool.query("select prefs from users where id = $1", [user])).rows[0].prefs;

  it("speichert die Ansicht und behält andere Einstellungen", async () => {
    const user = await f.user();
    await f.pool.query(`update users set prefs = '{"changelog":{"seenId":"2026-01-01"}}'::jsonb where id = $1`, [user]);
    expect(await view.saveViewLevel(user, "einfach")).toBe(true);
    expect(await prefs(user)).toEqual({ changelog: { seenId: "2026-01-01" }, view: "einfach" });
    expect(await view.saveViewLevel(user, "komplex")).toBe(true);
    expect(await prefs(user)).toEqual({ changelog: { seenId: "2026-01-01" }, view: "komplex" });
  });

  it("unbekannte Person: nichts gespeichert", async () => {
    expect(await view.saveViewLevel("00000000-0000-4000-8000-000000000000", "kompakt")).toBe(false);
  });

  it("ohne Sitzung gilt der Standard „Komplex“", async () => {
    expect(await view.currentViewLevel()).toBe("komplex");
  });
});
