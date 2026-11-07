/**
 * Prüft die Sicherheitsregeln direkt in PostgreSQL (läuft nur mit TEST_DATABASE_URL, App-Rolle ohne Superuser):
 * - Row-Level-Security: Mandant B sieht keine Daten von Mandant A
 * - Ohne gesetzten Mandanten: keine Daten
 * - Behandlungsdoku ist unveränderbar
 * - Ausgestellte Rechnungen sind unveränderbar
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("Datenbank-Sicherheit", () => {
  let pool: Pool;
  let orgA: string, orgB: string, userId: string, patientA: string;

  async function asOrg<T>(org: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      if (org) await c.query("select set_config('app.org_id', $1, true)", [org]);
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
    orgA = (await pool.query("insert into organizations (name, slug) values ('A', $1) returning id", [`a-${sfx}`])).rows[0].id;
    orgB = (await pool.query("insert into organizations (name, slug) values ('B', $1) returning id", [`b-${sfx}`])).rows[0].id;
    userId = (await pool.query("insert into users (email, name, password_hash) values ($1, 'T', 'x') returning id", [`t-${sfx}@example.org`])).rows[0].id;
    patientA = await asOrg(orgA, async (c) => (await c.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Beispiel') returning id", [orgA])).rows[0].id);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("trennt Mandanten", async () => {
    const seenByA = await asOrg(orgA, async (c) => (await c.query("select id from patients where id = $1", [patientA])).rowCount);
    const seenByB = await asOrg(orgB, async (c) => (await c.query("select id from patients where id = $1", [patientA])).rowCount);
    const seenByNone = await asOrg(null, async (c) => (await c.query("select id from patients where id = $1", [patientA])).rowCount);
    expect(seenByA).toBe(1);
    expect(seenByB).toBe(0);
    expect(seenByNone).toBe(0);
  });

  it("verhindert Schreiben in fremden Mandanten", async () => {
    await expect(asOrg(orgB, (c) => c.query("insert into patients (organization_id, number, last_name) values ($1, 2, 'X')", [orgA]))).rejects.toThrow();
  });

  it("Behandlungsdoku ist unveränderbar", async () => {
    const rec = await asOrg(orgA, async (c) =>
      (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, findings, hash) values ($1,$2,$3, now(), 'Befund', 'h') returning id", [orgA, patientA, userId])).rows[0].id,
    );
    await expect(asOrg(orgA, (c) => c.query("update treatment_records set findings = 'geändert' where id = $1", [rec]))).rejects.toThrow(/unveränderbar/);
    await expect(asOrg(orgA, (c) => c.query("delete from treatment_records where id = $1", [rec]))).rejects.toThrow(/unveränderbar/);
  });

  it("ausgestellte Rechnungen sind unveränderbar", async () => {
    const inv = await asOrg(orgA, async (c) => {
      const id = (await c.query("insert into invoices (organization_id, patient_id, status) values ($1,$2,'draft') returning id", [orgA, patientA])).rows[0].id;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents) values ($1,$2,'PK',6500,6500)", [orgA, id]);
      await c.query("update invoices set status='issued', number='R2099-0001', total_cents=6500 where id=$1", [id]);
      return id;
    });
    await expect(asOrg(orgA, (c) => c.query("update invoices set total_cents = 1 where id = $1", [inv]))).rejects.toThrow(/unveränderbar/);
    await expect(asOrg(orgA, (c) => c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents) values ($1,$2,'X',1,1)", [orgA, inv]))).rejects.toThrow(/unveränderbar/);
    // Statuswechsel (bezahlt/storniert) bleibt erlaubt
    await asOrg(orgA, (c) => c.query("update invoices set status = 'paid', paid_cents = 6500 where id = $1", [inv]));
  });
});
