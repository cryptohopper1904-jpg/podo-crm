/**
 * Fremdschlüssel nur innerhalb derselben Praxis (Migration 0050, AppSec-Befund „fremde patientId“) gegen eine echte
 * DB (App-Rolle, RLS aktiv, erfundene Daten): Trigger je abgesicherter Spalte (fremd abgelehnt, eigen erlaubt),
 * Vollständigkeit gegenüber allen Fremdschlüsseln zwischen Praxis-Tabellen, UPDATE-Verhalten/Altbestand,
 * App-Prüfung in Terminanlage und Einwilligung, Migration mit Nicht-Superuser-Owner.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrlFrom = (url: string) => url.replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
const DRIZZLE = path.join(__dirname, "../../drizzle");
const FOREIGN = /gehört nicht zu dieser Praxis/;

type World = Record<string, string>;
type Case = { table: string; col: string; target: string; insert: (w: World, ref: string) => [string, unknown[]] };

/** Je abgesicherter Spalte: minimale Zeile, die getestete Spalte zeigt auf `ref`, alle übrigen Verweise auf die eigene Praxis. */
const CASES: Case[] = [
  ...(["patient_id", "location_id"] as const).map((col) => ({
    table: "appointments",
    col,
    target: col === "patient_id" ? "patients" : "locations",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into appointments (organization_id, patient_id, location_id, starts_at, ends_at) values ($1,$2,$3, now(), now() + interval '30 minutes')",
      [w.org, col === "patient_id" ? ref : w.patient, col === "location_id" ? ref : w.location],
    ],
  })),
  ...(["appointment_id", "service_id"] as const).map((col) => ({
    table: "appointment_services",
    col,
    target: col === "appointment_id" ? "appointments" : "services",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)",
      [w.org, col === "appointment_id" ? ref : w.appointment, col === "service_id" ? ref : w.service],
    ],
  })),
  { table: "consents", col: "patient_id", target: "patients", insert: (w, ref) => ["insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'privacy_notice',true)", [w.org, ref]] },
  { table: "anamneses", col: "patient_id", target: "patients", insert: (w, ref) => ["insert into anamneses (organization_id, patient_id, data) values ($1,$2,'{}')", [w.org, ref]] },
  {
    table: "brace_episodes",
    col: "patient_id",
    target: "patients",
    insert: (w, ref) => ["insert into brace_episodes (organization_id, patient_id, side, toe, started_at) values ($1,$2,'left',1,'2026-01-05')", [w.org, ref]],
  },
  {
    table: "messages",
    col: "patient_id",
    target: "patients",
    insert: (w, ref) => ["insert into messages (organization_id, patient_id, channel, direction, body) values ($1,$2,'email','inbound','Hallo')", [w.org, ref]],
  },
  {
    table: "prescriptions",
    col: "patient_id",
    target: "patients",
    insert: (w, ref) => ["insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,'2026-01-05','DF',6)", [w.org, ref]],
  },
  { table: "tasks", col: "patient_id", target: "patients", insert: (w, ref) => ["insert into tasks (organization_id, patient_id, title) values ($1,$2,'Rückruf')", [w.org, ref]] },
  { table: "waitlist", col: "patient_id", target: "patients", insert: (w, ref) => ["insert into waitlist (organization_id, patient_id) values ($1,$2)", [w.org, ref]] },
  ...(["patient_id", "appointment_id"] as const).map((col) => ({
    table: "patient_links",
    col,
    target: col === "patient_id" ? "patients" : "appointments",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into patient_links (organization_id, patient_id, appointment_id, purpose, token_hash, expires_at) values ($1,$2,$3,'portal',md5(random()::text), now() + interval '1 day')",
      [w.org, col === "patient_id" ? ref : w.patient, col === "appointment_id" ? ref : w.appointment],
    ],
  })),
  ...(["patient_id", "appointment_id"] as const).map((col) => ({
    table: "reminder_log",
    col,
    target: col === "patient_id" ? "patients" : "appointments",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into reminder_log (organization_id, patient_id, appointment_id, kind, channel, status, dedupe_key) values ($1,$2,$3,'reminder','email','sent',md5(random()::text))",
      [w.org, col === "patient_id" ? ref : w.patient, col === "appointment_id" ? ref : w.appointment],
    ],
  })),
  ...(["patient_id", "appointment_id"] as const).map((col) => ({
    table: "voice_calls",
    col,
    target: col === "patient_id" ? "patients" : "appointments",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into voice_calls (organization_id, patient_id, appointment_id, provider, external_id, started_at) values ($1,$2,$3,'mock',md5(random()::text), now())",
      [w.org, col === "patient_id" ? ref : w.patient, col === "appointment_id" ? ref : w.appointment],
    ],
  })),
  {
    table: "calendar_feed_events",
    col: "appointment_id",
    target: "appointments",
    insert: (w, ref) => [
      "insert into calendar_feed_events (organization_id, feed_id, appointment_id, event_key, hash, applied_hash) values ($1,$2,$3,md5(random()::text),'h','h')",
      [w.org, w.feed, ref],
    ],
  },
  ...(["patient_id", "appointment_id", "prescription_id"] as const).map((col) => ({
    table: "treatment_records",
    col,
    target: { patient_id: "patients", appointment_id: "appointments", prescription_id: "prescriptions" }[col],
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into treatment_records (organization_id, patient_id, appointment_id, prescription_id, author_id, treated_at, hash, prev_hash) values ($1,$2,$3,$4,$5, now(), md5(random()::text), md5(random()::text))",
      [w.org, col === "patient_id" ? ref : w.patient, col === "appointment_id" ? ref : w.appointment, col === "prescription_id" ? ref : w.prescription, w.user],
    ],
  })),
  {
    table: "record_addenda",
    col: "record_id",
    target: "treatment_records",
    insert: (w, ref) => ["insert into record_addenda (organization_id, record_id, author_id, text, hash) values ($1,$2,$3,'Nachtrag',md5(random()::text))", [w.org, ref, w.user]],
  },
  ...(["patient_id", "record_id", "brace_episode_id"] as const).map((col) => ({
    table: "media",
    col,
    target: { patient_id: "patients", record_id: "treatment_records", brace_episode_id: "brace_episodes" }[col],
    insert: (w: World, ref: string): [string, unknown[]] => [
      `insert into media (organization_id, patient_id, record_id, brace_episode_id, kind, purpose, storage_key, mime, size_bytes, sha256, uploaded_by)
       values ($1,$2,$3,$4,'photo','finding',$6,'image/jpeg',4,repeat('a',64),$5)`,
      [w.org, col === "patient_id" ? ref : w.patient, col === "record_id" ? ref : w.record, col === "brace_episode_id" ? ref : w.brace, w.user, `${w.org}/${randomUUID()}.bin`],
    ],
  })),
  ...(["patient_id", "billing_contact_id"] as const).map((col) => ({
    table: "invoices",
    col,
    target: col === "patient_id" ? "patients" : "billing_contacts",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into invoices (organization_id, patient_id, billing_contact_id, status) values ($1,$2,$3,'draft')",
      [w.org, col === "patient_id" ? ref : w.patient, col === "billing_contact_id" ? ref : w.contact],
    ],
  })),
  ...(["invoice_id", "service_id", "treatment_record_id"] as const).map((col) => ({
    table: "invoice_lines",
    col,
    target: { invoice_id: "invoices", service_id: "services", treatment_record_id: "treatment_records" }[col],
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into invoice_lines (organization_id, invoice_id, service_id, treatment_record_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,$3,$4,'Behandlung',6500,6500,0,1)",
      [w.org, col === "invoice_id" ? ref : w.invoice, col === "service_id" ? ref : w.service, col === "treatment_record_id" ? ref : w.record],
    ],
  })),
  ...(["care_home_id", "billing_contact_id"] as const).map((col) => ({
    table: "patients",
    col,
    target: "billing_contacts",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into patients (organization_id, number, last_name, care_home_id, billing_contact_id) values ($1,(select coalesce(max(number),0)+1 from patients where organization_id = $1),'Muster',$2,$3)",
      [w.org, col === "care_home_id" ? ref : w.contact, col === "billing_contact_id" ? ref : w.contact],
    ],
  })),
  ...(["invoice_id", "voucher_id"] as const).map((col) => ({
    table: "payments",
    col,
    target: col === "invoice_id" ? "invoices" : "vouchers",
    insert: (w: World, ref: string): [string, unknown[]] => [
      "insert into payments (organization_id, invoice_id, voucher_id, method, amount_cents) values ($1,$2,$3,'voucher',100)",
      [w.org, col === "invoice_id" ? ref : w.invoice, col === "voucher_id" ? ref : w.voucher],
    ],
  })),
  {
    table: "device_events",
    col: "device_id",
    target: "devices",
    insert: (w, ref) => ["insert into device_events (organization_id, device_id, kind, occurred_at) values ($1,$2,'wartung','2026-01-05')", [w.org, ref]],
  },
];

