/**
 * Migration *_kontext_haertung gegen eine echte DB (App-Rolle, RLS aktiv, erfundene Daten):
 *  - leerer Kontext app.org_id: Tabellen mit erzwungenem RLS antworten einheitlich (kein Orakel über fremde Praxen),
 *    Tabellen ohne RLS (patient_links) prüfen wie bisher;
 *  - podo_fk_same_org: unbekannte Spalte in den Trigger-Argumenten bricht laut ab;
 *  - EXECUTE der SECURITY-DEFINER-Funktionen nicht mehr für PUBLIC, aber für die App-Rolle.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrlFrom = (url: string) => url.replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");

(TEST_DB ? describe : describe.skip)("Kontext-Härtung (DB, podo_fk_same_org / podo_user_in_org / Funktionsrechte)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 1 });

  afterAll(async () => {
    await f.end();
    await owner.end();
  });

  /** Schreiben OHNE Praxis-Kontext (App-Rolle) und immer zurückrollen – Fehler oder null */
  async function withoutContext(sql: string, params: unknown[]) {
    const c = await f.pool.connect();
    try {
      await c.query("begin");
      await c.query(sql, params);
      return null;
    } catch (e) {
      return e as { code?: string; message: string };
    } finally {
      await c.query("rollback");
      c.release();
    }
  }

  it("leerer Kontext: Zeile einer Praxis mit RLS → einheitlich 42501, egal ob der Verweis dort existiert", async () => {
    const b = await f.org();
    const memberB = await f.user(b);
    const patientB = await f.patient(b);
    const cases: [string, unknown[], unknown[]][] = [
      // podo_fk_same_org: Patient:in aus B vs. unbekannt
      ["insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'privacy_notice',true)", [b, patientB], [b, randomUUID()]],
      // podo_user_in_org: Mitglied von B vs. unbekannt
      ["insert into tasks (organization_id, title, assignee_id) values ($1,'x',$2)", [b, memberB], [b, randomUUID()]],
    ];
    for (const [sql, known, unknown] of cases) {
      const e1 = await withoutContext(sql, known);
      const e2 = await withoutContext(sql, unknown);
      expect([e1?.code, e2?.code], sql).toEqual(["42501", "42501"]);
      expect(e1?.message, sql).toBe(e2?.message);
      expect(e1?.message).toBe("Kein Praxis-Kontext gesetzt.");
    }
  });

  it("leerer Kontext: Tabelle ohne RLS (patient_links) prüft wie bisher – eigene Person erlaubt, fremde abgelehnt", async () => {
    const a = await f.org();
    const b = await f.org();
    const pa = await f.patient(a);
    const pb = await f.patient(b);
    const sql = "insert into patient_links (organization_id, patient_id, purpose, token_hash, expires_at) values ($1,$2,'portal',md5(random()::text), now() + interval '1 day')";
    expect(await withoutContext(sql, [a, pa])).toBeNull();
    const err = await withoutContext(sql, [a, pb]);
    expect(err?.code).toBe("23503");
    expect(err?.message).toMatch(/Patient:in gehört nicht zu dieser Praxis/);
  });

  it("Superuser-Wartung ohne Kontext wird weiter geprüft (nicht abgelehnt)", async (ctx) => {
    if (!(await owner.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]?.rolsuper) ctx.skip();
    const a = await f.org();
    const b = await f.org();
    const pa = await f.patient(a);
    const pb = await f.patient(b);
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("savepoint s");
      await expect(c.query("insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'marketing',true)", [a, pb])).rejects.toThrow(/gehört nicht zu dieser Praxis/);
      await c.query("rollback to savepoint s");
      await c.query("insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'marketing',true)", [a, pa]);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("podo_fk_same_org: unbekannte Spalte in den Trigger-Argumenten scheitert laut", async (ctx) => {
    if (!(await owner.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]?.rolsuper) ctx.skip();
    const a = await f.org();
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("create trigger zz_test_fk_same_org before insert on tasks for each row execute function podo_fk_same_org('patient', 'patients')");
      await c.query("select set_config('app.org_id', $1, true)", [a]);
      await expect(c.query("insert into tasks (organization_id, title) values ($1, 'x')", [a])).rejects.toThrow(/Spalte tasks\.patient fehlt/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("podo_delete_patient: Aufruf aus einer anderen Praxis verrät nicht, ob die Person dort Dokumentation hat", async () => {
    const a = await f.org();
    const author = await f.user(a);
    const pa = await f.patient(a);
    await f.asOrg(a, (c) => c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3, now(), md5(random()::text))", [a, pa, author]));
    const b = await f.org();
    const call = (patient: string) =>
      f.asOrg(b, async (c) => (await c.query("select podo_delete_patient($1::uuid) as ok", [patient])).rows[0].ok as boolean);
    // Person aus A mit Doku und unbekannte UUID: gleiche Antwort (nichts gelöscht, kein Fehler)
    expect(await call(pa)).toBe(false);
    expect(await call(randomUUID())).toBe(false);
    expect((await f.asOrg(a, (c) => c.query("select count(*)::int as n from patients where id = $1", [pa]))).rows[0].n).toBe(1);
    // in der eigenen Praxis greift die Aufbewahrungssperre weiter
    await expect(f.asOrg(a, (c) => c.query("select podo_delete_patient($1::uuid)", [pa]))).rejects.toThrow(/Aufbewahrungspflichtige Daten/);
  });

  it("SECURITY-DEFINER-Funktionen: kein EXECUTE für PUBLIC; die App-Rolle darf die drei, die sie selbst aufruft", async () => {
    const rows = (
      await owner.query(`select p.oid::regprocedure::text as fn,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef order by 1`)
    ).rows as { fn: string; public_exec: boolean }[];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.public_exec).map((r) => r.fn)).toEqual([]);
    const appRole = new URL(TEST_DB!).username;
    for (const fn of ["podo_delete_patient(uuid)", "podo_calendar_feeds_active()", "podo_calendar_feeds_health(interval)"]) {
      expect((await owner.query("select has_function_privilege($1, $2, 'EXECUTE') as ok", [appRole, fn])).rows[0].ok, fn).toBe(true);
    }
    // die App ruft sie tatsächlich auf (Kalender-Abo-Sync liest alle aktiven Feeds)
    expect(await withoutContext("select count(*) from podo_calendar_feeds_active()", [])).toBeNull();
  });
});
