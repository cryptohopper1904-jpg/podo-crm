/**
 * Verordnungs-Einheiten über die gemeinsame Doku-Logik (src/server/records.ts) gegen PostgreSQL.
 * Nur mit TEST_DATABASE_URL; erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)("Verordnung ↔ Behandlungsdoku (DB)", () => {
  let pool: Pool;
  let orgId: string, userId: string, patientId: string, otherPatientId: string, voId: string;
  let mod: typeof import("@/server/records");
  let dbm: typeof import("@/db");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pool = new Pool({ connectionString: url });
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    orgId = (await pool.query("insert into organizations (name, slug) values ('VO-Test', $1) returning id", [`vo-${sfx}`])).rows[0].id;
    userId = (await pool.query("insert into users (email, name, password_hash) values ($1, 'T', 'x') returning id", [`vo-${sfx}@example.org`])).rows[0].id;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [orgId]);
      patientId = (await c.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Beispiel') returning id", [orgId])).rows[0].id;
      otherPatientId = (await c.query("insert into patients (organization_id, number, last_name) values ($1, 2, 'Andere') returning id", [orgId])).rows[0].id;
      voId = (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1, $2, '2026-11-01', 'DF', 2) returning id", [orgId, patientId])).rows[0].id;
      await c.query("commit");
    } finally {
      c.release();
    }
    mod = await import("@/server/records");
    dbm = await import("@/db");
  });

  afterAll(async () => {
    await pool?.end();
    await (globalThis as unknown as { pool?: Pool }).pool?.end();
  });

  const ctx = () => ({ org: orgId, userId, role: "therapist" as const });
  const create = (patient: string) =>
    dbm.withOrg(orgId, (tx) => mod.insertTreatmentRecord(tx, ctx(), { patientId: patient, prescriptionId: voId, findings: "o. B.", servicesText: "Komplexbehandlung" }));
  const status = () => dbm.withOrg(orgId, async (tx) => (await tx.execute(`select status from prescriptions where id = '${voId}'`)).rows[0]?.status);

  it("zählt Einheiten und setzt den Status", async () => {
    await create(patientId);
    expect(await status()).toBe("active");
    await create(patientId);
    expect(await status()).toBe("completed");
    await expect(create(patientId)).rejects.toBeInstanceOf(mod.RecordInputError);
  });

  it("Verordnung eines anderen Patienten wird abgewiesen", async () => {
    await expect(create(otherPatientId)).rejects.toThrow(/gehört nicht/);
  });

  it("Hash-Kette enthält die Verordnung und verkettet die Einträge", async () => {
    const rows = await dbm.withOrg(orgId, async (tx) => (await tx.execute(`select hash, prev_hash, prescription_id from treatment_records where patient_id = '${patientId}' order by created_at`)).rows);
    expect(rows).toHaveLength(2);
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows.every((r) => r.prescription_id === voId)).toBe(true);
  });
});