/**
 * Fremdschlüssel zwischen Praxis-Tabellen, die schon vor 0050 ein eigener Trigger auf dieselbe Praxis prüft
 * (Migrationen 0015/0017/0022/0024/0026/0036/0034/0049). Neue Fremdschlüssel müssen hier oder in 0050ff. landen.
 */
const OTHER_GUARDS = [
  "calendar_feed_events.feed_id",
  "cash_closing_registrations.cash_closing_id",
  "cash_movements.cash_closing_id",
  "document_archive.invoice_id",
  "document_archive.payment_receipt_id",
  "fiscal_transactions.payment_id",
  "invoice_credits.credited_invoice_id",
  "invoice_credits.invoice_id",
  "invoice_dunnings.invoice_id",
  "invoice_lines.appointment_id",
  "invoice_lines.product_id",
  "payment_receipts.invoice_id",
  "payment_receipts.payment_id",
  "payments.cash_closing_id",
  "products.supplier_id",
  "stock_movements.invoice_id",
  "stock_movements.product_id",
  "stock_movements.supplier_id",
  "trip_corrections.trip_id",
];

async function pgCode(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { code?: string; message: string };
  }
}

(TEST_DB ? describe : describe.skip)("Fremdschlüssel nur innerhalb der Praxis (DB, Migration 0050)", () => {
  const f = fixtures(TEST_DB!);
  const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? "");
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  let ap: typeof import("./appointments");
  let cons: typeof import("./consents");
  let route: typeof import("./patient-route");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    ap = await import("./appointments");
    cons = await import("./consents");
    route = await import("./patient-route");
  });
  afterAll(async () => {
    await f.end();
    await owner.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  /** Praxis mit je einem Datensatz jeder Zieltabelle */
  async function world(): Promise<World> {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const patient = await f.patient(org);
    return f.asOrg(org, async (c) => {
      const id = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].id as string;
      const location = await id("insert into locations (organization_id, name) values ($1,'Praxis') returning id", [org]);
      const service = await id("insert into services (organization_id, code, name, price_cents) values ($1,'PB','Podologische Behandlung',6500) returning id", [org]);
      const contact = await id("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Haus am See') returning id", [org]);
      const appointment = await id("insert into appointments (organization_id, patient_id, starts_at, ends_at) values ($1,$2, now(), now() + interval '30 minutes') returning id", [
        org,
        patient,
      ]);
      const invoice = await id("insert into invoices (organization_id, patient_id, status) values ($1,$2,'draft') returning id", [org, patient]);
      const prescription = await id(
        "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,'2026-01-05','DF',6) returning id",
        [org, patient],
      );
      const record = await id(
        "insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3, now(), md5(random()::text)) returning id",
        [org, patient, user],
      );
      const brace = await id("insert into brace_episodes (organization_id, patient_id, side, toe, started_at) values ($1,$2,'left',1,'2026-01-05') returning id", [org, patient]);
      const voucher = await id(
        "insert into vouchers (organization_id, code, issued_at, valid_until, amount_cents) values ($1, md5(random()::text), '2026-01-05', '2030-01-05', 5000) returning id",
        [org],
      );
      const device = await id("insert into devices (organization_id, name) values ($1,'Autoklav') returning id", [org]);
      const feed = await id(
        "insert into calendar_feeds (organization_id, label, url_enc, url_hint, therapist_id, source) values ($1,'Doctolib','x','calendar.example.org/…',$2,'doctolib') returning id",
        [org, user],
      );
      return { org, user, patient, location, service, contact, appointment, invoice, prescription, record, brace, voucher, device, feed };
    });
  }
  /** Einfügen im Praxis-Kontext und immer zurückrollen (keine Nebenwirkungen wie eindeutige aktive Links) – Fehler oder null */
  async function tryInsert(org: string, sql: string, params: unknown[]) {
    const c = await f.pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      return await pgCode(c.query(sql, params));
    } finally {
      await c.query("rollback");
      c.release();
    }
  }
  /** Schlüssel der World je Zieltabelle */
  const KEY: Record<string, string> = {
    patients: "patient",
    locations: "location",
    services: "service",
    billing_contacts: "contact",
    appointments: "appointment",
    invoices: "invoice",
    prescriptions: "prescription",
    treatment_records: "record",
    brace_episodes: "brace",
    vouchers: "voucher",
    devices: "device",
  };

  it("jede abgesicherte Spalte: Verweis in eine fremde Praxis abgelehnt (23503), eigener erlaubt", async () => {
    const a = await world();
    const b = await world();
    for (const c of CASES) {
      const label = `${c.table}.${c.col}`;
      const foreign = b[KEY[c.target]];
      expect(foreign, label).toBeTruthy();
      const err = await tryInsert(a.org, ...c.insert(a, foreign));
      expect(err?.code, `${label}: fremd`).toBe("23503");
      expect(err?.message, label).toMatch(FOREIGN);
      // eigener Verweis funktioniert (gleiche Zeile, nur die getestete Spalte auf die eigene Praxis)
      const ok = await tryInsert(a.org, ...c.insert(a, a[KEY[c.target]]));
      expect(ok, `${label}: eigen`).toBeNull();
    }
  }, 60_000);

  it("Vollständigkeit: Testfälle = Trigger-Argumente; jeder Fremdschlüssel zwischen Praxis-Tabellen ist abgesichert", async () => {
    const trig = await owner.query(`select tgrelid::regclass::text as src, encode(tgargs, 'escape') as raw
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'podo_fk_same_org' and not t.tgisinternal`);
    const covered: string[] = [];
    for (const r of trig.rows as { src: string; raw: string }[]) {
      const args = r.raw.replace(/\\000$/, "").split("\\000");
      for (let i = 0; i + 1 < args.length; i += 2) covered.push(`${r.src}.${args[i]}→${args[i + 1]}`);
    }
    expect(covered.sort()).toEqual(CASES.map((c) => `${c.table}.${c.col}→${c.target}`).sort());

    const fks = await owner.query(`select c.conrelid::regclass::text as src, a.attname as col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace and a.attname <> 'organization_id'
        and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'organization_id')
        and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'organization_id')`);
    const mine = new Set(CASES.map((c) => `${c.table}.${c.col}`));
    const missing = (fks.rows as { src: string; col: string }[]).map((r) => `${r.src}.${r.col}`).filter((k) => !mine.has(k) && !OTHER_GUARDS.includes(k));
    expect(missing).toEqual([]);
  });

  it("UPDATE: Wechsel auf fremde Patient:in abgelehnt; Kontext app.org_id des Aufrufers bleibt erhalten", async () => {
    const a = await world();
    const b = await world();
    const err = await pgCode(f.asOrg(a.org, (c) => c.query("update appointments set patient_id = $2 where id = $1", [a.appointment, b.patient])));
    expect(err?.code).toBe("23503");
    expect(err?.message).toMatch(/Patient:in gehört nicht zu dieser Praxis/);
    // eigene Person: erlaubt; danach steht app.org_id weiter auf der eigenen Praxis
    const setting = await f.asOrg(a.org, async (c) => {
      await c.query("update appointments set patient_id = $2 where id = $1", [a.appointment, a.patient]);
      await c.query("insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'marketing',true)", [a.org, a.patient]);
      return (await c.query("select current_setting('app.org_id', true) as v")).rows[0].v as string;
    });
    expect(setting).toBe(a.org);
    // ohne Org-Kontext (z. B. Owner-Wartung als Superuser): Prüfung trotzdem anhand der Praxis der Zeile
    const owners = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (owners.rows[0]?.rolsuper) {
      const e2 = await pgCode(owner.query("update appointments set patient_id = $2 where id = $1", [a.appointment, b.patient]));
      expect(e2?.code).toBe("23503");
      await owner.query("update appointments set patient_id = null where id = $1", [a.appointment]);
    }
  });

  it("kein Orakel: Zeile für eine fremde Praxis im eigenen Kontext immer gleich abgelehnt (vor jedem Lookup)", async () => {
    const a = await world();
    const b = await world();
    const sql = "insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'privacy_notice',true)";
    // B-Zeile mit B-Person und B-Zeile mit unbekannter Person: dieselbe Antwort – verrät nicht, wem die Person gehört
    const e1 = await tryInsert(a.org, sql, [b.org, b.patient]);
    const e2 = await tryInsert(a.org, sql, [b.org, randomUUID()]);
    expect(e1?.code).toBe("42501");
    expect(e2?.code).toBe("42501");
    expect(e1?.message).toBe(e2?.message);
  });

  it("Altbestand: inkonsistente Zeile bleibt bearbeitbar, solange der Verweis nicht geändert wird", async (ctx) => {
    const su = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (!su.rows[0]?.rolsuper) ctx.skip(); // Altbestand nachstellen braucht session_replication_role (Superuser)
    const a = await world();
    const b = await world();
    // Altzeile wie vor 0050: Termin in A zeigt auf Person aus B (Trigger beim Nachstellen aus)
    const c: PoolClient = await owner.connect();
    let legacy: string;
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      legacy = (
        await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at) values ($1,$2, now(), now() + interval '1 hour') returning id", [a.org, b.patient])
      ).rows[0].id;
      await c.query("commit");
    } finally {
      c.release();
    }
    // unabhängige Änderung (Status/Notiz, auch mit patient_id im SET ohne Wertänderung): erlaubt
    expect(await pgCode(f.asOrg(a.org, (cl) => cl.query("update appointments set notes = 'verschoben', status = 'cancelled' where id = $1", [legacy])))).toBeNull();
    expect(await pgCode(f.asOrg(a.org, (cl) => cl.query("update appointments set patient_id = patient_id, notes = 'x' where id = $1", [legacy])))).toBeNull();
    // Korrektur auf die eigene Person: erlaubt
    expect(await pgCode(f.asOrg(a.org, (cl) => cl.query("update appointments set patient_id = $2 where id = $1", [legacy, a.patient])))).toBeNull();
  });

  it("App: Terminanlage mit fremder Patient:in → verständliche Meldung, nichts angelegt; eigene funktioniert", async () => {
    const a = await world();
    const b = await world();
    const input = (patientId: string | null) => ({
      patientId,
      therapistId: a.user,
      occurrences: [new Date("2031-06-02T08:00:00Z")],
      durationMin: 30,
      source: "phone" as const,
      title: "Behandlung",
      notes: null,
      homeVisit: false,
      serviceIds: [],
      allowConflict: true,
    });
    const before = await f.asOrg(a.org, async (c) => (await c.query("select count(*)::int as n from appointments")).rows[0].n as number);
    expect(await ap.createInternalAppointments(a.org, input(b.patient))).toEqual({ ok: false, error: route.PATIENT_NOT_IN_ORG_MSG });
    expect(await ap.createInternalAppointments(a.org, input("kein-uuid"))).toEqual({ ok: false, error: route.PATIENT_NOT_IN_ORG_MSG });
    expect(await f.asOrg(a.org, async (c) => (await c.query("select count(*)::int as n from appointments")).rows[0].n)).toBe(before);
    const ok = await ap.createInternalAppointments(a.org, input(a.patient));
    expect(ok).toMatchObject({ ok: true });
    expect(await ap.createInternalAppointments(a.org, input(null))).toMatchObject({ ok: true });
  });

  it("App: Einwilligung mit fremder Patient:in oder unbekannter Art abgelehnt; eigene gespeichert", async () => {
    const a = await world();
    const b = await world();
    const base = { type: "photo_documentation", granted: true, via: "praxis", recordedBy: a.user };
    expect(await cons.recordConsent(a.org, { ...base, patientId: b.patient })).toEqual({ ok: false, error: route.PATIENT_NOT_IN_ORG_MSG });
    expect(await cons.recordConsent(a.org, { ...base, patientId: "x" })).toEqual({ ok: false, error: route.PATIENT_NOT_IN_ORG_MSG });
    expect(await cons.recordConsent(a.org, { ...base, patientId: a.patient, type: "gibt_es_nicht" })).toEqual({ ok: false, error: "Unbekannte Einwilligung." });
    expect(await cons.recordConsent(a.org, { ...base, patientId: a.patient })).toEqual({ ok: true });
    const rows = await f.asOrg(b.org, async (c) => (await c.query("select count(*)::int as n from consents where patient_id = $1", [b.patient])).rows[0].n);
    expect(rows).toBe(0);
    const own = await f.asOrg(a.org, async (c) => (await c.query("select type, granted from consents where patient_id = $1", [a.patient])).rows);
    expect(own).toEqual([{ type: "photo_documentation", granted: true }]);
  });

  it("Migration mit Nicht-Superuser-Owner (FORCE RLS gilt für ihn): läuft, meldet Altbestand, Trigger greift", async (ctx) => {
    const su = await owner.query("select rolsuper from pg_roles where rolname = current_user");
    if (!su.rows[0]?.rolsuper) ctx.skip(); // Rolle/Datenbank anlegen braucht einen Superuser (TEST_OWNER_DATABASE_URL)
    const sfx = Math.random().toString(36).slice(2, 8);
    const role = `podo_ns_${sfx}`;
    const dbName = `podo_ns_${sfx}`;
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
    try {
      await suDb.query("create extension if not exists pgcrypto");
      await suDb.query("create extension if not exists pg_trgm");
      await suDb.end();
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      // Stand vor 0050: Ordner kopieren, Journal kürzen
      const before = path.join(tmp, "drizzle");
      cpSync(DRIZZLE, before, { recursive: true });
      const journalPath = path.join(before, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
      const idx = journal.entries.findIndex((e) => e.tag.startsWith("0050_"));
      expect(idx).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, idx);
      writeFileSync(journalPath, JSON.stringify(journal));
      await migrate(drizzle(ns), { migrationsFolder: before });
      // Altbestand (vor 0050 möglich): Termin in A zeigt auf Person aus B – als Nicht-Superuser je Praxis-Kontext
      const c = await ns.connect();
      let orgA: string;
      let pa: string;
      let pb: string;
      try {
        await c.query("begin");
        orgA = (await c.query("insert into organizations (name, slug) values ('A', $1) returning id", [`a-${sfx}`])).rows[0].id;
        const orgB = (await c.query("insert into organizations (name, slug) values ('B', $1) returning id", [`b-${sfx}`])).rows[0].id;
        await c.query("select set_config('app.org_id', $1, true)", [orgB]);
        pb = (await c.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Fremd') returning id", [orgB])).rows[0].id;
        await c.query("select set_config('app.org_id', $1, true)", [orgA]);
        pa = (await c.query("insert into patients (organization_id, number, last_name) values ($1, 1, 'Eigen') returning id", [orgA])).rows[0].id;
        await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at) values ($1,$2, now(), now() + interval '1 hour')", [orgA, pb]);
        await c.query("commit");
      } finally {
        c.release();
      }
      notices.length = 0;
      await migrate(drizzle(ns), { migrationsFolder: DRIZZLE });
      expect(notices.join("\n")).toMatch(/1 Zeile\(n\) in appointments\.patient_id verweisen auf patients einer anderen Praxis/);
      const fn = (await ns.query("select pg_get_userbyid(proowner) as owner, prosecdef from pg_proc where proname = 'podo_fk_same_org'")).rows[0];
      expect(fn).toEqual({ owner: role, prosecdef: true });
      // Trigger greift auch hier (Owner unterliegt FORCE RLS; Funktion setzt den Kontext selbst)
      const tryInsert = async (patient: string) => {
        const cl = await ns.connect();
        try {
          await cl.query("begin");
          await cl.query("select set_config('app.org_id', $1, true)", [orgA]);
          await cl.query("insert into consents (organization_id, patient_id, type, granted) values ($1,$2,'privacy_notice',true)", [orgA, patient]);
          await cl.query("commit");
          return null;
        } catch (e) {
          await cl.query("rollback");
          return e as { code?: string; message: string };
        } finally {
          cl.release();
        }
      };
      const err = await tryInsert(pb);
      expect(err?.code).toBe("23503");
      expect(err?.message).toMatch(/Patient:in gehört nicht zu dieser Praxis/);
      expect(await tryInsert(pa)).toBeNull();
    } finally {
      await ns.end();
      rmSync(tmp, { recursive: true, force: true });
      await owner.query(`drop database if exists ${dbName} with (force)`);
      await owner.query(`drop role if exists ${role}`);
    }
  }, 180_000);
});
