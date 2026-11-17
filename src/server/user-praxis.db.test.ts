/**
 * Migration *_user_praxis_abgleich gegen eine echte DB (App-Rolle, RLS aktiv, erfundene Daten):
 *  - Verweise auf Benutzer:innen nur innerhalb der Praxis (Trigger podo_user_in_org): fremd und unbekannt gleich
 *    abgelehnt, eigen erlaubt; Support (Plattform-Admin ohne Mitgliedschaft) als Handelnde:r nur mit gültiger Freigabe;
 *    support_grants.grantee_user_id nur Plattform-Admin mit 2FA; kein Orakel über Zeilen fremder Praxen; Vollständigkeit
 *    gegenüber allen Fremdschlüsseln auf users; UPDATE/Altbestand.
 *  - Fester search_path aller SECURITY-DEFINER-Funktionen, inkl. Angriff mit temporärer Tabelle `invoices`.
 *  - Migration mit Nicht-Superuser-Owner (Altbestand-Meldung, zweiter Lauf idempotent, Support-Pfad unter FORCE RLS).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { fixtures, insertLegacy, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrlFrom = (url: string) => url.replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
const DRIZZLE = path.join(__dirname, "../../drizzle");
/** Migration dieses Triggers – über den Namen gefunden, nicht über die Nummer */
const MIGRATION_SUFFIX = "_user_praxis_abgleich";
const NOT_IN_ORG = "Person gehört nicht zu dieser Praxis.";
const NO_SUPPORT = "Diese Person kann keinen Support-Zugriff erhalten.";

/** Praxis mit Inhaber:in, Person und einem Plattform-Admin (für grantee_user_id) */
type World = { org: string; owner: string; patient: string; admin: string };
type Case = { table: string; col: string; insert: (w: World, ref: string) => [string, unknown[]] };

/** Je Spalte (Auswahl, alle Arten): minimale Zeile, die getestete Spalte zeigt auf `ref` */
const CASES: Case[] = [
  {
    table: "appointments",
    col: "therapist_id",
    insert: (w, ref) => ["insert into appointments (organization_id, therapist_id, starts_at, ends_at) values ($1,$2, now(), now() + interval '30 minutes')", [w.org, ref]],
  },
  { table: "tasks", col: "assignee_id", insert: (w, ref) => ["insert into tasks (organization_id, title, assignee_id) values ($1,'Rückruf',$2)", [w.org, ref]] },
  ...(["driver_id", "created_by"] as const).map((col) => ({
    table: "trips",
    col,
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into trips (organization_id, trip_date, from_label, to_label, distance_m, distance_source, driver_id, created_by) values ($1, current_date, 'Praxis', 'Hausbesuch', 1000, 'route', $2, $3)",
      [w.org, col === "driver_id" ? ref : w.owner, col === "created_by" ? ref : w.owner],
    ],
  })),
  { table: "absences", col: "user_id", insert: (w, ref) => ["insert into absences (organization_id, user_id, starts_on, ends_on) values ($1,$2,'2026-12-01','2026-12-02')", [w.org, ref]] },
  { table: "calendar_blocks", col: "user_id", insert: (w, ref) => ["insert into calendar_blocks (organization_id, user_id, starts_on, all_day) values ($1,$2,'2026-12-01',true)", [w.org, ref]] },
  {
    table: "consents",
    col: "recorded_by",
    insert: (w, ref) => ["insert into consents (organization_id, patient_id, type, granted, recorded_by) values ($1,$2,'privacy_notice',true,$3)", [w.org, w.patient, ref]],
  },
  {
    table: "treatment_records",
    col: "author_id",
    insert: (w, ref) => ["insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3, now(), md5(random()::text))", [w.org, w.patient, ref]],
  },
  {
    table: "media",
    col: "uploaded_by",
    insert: (w, ref) => [
      "insert into media (organization_id, patient_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by) values ($1,$2,'photo','finding',$3,'image/jpeg',4,repeat('a',64),$4)",
      [w.org, w.patient, `${w.org}/${randomUUID()}.bin`, ref],
    ],
  },
  {
    table: "support_grants",
    col: "granted_by",
    insert: (w, ref) => [
      "insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,$3,'Ticket 42','read', now() + interval '2 hours')",
      [w.org, ref, w.admin],
    ],
  },
];

