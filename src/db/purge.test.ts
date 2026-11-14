/**
 * Löschlauf für gekündigte Praxen (scripts/purge-organizations.ts) gegen eine echte Datenbank.
 * Braucht die EIGENTÜMER-Rolle (nur sie darf die Unveränderbarkeits-Trigger in der Transaktion aussetzen):
 * TEST_OWNER_DATABASE_URL, Standard bei gesetztem TEST_DATABASE_URL: podo_owner auf der Test-DB.
 * Prüft vor allem: Daten einer ANDEREN Praxis bleiben vollständig erhalten, Trigger sind danach wieder aktiv.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertTableOwner, findDueOrganizations, purgeOrganization } from "@/server/purge-organization";

const ownerUrl =
  process.env.TEST_OWNER_DATABASE_URL ?? (process.env.TEST_DATABASE_URL ? ownerUrlFrom(process.env.TEST_DATABASE_URL) : undefined);
/** Gleiche Datenbank (Host/Port/Name) wie TEST_DATABASE_URL, aber mit der Eigentümer-Rolle podo_owner. */
function ownerUrlFrom(appUrl: string): string {
  const u = new URL(appUrl);
  u.username = "podo_owner";
  u.password = "podo_owner";
  return u.toString();
}
const d = ownerUrl ? describe : describe.skip;
/** Löschlauf sperrt Tabellen mit NOWAIT und wiederholt bei belegten Tabellen (parallele DB-Tests) */
const PURGE_TIMEOUT = { timeout: 30_000 };

type Seed = { org: string; user: string; patient: string; record: string; invoice: string };

