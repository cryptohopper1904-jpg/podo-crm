/**
 * Praxis-Stammdaten (organizations) mandantensicher (Migration 0069) gegen PostgreSQL – App-Rolle, erfundene Daten:
 * Im Praxis-Kontext (app.org_id, withOrg) sieht und ändert eine Praxis nur ihre eigene Zeile; ohne Kontext bleiben die
 * praxisübergreifenden Sonderwege (Anmeldung, Einrichtung, Plattform-Konsole, Cron, Webhooks) unverändert.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { fixtures, TEST_DB, withMigratedDatabase } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Praxis-Stammdaten – RLS auf organizations (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let dbm: typeof import("@/db");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    dbm = await import("@/db");
  });
  afterAll(async () => {
    await fx.end();
    await (dbm.db.$client as { end: () => Promise<void> }).end();
  });

  const nameOf = async (org: string) => (await fx.pool.query("select name from organizations where id = $1", [org])).rows[0]?.name as string | undefined;

  it("Praxis A kann Praxis B weder lesen noch ändern; der eigene Name lässt sich ändern", async () => {
    const a = await fx.org();
    const b = await fx.org();
    const before = await nameOf(b);

    await fx.asOrg(a, async (c) => {
      // lesen: B unsichtbar, auch ohne Filter nur die eigene Zeile
      expect((await c.query("select id from organizations where id = $1", [b])).rowCount).toBe(0);
      expect((await c.query("select id from organizations")).rows.map((r) => r.id)).toEqual([a]);
      // ändern: trifft B nicht (0 Zeilen), auch nicht über eine Bedingung ohne id
      expect((await c.query("update organizations set name = 'Übernommen' where id = $1", [b])).rowCount).toBe(0);
      expect((await c.query("update organizations set name = 'Eigene Praxis Neu' where name is not null")).rowCount).toBe(1);
    });
    expect(await nameOf(b)).toBe(before);
    expect(await nameOf(a)).toBe("Eigene Praxis Neu");

    // WITH CHECK: die eigene Zeile nicht auf eine andere Praxis-ID umschreiben, keine fremde Praxis anlegen
    await expect(fx.asOrg(a, (c) => c.query("update organizations set id = gen_random_uuid() where id = $1", [a]))).rejects.toThrow(/row-level security/);
    await expect(fx.asOrg(a, (c) => c.query("insert into organizations (name, slug) values ('Fremd', $1)", [`t-x-${Date.now()}`]))).rejects.toThrow(/row-level security/);
  });

  it("über withOrg (App-Code): nur die eigene Praxis, fremde Zeile bleibt unverändert", async () => {
    const { withOrg } = dbm;
    const { organizations } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const a = await fx.org();
    const b = await fx.org();
    const before = await nameOf(b);
    const foreign = await withOrg(a, (tx) => tx.update(organizations).set({ name: "Übernommen" }).where(eq(organizations.id, b)).returning({ id: organizations.id }));
    expect(foreign).toEqual([]);
    expect(await withOrg(a, (tx) => tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, b)))).toEqual([]);
    const own = await withOrg(a, (tx) => tx.update(organizations).set({ name: "Praxis Fußwohl" }).where(eq(organizations.id, a)).returning({ name: organizations.name }));
    expect(own).toEqual([{ name: "Praxis Fußwohl" }]);
    expect(await nameOf(b)).toBe(before);
  });

  it("Einstellungen speichern (saveTripSettings) läuft im Praxis-Kontext und ändert nur die eigene Praxis", async () => {
    const trips = await import("./trips");
    const a = await fx.org();
    const b = await fx.org();
    const user = await fx.user(a);
    const auth = { organization: { id: a }, user: { id: user }, role: "owner", support: null, can: () => true } as never;
    await trips.saveTripSettings(auth, { rateCents: 30, billing: "none", returnToStart: true } as never);
    const settingsOf = async (org: string) => (await fx.pool.query("select settings from organizations where id = $1", [org])).rows[0].settings as Record<string, unknown>;
    expect((await settingsOf(a)).trips).toMatchObject({ rateCents: 30 });
    expect((await settingsOf(b)).trips).toBeUndefined();
  });

  it("ohne Praxis-Kontext (Sonderwege: Anmeldung, Einrichtung, Plattform, Cron) unverändert: lesen, anlegen, ändern", async () => {
    const a = await fx.org();
    const b = await fx.org();
    const both = await fx.pool.query("select id from organizations where id = any($1::uuid[])", [[a, b]]);
    expect(both.rowCount).toBe(2);
    expect((await fx.pool.query("update organizations set seats = 2 where id = any($1::uuid[])", [[a, b]])).rowCount).toBe(2);
    // auch nach einer Transaktion mit Kontext ist app.org_id auf derselben Verbindung wieder leer (set_config lokal)
    await fx.asOrg(a, (c) => c.query("select 1"));
    expect((await fx.pool.query("select id from organizations where id = any($1::uuid[])", [[a, b]])).rowCount).toBe(2);
  });

  it("Migration 0069: RLS aktiv und erzwungen, Policy für alle Befehle mit USING und WITH CHECK, idempotent", async () => {
    const ran = await withMigratedDatabase(async (c) => {
      const check = async () => {
        const t = (await c.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.organizations'::regclass")).rows[0];
        expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const p = (await c.query("select cmd, qual is not null as has_using, with_check is not null as has_check from pg_policies where tablename = 'organizations'")).rows;
        expect(p).toEqual([{ cmd: "ALL", has_using: true, has_check: true }]);
      };
      await check();
      const sqlText = readFileSync(path.join(__dirname, "../../drizzle/0069_org_stammdaten_rls.sql"), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) await c.query(stmt);
      await check();
    });
    if (!ran) console.warn("Migrationstest übersprungen (kein CREATE DATABASE)");
  });
});
