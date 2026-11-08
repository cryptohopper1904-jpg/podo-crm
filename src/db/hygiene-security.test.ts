/**
 * Hygiene-Nachweise in PostgreSQL (nur mit TEST_DATABASE_URL):
 * - entschiedene Sterilgut-Chargen sind unveränderbar, Chargen werden nie gelöscht
 * - Gerätebuch (device_events) ist append-only
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("Hygiene: Unveränderbarkeit", () => {
  let pool: Pool;
  let org: string;

  async function asOrg<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    const sfx = Math.random().toString(36).slice(2, 8);
    org = (await pool.query("insert into organizations (name, slug) values ('H', $1) returning id", [`h-${sfx}`])).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("offene Charge darf geändert, entschiedene nicht mehr geändert werden", async () => {
    const id = await asOrg(async (c) => (await c.query("insert into sterile_batches (organization_id, code) values ($1, 'ST-TEST-01') returning id", [org])).rows[0].id);
    await asOrg((c) => c.query("update sterile_batches set note = 'Beladung 2' where id = $1", [id]));
    await asOrg((c) => c.query("update sterile_batches set result = 'released', released_at = now(), indicator_ok = true where id = $1", [id]));
    await expect(asOrg((c) => c.query("update sterile_batches set result = 'rejected' where id = $1", [id]))).rejects.toThrow(/endgültig/);
    await expect(asOrg((c) => c.query("update sterile_batches set note = 'nachträglich' where id = $1", [id]))).rejects.toThrow(/endgültig/);
    await expect(asOrg((c) => c.query("delete from sterile_batches where id = $1", [id]))).rejects.toThrow(/nicht gelöscht/);
    const row = await asOrg(async (c) => (await c.query("select result, note from sterile_batches where id = $1", [id])).rows[0]);
    expect(row).toEqual({ result: "released", note: "Beladung 2" });
  });

  it("Chargennummer einer offenen Charge ist unveränderbar", async () => {
    const id = await asOrg(async (c) => (await c.query("insert into sterile_batches (organization_id, code) values ($1, 'ST-TEST-02') returning id", [org])).rows[0].id);
    await expect(asOrg((c) => c.query("update sterile_batches set code = 'ST-TEST-99' where id = $1", [id]))).rejects.toThrow(/unveränderbar/);
  });

  it("Gerätebuch-Einträge können nicht geändert oder gelöscht werden", async () => {
    const ev = await asOrg(async (c) => {
      const dev = (await c.query("insert into devices (organization_id, name, kind) values ($1, 'Autoklav', 'sterilizer') returning id", [org])).rows[0].id;
      return (await c.query("insert into device_events (organization_id, device_id, kind, occurred_at) values ($1, $2, 'maintenance', current_date) returning id", [org, dev])).rows[0].id;
    });
    await expect(asOrg((c) => c.query("update device_events set note = 'geändert' where id = $1", [ev]))).rejects.toThrow();
    await expect(asOrg((c) => c.query("delete from device_events where id = $1", [ev]))).rejects.toThrow();
    const n = await asOrg(async (c) => (await c.query("select note from device_events where id = $1", [ev])).rows[0]);
    expect(n.note).toBeNull();
  });
});