d("Löschlauf gekündigter Praxen", PURGE_TIMEOUT, () => {
  let pool: Pool;
  let storageRoot: string;
  let a: Seed, b: Seed;
  let sharedUser: string;
  const sfx = Math.random().toString(36).slice(2, 8);

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

  async function seed(label: string): Promise<Seed> {
    const org = (await pool.query("insert into organizations (name, slug) values ($1, $2) returning id", [`Purge ${label}`, `purge-${label}-${sfx}`])).rows[0].id;
    const user = (await pool.query("insert into users (email, name, password_hash) values ($1, $2, 'x') returning id", [`purge-${label}-${sfx}@example.org`, `Nutzer ${label}`])).rows[0].id;
    await pool.query("insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [org, user]);
    await pool.query("insert into sessions (id, user_id, organization_id, expires_at) values ($1, $2, $3, now() + interval '1 hour')", [`s-${label}-${sfx}`, user, org]);
    const ids = await asOrg(org, async (c) => {
      const patient = (await c.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Beispiel') returning id", [org])).rows[0].id;
      await c.query("insert into consents (organization_id, patient_id, type, granted) values ($1, $2, 'privacy_notice', true)", [org, patient]);
      await c.query("insert into anamneses (organization_id, patient_id, data) values ($1, $2, '{}')", [org, patient]);
      const record = (
        await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, findings, hash) values ($1,$2,$3, now(), 'Befund', 'h') returning id", [org, patient, user])
      ).rows[0].id;
      await c.query("insert into record_addenda (organization_id, record_id, author_id, text, hash) values ($1,$2,$3,'Nachtrag','h2')", [org, record, user]);
      await c.query(
        "insert into media (organization_id, patient_id, record_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by) values ($1,$2,$3,'photo','finding',$4,'image/jpeg',1,'x',$5)",
        [org, patient, record, `${org}/2026/01/test.bin`, user],
      );
      const invoice = (await c.query("insert into invoices (organization_id, patient_id, status) values ($1,$2,'draft') returning id", [org, patient])).rows[0].id;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents) values ($1,$2,'PK',6500,6500)", [org, invoice]);
      await c.query("update invoices set status='issued', number=$2, total_cents=6500 where id=$1", [invoice, `R2099-${label}`]);
      await c.query("insert into payments (organization_id, invoice_id, method, amount_cents) values ($1,$2,'cash',6500)", [org, invoice]);
      await c.query("insert into integration_connections (organization_id, provider, secret_enc) values ($1,'lexoffice','geheim')", [org]);
      return { patient, record, invoice };
    });
    await pool.query("insert into audit_log (organization_id, user_id, action) values ($1, $2, 'test.purge')", [org, user]);
    await mkdir(path.join(storageRoot, org, "2026", "01"), { recursive: true });
    await writeFile(path.join(storageRoot, org, "2026", "01", "test.bin"), "x");
    return { org, user, ...ids };
  }

  const count = (org: string, table: string) =>
    asOrg(org, async (c) => Number((await c.query(`select count(*)::int as n from ${table} where organization_id = $1`, [org])).rows[0].n));

  beforeAll(async () => {
    pool = new Pool({ connectionString: ownerUrl, max: 3 });
    storageRoot = await mkdtemp(path.join(tmpdir(), "podo-purge-"));
    a = await seed("a");
    b = await seed("b");
    // Benutzer in beiden Praxen: darf beim Löschen von A nicht verschwinden
    sharedUser = (await pool.query("insert into users (email, name, password_hash) values ($1, 'Geteilt', 'x') returning id", [`purge-shared-${sfx}@example.org`])).rows[0].id;
    await pool.query("insert into memberships (organization_id, user_id, role) values ($1, $3, 'therapist'), ($2, $3, 'therapist')", [a.org, b.org, sharedUser]);
    // A hat die Löschung vor 31 Tagen beantragt, B vor 5 Tagen (Karenzzeit läuft)
    await pool.query("update organizations set deletion_requested_at = now() - interval '31 days' where id = $1", [a.org]);
    await pool.query("update organizations set deletion_requested_at = now() - interval '5 days' where id = $1", [b.org]);
  });

  afterAll(async () => {
    await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await pool?.end();
  });

  it("läuft nur mit der Eigentümer-Rolle", async () => {
    const c = await pool.connect();
    try {
      await expect(assertTableOwner(c)).resolves.toBeUndefined();
    } finally {
      c.release();
    }
  });

  it("findet nur fällige Praxen und verweigert die Karenzzeit", async () => {
    const c = await pool.connect();
    try {
      const due = (await findDueOrganizations(c)).map((o) => o.id);
      expect(due).toContain(a.org);
      expect(due).not.toContain(b.org);
      await expect(purgeOrganization(c, b.org, { execute: true, storageRoot })).rejects.toThrow(/Karenzzeit/);
    } finally {
      c.release();
    }
  });

  it("Probelauf zählt, löscht aber nichts", async () => {
    const c = await pool.connect();
    try {
      const r = await purgeOrganization(c, a.org, { execute: false, storageRoot });
      expect(r.executed).toBe(false);
      expect(r.rows.treatment_records).toBe(1);
      expect(r.rows.audit_log).toBeGreaterThanOrEqual(1);
      expect(r.users).toBe(1);
    } finally {
      c.release();
    }
    expect(await count(a.org, "patients")).toBe(1);
  });

  it("löscht Praxis A vollständig und lässt Praxis B unberührt", async () => {
    const before = {
      patients: await count(b.org, "patients"),
      records: await count(b.org, "treatment_records"),
      addenda: await count(b.org, "record_addenda"),
      media: await count(b.org, "media"),
      invoices: await count(b.org, "invoices"),
      lines: await count(b.org, "invoice_lines"),
      payments: await count(b.org, "payments"),
      consents: await count(b.org, "consents"),
      audit: await count(b.org, "audit_log"),
    };
    const lines: string[] = [];
    const c = await pool.connect();
    try {
      const r = await purgeOrganization(c, a.org, { execute: true, storageRoot, log: (l) => lines.push(l) });
      expect(r.executed).toBe(true);
      expect(r.users).toBe(1);
    } finally {
      c.release();
    }
    expect(lines.some((l) => l.includes(`org.purged id=${a.org}`))).toBe(true);

    // A ist weg – inklusive unveränderbarer Tabellen, Benutzer, Sitzungen und Dateien
    expect((await pool.query("select 1 from organizations where id = $1", [a.org])).rowCount).toBe(0);
    for (const t of ["patients", "treatment_records", "record_addenda", "media", "invoices", "invoice_lines", "payments", "consents", "anamneses", "integration_connections"])
      expect(await count(a.org, t)).toBe(0);
    expect((await pool.query("select 1 from memberships where organization_id = $1", [a.org])).rowCount).toBe(0);
    expect((await pool.query("select 1 from sessions where organization_id = $1", [a.org])).rowCount).toBe(0);
    expect((await pool.query("select 1 from users where id = $1", [a.user])).rowCount).toBe(0);
    expect((await pool.query("select 1 from users where id = $1", [sharedUser])).rowCount).toBe(1);
    expect(await readdir(storageRoot)).toEqual([b.org]);

    // B ist vollständig erhalten
    expect({
      patients: await count(b.org, "patients"),
      records: await count(b.org, "treatment_records"),
      addenda: await count(b.org, "record_addenda"),
      media: await count(b.org, "media"),
      invoices: await count(b.org, "invoices"),
      lines: await count(b.org, "invoice_lines"),
      payments: await count(b.org, "payments"),
      consents: await count(b.org, "consents"),
      audit: await count(b.org, "audit_log"),
    }).toEqual(before);
    expect((await pool.query("select 1 from users where id = $1", [b.user])).rowCount).toBe(1);
    expect((await pool.query("select 1 from memberships where organization_id = $1", [b.org])).rowCount).toBe(2);

    // Plattform-Protokoll (Zeilen ohne Praxis sind per RLS unsichtbar → kurz als Eigentümer ohne FORCE lesen, dann zurückrollen)
    const logged = await asOrg(null, async (c) => {
      await c.query("alter table audit_log no force row level security");
      const n = (await c.query("select 1 from audit_log where organization_id is null and action = 'platform.org_purged' and entity_id = $1", [a.org])).rowCount;
      await c.query("rollback");
      await c.query("begin");
      return n;
    });
    expect(logged).toBe(1);
  });

  it("Unveränderbarkeit und RLS sind danach wieder aktiv", async () => {
    await expect(asOrg(b.org, (c) => c.query("delete from treatment_records where id = $1", [b.record]))).rejects.toThrow(/unveränderbar/);
    await expect(asOrg(b.org, (c) => c.query("update invoices set notes = 'x' where id = $1", [b.invoice]))).rejects.toThrow();
    // Nicht-Superuser-Eigentümer: FORCE RLS blendet die Zeilen aus (0 Zeilen). Superuser (z. B. CI-Container)
    // umgeht RLS – dann muss der Append-only-Trigger greifen. In keinem Fall darf etwas gelöscht werden.
    const del = await pool.query("delete from audit_log where organization_id = $1", [b.org]).then(
      (r) => ({ rowCount: r.rowCount, error: null as string | null }),
      (e: Error) => ({ rowCount: 0, error: e.message }),
    );
    expect(del.rowCount).toBe(0);
    if (del.error) expect(del.error).toMatch(/unveränderbar|nicht gelöscht|append/i);
    const flags = await pool.query("select relforcerowsecurity from pg_class where relname = 'audit_log'");
    expect(flags.rows[0].relforcerowsecurity).toBe(true);
    const disabled = await pool.query(
      "select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'D'",
    );
    expect(disabled.rows).toEqual([]);
  });
});