/** Verweise auf users aus Praxis-Tabellen, die bewusst nicht podo_user_in_org prüft (Begründung in der Migration) */
const EXEMPT = ["memberships.user_id", "sessions.user_id"];

(TEST_DB ? describe : describe.skip)("Benutzer-Verweise nur innerhalb der Praxis (DB, Trigger podo_user_in_org)", () => {
  const f = fixtures(TEST_DB!);
  const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? "");
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });

  afterAll(async () => {
    await f.end();
    await owner.end();
  });

  async function world(): Promise<World> {
    const org = await f.org();
    const ownerUser = await f.user(org);
    const patient = await f.patient(org);
    const admin = await platformAdmin();
    return { org, owner: ownerUser, patient, admin };
  }
  /** Plattform-Admin ohne Mitgliedschaft (Support); wird in f.end() zurückgestuft */
  const platformAdmin = (totp = true) => f.platformAdmin(totp);
  /** Schreiben im Praxis-Kontext und immer zurückrollen – Fehler oder null */
  async function attempt(org: string, sql: string, params: unknown[]) {
    const c = await f.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      await c.query(sql, params);
      return null;
    } catch (e) {
      return e as { code?: string; message: string; detail?: string };
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
  const grant = (w: World, grantee: string | null, o: { revoked?: boolean } = {}) =>
    f.asOrg(w.org, (c) =>
      c.query("insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at, revoked_at) values ($1,$2,$3,'Ticket 42','write', now() + interval '2 hours', $4) returning id", [
        w.org,
        w.owner,
        grantee,
        o.revoked ? new Date() : null,
      ]),
    );

  it("jede getestete Spalte: Person einer anderen Praxis und unbekannte UUID gleich abgelehnt (23503), eigene erlaubt", async () => {
    const a = await world();
    const b = await world();
    const therapistA = await f.user(a.org, "therapist");
    for (const c of CASES) {
      const label = `${c.table}.${c.col}`;
      const foreign = await attempt(a.org, ...c.insert(a, b.owner));
      const unknown = await attempt(a.org, ...c.insert(a, randomUUID()));
      expect(foreign?.code, `${label}: fremd`).toBe("23503");
      expect(foreign?.message, label).toBe(NOT_IN_ORG);
      expect(foreign?.detail, label).toBe(label);
      // kein Existenz-Orakel: unbekannte Person liefert exakt dieselbe Antwort
      expect(unknown?.code, `${label}: unbekannt`).toBe("23503");
      expect(unknown?.message, label).toBe(NOT_IN_ORG);
      expect(await attempt(a.org, ...c.insert(a, therapistA)), `${label}: eigen`).toBeNull();
    }
  }, 60_000);

  it("Vollständigkeit: jeder Fremdschlüssel auf users aus einer Praxis-Tabelle ist abgesichert; Testfälle passen zu den Triggern", async () => {
    const trig = await owner.query(`select tgrelid::regclass::text as src, encode(tgargs, 'escape') as raw
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'podo_user_in_org' and not t.tgisinternal`);
    const covered = new Map<string, string>();
    for (const r of trig.rows as { src: string; raw: string }[]) {
      const args = r.raw.replace(/\\000$/, "").split("\\000");
      for (let i = 0; i + 1 < args.length; i += 2) covered.set(`${r.src}.${args[i]}`, args[i + 1]);
    }
    expect([...new Set(covered.values())].sort()).toEqual(["actor", "member", "support"]);
    for (const c of CASES) expect(covered.has(`${c.table}.${c.col}`), `${c.table}.${c.col}`).toBe(true);
    const fks = await owner.query(`select c.conrelid::regclass::text as src, a.attname as col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'public.users'::regclass
        and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'organization_id' and not x.attisdropped)`);
    const all = (fks.rows as { src: string; col: string }[]).map((r) => `${r.src}.${r.col}`);
    expect(all.filter((k) => !covered.has(k) && !EXEMPT.includes(k))).toEqual([]);
    // keine veralteten Einträge: jede abgesicherte Spalte ist noch ein Fremdschlüssel auf users
    expect([...covered.keys()].filter((k) => !all.includes(k))).toEqual([]);
    // Zuordnungen verlangen die Mitgliedschaft (Support darf dort niemand sein)
    for (const k of ["appointments.therapist_id", "tasks.assignee_id", "trips.driver_id", "calendar_feeds.therapist_id", "absences.user_id", "working_hours.user_id", "calendar_blocks.user_id", "support_grants.granted_by"]) {
      expect(covered.get(k), k).toBe("member");
    }
    expect(covered.get("support_grants.grantee_user_id")).toBe("support");
  });

  it("Support als Handelnde:r: nur mit gültiger Freigabe dieser Praxis für genau diese Person; Zuordnungen nie", async (ctx) => {
    const a = await world();
    const b = await world();
    const admin = await platformAdmin();
    const consent = (by: string): [string, unknown[]] => ["insert into consents (organization_id, patient_id, type, granted, recorded_by) values ($1,$2,'marketing',true,$3)", [a.org, a.patient, by]];
    // ohne Freigabe: wie eine fremde Person
    expect((await attempt(a.org, ...consent(admin)))?.message).toBe(NOT_IN_ORG);
    // Freigabe einer anderen Praxis, widerrufene Freigabe, Freigabe für eine andere Person: weiterhin abgelehnt
    await grant(b, admin);
    await grant(a, admin, { revoked: true });
    await grant(a, await platformAdmin());
    expect((await attempt(a.org, ...consent(admin)))?.message).toBe(NOT_IN_ORG);
    // abgelaufene Freigabe
    await f.asOrg(a.org, (c) =>
      c.query("insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,$3,'Ticket 1','write', now() - interval '1 minute')", [a.org, a.owner, admin]),
    );
    expect((await attempt(a.org, ...consent(admin)))?.message).toBe(NOT_IN_ORG);
    // gültige Freigabe: als Handelnde:r erlaubt
    await grant(a, admin);
    expect(await attempt(a.org, ...consent(admin))).toBeNull();
    expect(await attempt(a.org, "insert into invoices (organization_id, patient_id, status, created_by) values ($1,$2,'draft',$3)", [a.org, a.patient, admin])).toBeNull();
    // … aber nie als zugeordnete Person (Termin, Aufgabe)
    expect((await attempt(a.org, "insert into tasks (organization_id, title, assignee_id) values ($1,'x',$2)", [a.org, admin]))?.message).toBe(NOT_IN_ORG);
    // 2FA nach der Freigabe abgeschaltet: die Freigabe zählt nicht mehr (die App lässt solche Konten nicht in die Praxis)
    const noTotp = await platformAdmin();
    await grant(a, noTotp);
    await f.pool.query("update users set totp_enabled = false where id = $1", [noTotp]);
    expect((await attempt(a.org, ...consent(noTotp)))?.message).toBe(NOT_IN_ORG);
    // Kontext bleibt erhalten: nach dem Lookup (der app.org_id lokal setzt) steht wieder die eigene Praxis
    const setting = await f.asOrg(a.org, async (c) => {
      await c.query(consent(admin)[0], consent(admin)[1]);
      return (await c.query("select current_setting('app.org_id', true) as v")).rows[0].v as string;
    });
    expect(setting).toBe(a.org);
    // ältere Freigabe ohne Person (alle Plattform-Admins, heute nicht mehr anlegbar) gilt bis zum Ablauf
    const c2 = await world();
    const any = await platformAdmin();
    const legacy = await insertLegacy(
      "insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,null,'Alt','read', now() + interval '2 hours')",
      [c2.org, c2.owner],
    );
    if (!legacy) ctx.skip(); // Altbestand nachstellen braucht einen Superuser
    expect(await attempt(c2.org, "insert into consents (organization_id, patient_id, type, granted, recorded_by) values ($1,$2,'marketing',true,$3)", [c2.org, c2.patient, any])).toBeNull();
    // Altfreigabe bleibt widerrufbar (UPDATE ohne Personenwechsel)
    expect(await attempt(c2.org, "update support_grants set revoked_at = now() where organization_id = $1", [c2.org])).toBeNull();
  });

  it("support_grants.grantee_user_id: nur Plattform-Admin mit 2FA; Mitglied, Admin ohne 2FA und unbekannt gleich abgelehnt", async () => {
    const a = await world();
    const sql = "insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,$3,'Ticket 42','read', now() + interval '2 hours')";
    expect(await attempt(a.org, sql, [a.org, a.owner, await platformAdmin()])).toBeNull();
    // ohne Person (= alle Plattform-Admins) nur noch im Altbestand
    const refused = [await f.user(a.org, "therapist"), await platformAdmin(false), randomUUID(), null];
    for (const grantee of refused) {
      const err = await attempt(a.org, sql, [a.org, a.owner, grantee]);
      expect(err?.code).toBe("23503");
      expect(err?.message).toBe(NO_SUPPORT);
    }
    // Person einer bestehenden Freigabe nicht nachträglich leeren
    const [{ id: gid }] = (await grant(a, await platformAdmin())).rows as { id: string }[];
    expect((await attempt(a.org, "update support_grants set grantee_user_id = null where id = $1", [gid]))?.message).toBe(NO_SUPPORT);
    // erteilen darf nur ein Mitglied der Praxis (Support selbst nie, auch nicht mit Freigabe)
    const admin = await platformAdmin();
    await grant(a, admin);
    expect((await attempt(a.org, sql, [a.org, admin, admin]))?.message).toBe(NOT_IN_ORG);
  });

  it("kein Orakel: Zeile für eine fremde Praxis im eigenen Kontext immer gleich abgelehnt (vor jedem Lookup), auch Sperrzeiten", async () => {
    const a = await world();
    const b = await world();
    for (const sql of [
      "insert into tasks (organization_id, title, assignee_id) values ($1,'x',$2)",
      "insert into calendar_blocks (organization_id, user_id, starts_on, all_day) values ($1,$2,'2026-12-01',true)",
    ]) {
      // B-Zeile mit B-Mitglied und mit Unbekannt: dieselbe Antwort – verrät nicht, wer in B Mitglied ist
      const e1 = await attempt(a.org, sql, [b.org, b.owner]);
      const e2 = await attempt(a.org, sql, [b.org, randomUUID()]);
      expect([e1?.code, e2?.code], sql).toEqual(["42501", "42501"]);
      expect(e1?.message).toBe(e2?.message);
    }
  });

  it("UPDATE: Wechsel auf fremde Person abgelehnt; unveränderter Altverweis bleibt bearbeitbar", async (ctx) => {
    const a = await world();
    const b = await world();
    const task = await f.asOrg(a.org, async (c) => (await c.query("insert into tasks (organization_id, title, assignee_id) values ($1,'Rückruf',$2) returning id", [a.org, a.owner])).rows[0].id as string);
    const err = await attempt(a.org, "update tasks set assignee_id = $2 where id = $1", [task, b.owner]);
    expect(err?.code).toBe("23503");
    expect(err?.message).toBe(NOT_IN_ORG);
    const su = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (!su.rows[0]?.rolsuper) ctx.skip(); // Altbestand nachstellen braucht session_replication_role (Superuser)
    const c = await owner.connect();
    let legacy: string;
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      legacy = (await c.query("insert into tasks (organization_id, title, assignee_id) values ($1,'Alt',$2) returning id", [a.org, b.owner])).rows[0].id;
      await c.query("commit");
    } finally {
      c.release();
    }
    expect(await attempt(a.org, "update tasks set title = 'Alt (erledigt)', assignee_id = assignee_id where id = $1", [legacy])).toBeNull();
    expect(await attempt(a.org, "update tasks set assignee_id = $2 where id = $1", [legacy, a.owner])).toBeNull();
    expect(await attempt(a.org, "update tasks set assignee_id = null where id = $1", [legacy])).toBeNull();
  });

  // Katalogprüfung „jede eigene Funktion hat den festen search_path“ steht im Migrationstest (frische DB): andere
  // Testdateien spielen ältere Migrationen erneut in die gemeinsame Test-DB ein (CREATE OR REPLACE setzt den Pfad zurück).
  it("search_path: temporäre Tabellen lenken Rechnungs- und Kassen-Guard nicht um", async () => {
    // Angriff: App-Rolle (TEMP-Recht) überdeckt invoices mit einer eigenen Tabelle, in der die ausgestellte Rechnung
    // als Entwurf erscheint – der Positions-Trigger muss trotzdem die echte Rechnung prüfen.
    const a = await world();
    const inv = await f.invoice(a.org, a.patient);
    const c = await f.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [a.org]);
      await c.query("create temp table invoices (id uuid, status text, number text) on commit drop");
      await c.query("insert into invoices values ($1, 'draft', null)", [inv]);
      await expect(c.query("update invoice_lines set total_cents = 1 where invoice_id = $1", [inv])).rejects.toThrow(/unveränderbar/);
    } finally {
      await c.query("rollback");
      c.release();
    }
    const total = await f.asOrg(a.org, async (cl) => (await cl.query("select total_cents from invoice_lines where invoice_id = $1", [inv])).rows[0].total_cents);
    expect(total).toBe(6500);
    // INVOKER-Guard: Zahlung rückwirkend in einen abgeschlossenen Kassenzeitraum, Abschlüsse per temporärer Tabelle versteckt
    const day = "2026-03-02";
    await f.asOrg(a.org, (cl) =>
      cl.query(
        `insert into cash_closings (organization_id, number, business_date, closed_at, opening_cents, cash_payments_cents, movements_cents, expected_cash_cents,
           counted_cash_cents, difference_cents, denominations, totals, payment_count, movement_count, first_bon_nr, last_bon_nr, items_digest, tse, hash, created_by)
         values ($1, 1, $2, $3, 0,0,0,0,0,0,'{}','{}',0,0,0,0,'d','{}',md5(random()::text),$4)`,
        [a.org, day, `${day}T18:00:00Z`, a.owner],
      ),
    );
    const pay = "insert into payments (organization_id, invoice_id, method, amount_cents, paid_at, created_by) values ($1,$2,'cash',100,$3,$4)";
    const c2 = await f.pool.connect();
    try {
      await c2.query("begin");
      await c2.query("select set_config('app.org_id', $1, true)", [a.org]);
      await c2.query("create temp table cash_closings (organization_id uuid, closed_at timestamptz) on commit drop");
      await expect(c2.query(pay, [a.org, inv, `${day}T10:00:00Z`, a.owner])).rejects.toThrow(/abgeschlossenen Kassenzeitraum/);
    } finally {
      await c2.query("rollback");
      c2.release();
    }
  });

  it("Trigger-Argument mit unbekannter Spalte scheitert laut statt still nichts zu prüfen", async (ctx) => {
    const su = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (!su.rows[0]?.rolsuper) ctx.skip(); // Trigger anlegen (zurückgerollt) als Owner/Superuser
    const a = await world();
    const c = await owner.connect();
    try {
      await c.query("begin");
      await c.query("create trigger zz_test_user_in_org before insert on tasks for each row execute function podo_user_in_org('assignee', 'member')");
      await c.query("select set_config('app.org_id', $1, true)", [a.org]);
      await expect(c.query("insert into tasks (organization_id, title) values ($1, 'x')", [a.org])).rejects.toThrow(/Spalte tasks\.assignee fehlt/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("Migration mit Nicht-Superuser-Owner: meldet Altbestand, zweiter Lauf idempotent, Trigger und Support-Pfad greifen", async (ctx) => {
    const su = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (!su.rows[0]?.rolsuper) ctx.skip(); // Rolle/Datenbank anlegen braucht einen Superuser (TEST_OWNER_DATABASE_URL)
    const sfx = Math.random().toString(36).slice(2, 8);
    const role = `podo_nu_${sfx}`;
    const dbName = `podo_nu_${sfx}`;
    const tmp = mkdtempSync(path.join(os.tmpdir(), "podo-mig-"));
    await owner.query(`create role ${role} login password '${role}' nosuperuser nobypassrls`);
    await owner.query(`create database ${dbName} owner ${role}`);
    const u = new URL(ownerUrl);
    u.pathname = `/${dbName}`;
    const suDb = new Pool({ connectionString: u.toString(), max: 1 });
    u.username = role;
    u.password = role;
    const ns = new Pool({ connectionString: u.toString(), max: 1 });
    for (const p of [suDb, ns]) {
      p.on("error", () => {});
      p.on("connect", (c) => c.on("error", () => {}));
    }
    const notices: string[] = [];
    ns.on("connect", (c) => c.on("notice", (n) => notices.push(n.message ?? "")));
    /** im Kontext `org` schreiben (Transaktion) – Fehler oder null */
    const inOrg = async (org: string, sql: string, params: unknown[]) => {
      const cl = await ns.connect();
      try {
        await cl.query("begin");
        await cl.query("select set_config('app.org_id', $1, true)", [org]);
        await cl.query(sql, params);
        await cl.query("commit");
        return null;
      } catch (e) {
        await cl.query("rollback");
        return e as { code?: string; message: string };
      } finally {
        cl.release();
      }
    };
    try {
      await suDb.query("create extension if not exists pgcrypto");
      await suDb.query("create extension if not exists pg_trgm");
      await suDb.end();
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      // Stand vor dieser Migration: Ordner kopieren, Journal kürzen
      const before = path.join(tmp, "drizzle");
      cpSync(DRIZZLE, before, { recursive: true });
      const journalPath = path.join(before, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
      const idx = journal.entries.findIndex((e) => e.tag.endsWith(MIGRATION_SUFFIX));
      expect(idx).toBeGreaterThan(0);
      const tag = journal.entries[idx].tag;
      journal.entries = journal.entries.slice(0, idx);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(drizzle(ns), { migrationsFolder: before });
      // vorher: search_path ohne pg_temp
      expect((await ns.query("select proconfig from pg_proc where proname = 'podo_invoice_lines_guard'")).rows[0].proconfig).toEqual(["search_path=public"]);
      // Altbestand: Aufgabe in A ist einer Person aus B zugeordnet
      const id = async (sql: string, params: unknown[]) => (await ns.query(sql, params)).rows[0].id as string;
      const orgA = await id("insert into organizations (name, slug) values ('A', $1) returning id", [`a-${sfx}`]);
      const orgB = await id("insert into organizations (name, slug) values ('B', $1) returning id", [`b-${sfx}`]);
      const userA = await id("insert into users (email, name, password_hash) values ($1,'A','x') returning id", [`a-${sfx}@example.org`]);
      const userB = await id("insert into users (email, name, password_hash) values ($1,'B','x') returning id", [`b-${sfx}@example.org`]);
      const admin = await id("insert into users (email, name, password_hash, is_platform_admin, totp_enabled) values ($1,'Support','x',true,true) returning id", [`s-${sfx}@example.org`]);
      await ns.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner'), ($3,$4,'owner')", [orgA, userA, orgB, userB]);
      expect(await inOrg(orgA, "insert into tasks (organization_id, title, assignee_id) values ($1,'Alt',$2)", [orgA, userB])).toBeNull();

      notices.length = 0;
      await migrate(drizzle(ns), { migrationsFolder: DRIZZLE });
      expect(notices.join("\n")).toMatch(/1 Zeile\(n\) in tasks\.assignee_id verweisen auf eine Person außerhalb der Praxis/);
      // Katalogtest auf VOLLSTÄNDIGEM Migrationsstand (alle Migrationen bis zur neuesten), BEVOR irgendetwas den Pfad
      // nachträglich korrigiert (zweiter Lauf von *_user_praxis_abgleich unten, RESTORE_SEARCH_PATH_SQL der Fixtures):
      // Jede eigene Funktion in public muss den festen search_path tragen – auch die aus späteren Migrationen
      // (CREATE OR REPLACE ohne SET search_path setzt ihn zurück, AppSec B1 PR #113).
      const lastTag = (JSON.parse(readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] }).entries.at(-1)!.tag;
      const applied = await ns.query("select count(*)::int as n from drizzle.__drizzle_migrations");
      expect(applied.rows[0].n, `bis ${lastTag} eingespielt`).toBe((JSON.parse(readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length);
      const fresh = await ns.query(`select p.proname, p.proconfig from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        order by p.proname`);
      const withoutPath = (fresh.rows as { proname: string; proconfig: string[] | null }[])
        .filter((r) => !(r.proconfig ?? []).includes("search_path=pg_catalog, public, pg_temp"))
        .map((r) => r.proname);
      expect(withoutPath, "Funktionen ohne festen search_path (frische Migration)").toEqual([]);
      expect(fresh.rows.map((r: { proname: string }) => r.proname)).toEqual(expect.arrayContaining(["podo_payment_closing_guard", "podo_payment_register_immutable"]));
      // zweiter Lauf derselben Migration (z. B. nach Umnummerierung): idempotent, gleiche Meldung
      const stmts = readFileSync(path.join(DRIZZLE, `${tag}.sql`), "utf8").split("--> statement-breakpoint");
      notices.length = 0;
      const again = await ns.connect();
      try {
        await again.query("begin");
        for (const st of stmts) await again.query(st);
        await again.query("commit");
      } finally {
        again.release();
      }
      expect(notices.join("\n")).toMatch(/1 Zeile\(n\) in tasks\.assignee_id verweisen auf eine Person außerhalb der Praxis/);
      const fn = (await ns.query("select pg_get_userbyid(proowner) as owner, prosecdef, proconfig from pg_proc where proname = 'podo_user_in_org'")).rows[0];
      expect(fn).toEqual({ owner: role, prosecdef: true, proconfig: ["search_path=pg_catalog, public, pg_temp"] });
      expect((await ns.query("select proconfig from pg_proc where proname = 'podo_invoice_lines_guard'")).rows[0].proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      // jede eigene Funktion (DEFINER und INVOKER) im Schema public, ohne Erweiterungen (pgcrypto, pg_trgm)
      const defs = await ns.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        order by p.proname`);
      const rows = defs.rows as { proname: string; prosecdef: boolean; proconfig: string[] | null }[];
      expect(rows.filter((r) => r.prosecdef).length).toBeGreaterThanOrEqual(6);
      expect(rows.length).toBeGreaterThanOrEqual(30);
      for (const r of rows) expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, public, pg_temp");
      // Trigger greift für den Nicht-Superuser-Owner (FORCE RLS gilt für ihn)
      const err = await inOrg(orgA, "insert into tasks (organization_id, title, assignee_id) values ($1,'Neu',$2)", [orgA, userB]);
      expect(err?.code).toBe("23503");
      expect(await inOrg(orgA, "insert into tasks (organization_id, title, assignee_id) values ($1,'Neu',$2)", [orgA, userA])).toBeNull();
      // Support-Pfad liest support_grants (RLS + FORCE) – auch hier unter dem Owner ohne BYPASSRLS
      const patient = await (async () => {
        const cl = await ns.connect();
        try {
          await cl.query("begin");
          await cl.query("select set_config('app.org_id', $1, true)", [orgA]);
          const p = (await cl.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Muster') returning id", [orgA])).rows[0].id as string;
          await cl.query("commit");
          return p;
        } finally {
          cl.release();
        }
      })();
      const consent = "insert into consents (organization_id, patient_id, type, granted, recorded_by) values ($1,$2,'marketing',true,$3)";
      expect((await inOrg(orgA, consent, [orgA, patient, admin]))?.code).toBe("23503");
      expect(
        await inOrg(orgA, "insert into support_grants (organization_id, granted_by, grantee_user_id, reason, scope, expires_at) values ($1,$2,$3,'Ticket','read', now() + interval '1 hour')", [orgA, userA, admin]),
      ).toBeNull();
      expect(await inOrg(orgA, consent, [orgA, patient, admin])).toBeNull();
    } finally {
      await ns.end();
      rmSync(tmp, { recursive: true, force: true });
      await owner.query(`drop database if exists ${dbName} with (force)`);
      await owner.query(`drop role if exists ${role}`);
    }
  }, 180_000);
});
