/**
 * GKV-Grundlagen (Paket A, docs/GKV.md) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten):
 * Migration 0061 (payerIk → insurer_ik, idempotent), „Frist überschritten“ automatisch, Buchungssperre bei
 * abgelaufener Verordnung, Preis-Snapshot bei Abrechnungsreife + Heilmittelkosten im Abrechnungslauf,
 * Befreiungsbescheinigung je Tag, Termin mit Verordnung und Planungswarnungen.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// Server Actions (Besuchstag) mit dem Test-Kontext aufrufen
const session = vi.hoisted(() => ({ auth: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ requireAuth: async () => session.auth }));
import { audit } from "@/lib/audit";
import { addDaysIso } from "@/lib/calendar-grid";
import { berlinDateIso, berlinToUtc } from "@/lib/format";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const ownerUrl = () => process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");
const MIGRATION = readdirSync(path.join(__dirname, "../../drizzle")).find((f) => f.endsWith("_gkv_grundlagen.sql"))!;

(TEST_DB ? describe : describe.skip)("GKV-Grundlagen (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let org: string, user: string, patient: string;
  let auth: never;
  let presc: typeof import("./prescriptions");
  let records: typeof import("./records");
  let appts: typeof import("./appointments");
  let planning: typeof import("./appointment-prescriptions");
  let exemptions: typeof import("./copayment-exemptions");
  let dbm: typeof import("@/db");
  const today = berlinDateIso();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    org = await fx.org();
    user = await fx.user(org);
    patient = await fx.patient(org, { lastName: "Kasse", firstName: "Erika" });
    await fx.asOrg(org, (c) => c.query("update patients set birth_date = '1950-03-01', insurance_type = 'gkv' where id = $1", [patient]));
    await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    auth = { organization: { id: org, name: "T", slug: "t", smallBusiness: false, state: "BB", billingMode: "with_gkv" }, user: { id: user, name: "Test" }, role: "owner", can: () => true } as never;
    session.auth = auth;
    presc = await import("./prescriptions");
    records = await import("./records");
    appts = await import("./appointments");
    planning = await import("./appointment-prescriptions");
    exemptions = await import("./copayment-exemptions");
    dbm = await import("@/db");
  });

  afterAll(async () => {
    await fx.end();
    await (globalThis as unknown as { pool?: Pool }).pool?.end();
  });

  const vo = (v: { issuedAt: string; units?: number; status?: string; group?: string; rules?: string | null; frequency?: string | null }) =>
    fx.asOrg(org, async (c) =>
      (
        await c.query(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, frequency_per_week, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, prescription_kind, prescription_kind_confirmed_at)
           values ($1,$2,$3,$4,$5,$6,($3::date + 28),$7,$8,$9,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c','03',now()) returning id`,
          [org, patient, v.issuedAt, v.group ?? "DF", v.units ?? 2, v.status ?? "open", JSON.stringify([{ position: "78020", label: "groß", units: v.units ?? 2 }]), v.frequency ?? "1x alle 4-6 Wochen", v.rules === undefined ? RULES_VERSION : v.rules],
        )
      ).rows[0].id as string,
    );

  /** Paket B: alle Behandlungen einer Verordnung mit Papier-Vermerk bestätigen (sonst nicht abrechnungsreif) */
  const signAll = (prescriptionId: string) =>
    fx.asOrg(org, (c) =>
      c.query(
        `insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by)
         select t.organization_id, t.id, t.patient_id, t.prescription_id, 'paper', $2 from treatment_records t
          where t.prescription_id = $1 and not exists (select 1 from treatment_signatures s where s.record_id = t.id)`,
        [prescriptionId, user],
      ),
    );

  /** vergangene Behandlung direkt anlegen (insertTreatmentRecord bucht immer „jetzt“) */
  const pastRecord = (prescriptionId: string, day: string, p = patient) =>
    fx.asOrg(org, (c) =>
      c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prescription_id, hash) values ($1,$2,$3,$4,$5,$6)", [org, p, user, berlinToUtc(day, "10:00"), prescriptionId, `h-${Math.random()}`]),
    );
  /**
   * Migration (z. B. 0062) zweimal einspielen – in einer EIGENEN, frisch migrierten Datenbank (Review Runde 4): parallel
   * laufende Testdateien in der gemeinsamen DB sehen so nie die alte Fassung ersetzter Funktionen oder fehlende Trigger
   * späterer Migrationen und laufen nicht in Sperren/Deadlocks der DDL. `before` stellt Altbestand dort nach (Owner),
   * `after` prüft das Ergebnis dort. Ohne Recht CREATE DATABASE `false` (Test überspringen); mit `superuser` (Altbestand per
   * session_replication_role = replica) auch ohne Superuser `false`. Danach wird die DB gelöscht – gelingt das endgültig
   * nicht, Warnung mit dem DB-Namen (von Hand aufräumen).
   */
  const runMigration = async (
    suffix: string,
    hooks: { before?: (c: PoolClient) => Promise<void>; after?: (c: PoolClient) => Promise<void>; superuser?: boolean } = {},
  ): Promise<boolean> => {
    const dir = path.join(__dirname, "../../drizzle");
    const file = readdirSync(dir).find((f) => f.endsWith(suffix))!;
    const sql = readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint");
    const name = `podo_mig_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new Pool({ connectionString: ownerUrl(), max: 1 });
    admin.on("error", () => undefined);
    let created = false;
    try {
      const can = await admin.query("select rolsuper, rolsuper or rolcreatedb as ok from pg_roles where rolname = current_user");
      if (!can.rows[0]?.ok || (hooks.superuser && !can.rows[0]?.rolsuper)) return false;
      await admin.query(`create database ${name}`);
      created = true;
      const url = new URL(ownerUrl());
      url.pathname = `/${name}`;
      const pool = new Pool({ connectionString: url.toString(), max: 1 });
      // Verbindungsfehler beim Abbau (Server beendet die Sitzung) nicht als „uncaught“ melden
      pool.on("error", () => undefined);
      try {
        await pool.query("create extension if not exists pgcrypto");
        await pool.query("create extension if not exists pg_trgm");
        await migrate(drizzle(pool), { migrationsFolder: dir });
        const c = await pool.connect();
        try {
          await hooks.before?.(c);
          for (let run = 0; run < 2; run++) for (const stmt of sql) if (stmt.trim()) await c.query(stmt);
          await hooks.after?.(c);
        } finally {
          c.release();
        }
      } finally {
        await pool.end();
      }
      return true;
    } finally {
      // ohne FORCE (das beendete in der CI eine noch schließende Sitzung → „uncaught“ 57P01); kurz warten, bis sie weg ist
      let dropError: unknown = null;
      for (let i = 0; created && i < 20; i++) {
        try {
          await admin.query(`drop database if exists ${name}`);
          dropError = null;
          break;
        } catch (e) {
          dropError = e;
          if ((e as { code?: string }).code !== "55006") break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (dropError) console.warn(`Test-Datenbank ${name} konnte nicht gelöscht werden (bitte von Hand: DROP DATABASE ${name}):`, (dropError as Error).message);
      await admin.end();
    }
  };

  it("Migration 0062 ist wiederholbar (idempotent)", { timeout: 120_000 }, async (ctx) => {
    if (!(await runMigration("_gkv_review.sql"))) ctx.skip();
  });

  it("Migration 0067 ist wiederholbar (idempotent); Funktionen mit festem search_path, ohne PUBLIC-Recht", { timeout: 120_000 }, async (ctx) => {
    const ran = await runMigration("_gkv_haertung.sql", {
      after: async (c) => {
        const fns = await c.query(
          "select proname, proconfig, has_function_privilege('public', oid, 'execute') as pub from pg_proc where proname in ('podo_billing_batch_sum_check', 'podo_prescription_delete_guard', 'podo_delete_patient', 'podo_owner_delete_allowed') order by proname",
        );
        expect(fns.rows).toEqual(
          ["podo_billing_batch_sum_check", "podo_delete_patient", "podo_owner_delete_allowed", "podo_prescription_delete_guard"].map((proname) => ({ proname, proconfig: ["search_path=pg_catalog, public, pg_temp"], pub: false })),
        );
        const trg = await c.query("select tgname, tgdeferrable, tginitdeferred from pg_trigger where tgname in ('billing_batches_sum_check', 'prescriptions_batch_sum_check_insert', 'prescriptions_batch_sum_check_update', 'prescriptions_delete_guard') order by tgname");
        expect(trg.rows).toEqual([
          { tgname: "billing_batches_sum_check", tgdeferrable: true, tginitdeferred: true },
          { tgname: "prescriptions_batch_sum_check_insert", tgdeferrable: true, tginitdeferred: true },
          { tgname: "prescriptions_batch_sum_check_update", tgdeferrable: true, tginitdeferred: true },
          { tgname: "prescriptions_delete_guard", tgdeferrable: false, tginitdeferred: false },
        ]);
        // Löschfreigabe: Schema ohne PUBLIC-Rechte
        const priv = await c.query("select has_schema_privilege('public', 'podo_private', 'usage') as usage");
        expect(priv.rows).toEqual([{ usage: false }]);
      },
    });
    if (!ran) ctx.skip();
  });

  it("Migration: payerIk aus extra in insurer_ik übernommen, ungültige bleiben, wiederholbar", { timeout: 120_000 }, async (ctx) => {
    // in eigener, frisch migrierter DB (runMigration) – keine DDL/Datenmigration auf der gemeinsamen Test-DB
    let p1 = "";
    let p2 = "";
    const ran = await runMigration(MIGRATION, {
      // Altbestand per session_replication_role = replica – braucht einen Superuser (nicht nur CREATE DATABASE)
      superuser: true,
      before: async (c) => {
        await c.query("set session_replication_role = replica");
        const o = (await c.query("insert into organizations (name, slug) values ('Praxis', $1) returning id", [`m-${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
        const ins = "insert into patients (organization_id, number, last_name, extra) values ($1, $2, $3, $4) returning id";
        p1 = (await c.query(ins, [o, 1, "Alt1", '{"payerIk":"109911114","gender":"female","insuranceStatus":"5000000"}'])).rows[0].id;
        p2 = (await c.query(ins, [o, 2, "Alt2", '{"payerIk":"12AB"}'])).rows[0].id;
        await c.query("update patients set insurer_ik = null, insured_status = null where id = any($1)", [[p1, p2]]);
        await c.query("set session_replication_role = origin");
      },
      after: async (c) => {
        const rows = (await c.query("select id, insurer_ik, insured_status, extra from patients where id = any($1)", [[p1, p2]])).rows;
        const a = rows.find((r) => r.id === p1)!;
        const b = rows.find((r) => r.id === p2)!;
        expect(a.insurer_ik).toBe("109911114");
        expect(a.insured_status).toBe("5");
        expect(a.extra).toEqual({ gender: "female", insuranceStatus: "5000000" });
        expect(b.insurer_ik).toBeNull();
        expect(b.extra).toEqual({ payerIk: "12AB" });
      },
    });
    if (!ran) ctx.skip();
  });

  it("abgelaufene Verordnung: Buchung abgelehnt, beim Lesen „Frist überschritten“ (nicht gelöscht)", async () => {
    const id = await vo({ issuedAt: addDaysIso(today, -40) });
    await expect(
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" })),
    ).rejects.toThrow(/Frist überschritten/);
    const data = await presc.listPatientPrescriptions(auth, patient);
    const row = data!.prescriptions.find((r) => r.id === id)!;
    expect(row.status).toBe("expired");
    expect(row.expiredReason).toBe("start_missed");
  });

  it("Pflichtangaben fehlen (Stempel/Unterschrift) → Behandlung darf nicht beginnen", async () => {
    const id = await vo({ issuedAt: today });
    await fx.asOrg(org, (c) => c.query("update prescriptions set doctor_signed = false where id = $1", [id]));
    await expect(
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" })),
    ).rejects.toThrow(/Arztstempel und Unterschrift/);
  });

  it("Preis-Snapshot bei Abrechnungsreife, Befreiung je Tag, Heilmittelkosten im Abrechnungslauf", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    // Befreiung für heute erfassen → 10-%-Anteil und Gebühr entfallen
    expect(await exemptions.addCopaymentExemption(auth, { patientId: patient, validFrom: today, validTo: `${today.slice(0, 4)}-12-31`, insurerName: "Beispiel-BKK", insurerIk: "109911114", note: null })).toEqual({ ok: true });
    await signAll(id);
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toEqual({ ok: true });
    const [row] = await fx.asOrg(org, async (c) => (await c.query("select remedy_cost_cents, copayment_cents, price_snapshot from prescriptions where id = $1", [id])).rows);
    const expected = (await import("@/lib/rules/podologie-verguetung")).priceFor("78020", today)!.cents;
    expect(row.remedy_cost_cents).toBe(expected);
    expect(row.copayment_cents).toBe(0);
    expect(row.price_snapshot.lines[0]).toMatchObject({ position: "78020", exempt: true });
    const batch = await presc.createBillingBatch(auth, [id], { partner: "manual" });
    expect("id" in batch).toBe(true);
    const [b] = await fx.asOrg(org, async (c) => (await c.query("select remedy_total_cents, copayment_total_cents from billing_batches where id = $1", [(batch as { id: string }).id])).rows);
    expect(b).toEqual({ remedy_total_cents: expected, copayment_total_cents: 0 });
    // Befreiung wieder entfernen
    const list = (await fx.asOrg(org, async (c) => (await c.query("select copayment_exemptions from patients where id = $1", [patient])).rows[0].copayment_exemptions)) as { id: string }[];
    await exemptions.removeCopaymentExemption(auth, { patientId: patient, id: list[0].id });
    const after = await fx.asOrg(org, async (c) => (await c.query("select copayment_exemptions from patients where id = $1", [patient])).rows[0].copayment_exemptions);
    expect(after).toEqual([]);
  });

  it("Abrechnungsreife gesperrt, solange Pflichtangaben fehlen (Anlage 3)", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    await fx.pool.query("update organizations set ik = null where id = $1", [org]);
    try {
      const res = await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" });
      expect(res).toMatchObject({ error: expect.stringMatching(/IK der Praxis/) });
    } finally {
      await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    }
  });

  it("Termin auf Verordnung: gespeichert, Warnung bei Restmenge, fremde Verordnung abgelehnt", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    const therapist = await fx.user(org, "therapist");
    const day = addDaysIso(today, 3);
    const res = await appts.createInternalAppointments(org, {
      patientId: patient, therapistId: therapist, occurrences: [berlinToUtc(day, "09:00")], durationMin: 30, source: "manual", title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: true, prescriptionId: id,
    });
    expect(res.ok).toBe(true);
    const [a] = await fx.asOrg(org, async (c) => (await c.query("select prescription_id from appointments where id = $1", [(res as { ids: string[] }).ids[0]])).rows);
    expect(a.prescription_id).toBe(id);
    // zweiter Termin auf eine 1-Einheiten-Verordnung → Warnung „keine Einheiten mehr frei“
    const plan = await planning.planningForPatient(auth, { patientId: patient, dates: [addDaysIso(today, 40)], prescriptionId: id });
    expect(plan.options.some((o) => o.id === id)).toBe(true);
    expect(plan.warnings.join(" ")).toMatch(/Keine Einheiten mehr frei/);
    const other = await fx.patient(org, { lastName: "Fremd" });
    const bad = await appts.createInternalAppointments(org, {
      patientId: other, therapistId: therapist, occurrences: [berlinToUtc(day, "11:00")], durationMin: 30, source: "manual", title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: true, prescriptionId: id,
    });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/gehört nicht/) });
  });

  const status = async (id: string) => (await fx.asOrg(org, async (c) => (await c.query("select status, expired_reason from prescriptions where id = $1", [id])).rows[0])) as { status: string; expired_reason: string | null };

  it("H1/C2: lesende Pfade ohne Schreibrecht bzw. im Support-Modus setzen keine Verordnung auf „Frist überschritten“", async () => {
    const id = await vo({ issuedAt: addDaysIso(today, -40) });
    // Terminplanung (GET /kalender/verordnung, nur appointments.read) – darf nichts schreiben, nur ausfiltern
    const reception = { ...(auth as object), role: "reception", can: (p: string) => p === "appointments.read" || p === "patients.read" } as never;
    const plan = await planning.planningForPatient(reception, { patientId: patient, dates: [today] });
    expect(plan.options.some((o) => o.id === id)).toBe(false);
    expect((await status(id)).status).toBe("open");
    // Support-Modus (auch wenn die Rolle schreiben dürfte): Übersicht und Akte schreiben nicht
    const support = { ...(auth as object), support: { grantId: "g", scope: "read", expiresAt: new Date(Date.now() + 3600_000) } } as never;
    await presc.listRunningPrescriptions(support);
    await presc.listPatientPrescriptions(support, patient);
    expect((await status(id)).status).toBe("open");
    // mit Schreibrecht (Akte): gekennzeichnet + protokolliert
    await presc.listPatientPrescriptions(auth, patient);
    expect(await status(id)).toEqual({ status: "expired", expired_reason: "start_missed" });
  });

  it("C1: übernommene laufende Verordnung (Import) ohne erfasste Behandlungstage bleibt buchbar und läuft nicht automatisch ab", async () => {
    const id = await vo({ issuedAt: addDaysIso(today, -200), status: "active", rules: "import-tinana", units: 6 });
    await presc.listPatientPrescriptions(auth, patient);
    await presc.listRunningPrescriptions(auth);
    expect((await status(id)).status).toBe("active");
    const plan = await planning.planningForPatient(auth, { patientId: patient, dates: [today], prescriptionId: id });
    expect(plan.selectedId).toBe(id);
    const rec = await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    expect(rec.id).toBeTruthy();
    expect((await status(id)).status).toBe("active");
  });

  it("C1: ältere Regelwerke laufen nicht automatisch ab; Rückweg aus „Frist überschritten“ nur mit Begründung", async () => {
    const old = await vo({ issuedAt: addDaysIso(today, -60), rules: "heilm-rl-podo-2025-07-entwurf" });
    await presc.listPatientPrescriptions(auth, patient);
    expect((await status(old)).status).toBe("open");
    const id = await vo({ issuedAt: addDaysIso(today, -60) });
    await presc.listPatientPrescriptions(auth, patient);
    expect((await status(id)).status).toBe("expired");
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "open" })).toMatchObject({ error: expect.stringMatching(/Begründung/) });
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "open", interruptionNote: "Beginn war am 3. Tag, Doku nachgetragen" })).toEqual({ ok: true });
    // bestätigt → läuft beim nächsten Lesen nicht wieder ab und ist buchbar
    await presc.listPatientPrescriptions(auth, patient);
    expect(await status(id)).toEqual({ status: "open", expired_reason: null });
    const plan = await planning.planningForPatient(auth, { patientId: patient, dates: [today], prescriptionId: id });
    expect(plan.selectedId).toBe(id);
  });

  it("S2: ohne vollständigen Preis-Snapshot (Position ohne Preis) nicht abrechnungsreif", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    await fx.asOrg(org, (c) => c.query(`update prescriptions set positions = '[{"label":"Behandlung ohne Positionsnummer","units":1}]' where id = $1`, [id]));
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    await signAll(id);
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toMatchObject({ error: expect.stringMatching(/Preis/) });
    expect((await status(id)).status).toBe("completed");
  });

  it("A1: Termin darf nur auf eine Verordnung derselben Praxis zeigen (Trigger, auch bei UPDATE)", async () => {
    const org2 = await fx.org();
    const p2 = await fx.patient(org2, { lastName: "Andere" });
    const foreign = await fx.asOrg(org2, async (c) => (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',1) returning id", [org2, p2, today])).rows[0].id as string);
    const ins = `insert into appointments (organization_id, patient_id, starts_at, ends_at, prescription_id) values ($1,$2, now(), now() + interval '30 minutes', $3) returning id`;
    await expect(fx.asOrg(org, (c) => c.query(ins, [org, patient, foreign]))).rejects.toThrow(/Verordnung gehört nicht zu dieser Praxis/);
    const appt = await fx.asOrg(org, async (c) => (await c.query(ins, [org, patient, null])).rows[0].id as string);
    await expect(fx.asOrg(org, (c) => c.query("update appointments set prescription_id = $2 where id = $1", [appt, foreign]))).rejects.toThrow(/Verordnung gehört nicht zu dieser Praxis/);
    // eigene Verordnung: erlaubt; wird sie gelöscht (Patient:in gelöscht), bleibt der Termin ohne Verweis (FK SET NULL)
    const own = await vo({ issuedAt: today, units: 1 });
    await fx.asOrg(org, (c) => c.query("update appointments set prescription_id = $2 where id = $1", [appt, own]));
    const [a] = await fx.asOrg(org, async (c) => (await c.query("select prescription_id from appointments where id = $1", [appt])).rows);
    expect(a.prescription_id).toBe(own);
  });

  it("H1: Nur-Lesen-Modus und fehlendes medical.write setzen keine Verordnung auf „Frist überschritten“ (canAutoExpire)", async () => {
    const p = await fx.patient(org, { lastName: "Lesemodus" });
    const id = await fx.asOrg(org, async (c) =>
      (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, rules_version) values ($1,$2,$3,'DF',2,'open',($3::date + 28),$4) returning id", [org, p, addDaysIso(today, -40), RULES_VERSION])).rows[0].id as string,
    );
    const readOnly = { ...(auth as object), readOnly: true } as never;
    const noWrite = { ...(auth as object), role: "assistant", can: (perm: string) => perm !== "medical.write" } as never;
    expect(presc.canAutoExpire(readOnly)).toBe(false);
    expect(presc.canAutoExpire(noWrite)).toBe(false);
    expect(presc.canAutoExpire(auth)).toBe(true);
    await presc.listPatientPrescriptions(readOnly, p);
    await presc.listRunningPrescriptions(readOnly);
    await presc.listPatientPrescriptions(noWrite, p);
    await presc.listRunningPrescriptions(noWrite);
    expect((await status(id)).status).toBe("open");
    await presc.listPatientPrescriptions(auth, p);
    expect(await status(id)).toEqual({ status: "expired", expired_reason: "start_missed" });
  });

  it("S-1: neue Verordnung lässt sich ohne Einheit nicht manuell auf „in Behandlung“ setzen – Frist bleibt verpasst", async () => {
    const p = await fx.patient(org, { lastName: "Statuswechsel" });
    const id = await fx.asOrg(org, async (c) =>
      (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, rules_version) values ($1,$2,$3,'DF',2,'open',($3::date + 28),$4) returning id", [org, p, addDaysIso(today, -77), RULES_VERSION])).rows[0].id as string,
    );
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: p, to: "active" })).toMatchObject({ error: expect.stringMatching(/ersten dokumentierten Behandlung/) });
    await presc.listPatientPrescriptions(auth, p);
    expect(await status(id)).toEqual({ status: "expired", expired_reason: "start_missed" });
  });

  it("S-2: übernommene VO „in Behandlung“ ohne erfassten Tag: Unterbrechung ab Übernahme, nach 12 Wochen nicht buchbar, kein Auto-Ablauf", async () => {
    const p = await fx.patient(org, { lastName: "Uebernahme" });
    const id = await fx.asOrg(org, async (c) =>
      (
        await c.query(
          "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version, created_at) values ($1,$2,$3,'DF',6,'active',($3::date + 28),'[{\"position\":\"78020\",\"label\":\"groß\",\"units\":6}]','import-tinana', now() - interval '90 days') returning id",
          [org, p, addDaysIso(today, -120)],
        )
      ).rows[0].id as string,
    );
    const list = await presc.listPatientPrescriptions(auth, p);
    const ev = list!.prescriptions.find((x) => x.id === id)!.evaluation;
    expect(ev.expiry).toBe("interrupted");
    expect(ev.messages.join(" ")).toMatch(/Übernahme/);
    expect((await status(id)).status).toBe("active"); // nicht automatisch abgelaufen
    await expect(
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: p, prescriptionId: id, findings: "o. B.", servicesText: "x" })),
    ).rejects.toThrow(/Übernahme in PodoHero.*12 Wochen/);
    // frisch übernommen: gelb + Hinweis beim Buchen, buchbar
    const fresh = await fx.asOrg(org, async (c) =>
      (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, rules_version) values ($1,$2,$3,'DF',6,'active',($3::date + 28),'import-tinana') returning id", [org, p, addDaysIso(today, -120)])).rows[0].id as string,
    );
    const bookable = await dbm.withOrg(org, (tx) => presc.bookablePrescriptions(tx, org, p));
    const b = bookable.find((x) => x.id === fresh)!;
    expect(b.warning).toMatch(/Übernommene Verordnung ohne erfassten Behandlungstag/);
    expect(bookable.some((x) => x.id === id)).toBe(false);
    const again = await presc.listPatientPrescriptions(auth, p);
    expect(again!.prescriptions.find((x) => x.id === fresh)!.evaluation.light).toBe("yellow");
  });

  it("Abrechnungslauf nur mit vollständigem Preis-Snapshot", async () => {
    const p = await fx.patient(org, { lastName: "OhneSnapshot" });
    const id = await fx.asOrg(org, async (c) =>
      (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, rules_version) values ($1,$2,$3,'DF',1,'billing_ready',($3::date + 28),$4) returning id", [org, p, today, RULES_VERSION])).rows[0].id as string,
    );
    expect(await presc.createBillingBatch(auth, [id], { partner: "manual" })).toMatchObject({ error: expect.stringMatching(/Preis-Snapshot/) });
    await fx.asOrg(org, (c) => c.query(`update prescriptions set price_snapshot = '{"complete": false, "lines": [], "notes": []}' where id = $1`, [id]));
    expect(await presc.createBillingBatch(auth, [id], { partner: "manual" })).toMatchObject({ error: expect.stringMatching(/Preis-Snapshot/) });
    expect((await status(id)).status).toBe("billing_ready");
  });

  it("N1: abgerechnete Verordnung bzw. erhaltene Zuzahlung sperren die vollständige Löschung (App + podo_delete_patient)", async () => {
    const deletion = await import("./patient-deletion");
    const mk = async (name: string, extra: string) => {
      const p = await fx.patient(org, { lastName: name });
      await fx.asOrg(org, (c) => c.query(`insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status ${extra ? `, ${extra}` : ""}) values ($1,$2,$3,'DF',1,'cancelled' ${extra ? ", now()" : ""})`, [org, p, today]));
      return p;
    };
    const billed = await mk("Abgerechnet", "billed_at");
    const paid = await mk("Bezahlt", "copayment_paid_at");
    const plain = await mk("Ohne", "");
    for (const p of [billed, paid]) {
      expect((await deletion.deletionStatus(auth, p))!.mode).toBe("anonymize");
      await expect(fx.asOrg(org, (c) => c.query("select podo_delete_patient($1::uuid)", [p]))).rejects.toThrow(/Aufbewahrungspflichtige Daten/);
    }
    expect((await deletion.deletionStatus(auth, plain))!.mode).toBe("delete");
    const [r] = await fx.asOrg(org, async (c) => (await c.query("select podo_delete_patient($1::uuid) as ok", [plain])).rows);
    expect(r.ok).toBe(true);
  });

  it("Migration 0062: Termin-Verweise auf Verordnungen anderer Praxen werden geleert, FORCE RLS bleibt an", { timeout: 120_000 }, async (ctx) => {
    let legacy = "";
    let ok = "";
    let own = "";
    // Altbestand in der eigenen DB (Owner, Trigger aus): zwei Praxen, Termin mit Verordnung der fremden Praxis
    const ran = await runMigration("_gkv_review.sql", {
      // Altbestand nachstellen braucht session_replication_role (Superuser)
      superuser: true,
      before: async (c) => {
        await c.query("set session_replication_role = replica");
        const id = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
        const o1 = await id("insert into organizations (name, slug) values ('Praxis A', $1) returning id", [`a-${Math.random().toString(36).slice(2, 8)}`]);
        const o2 = await id("insert into organizations (name, slug) values ('Praxis B', $1) returning id", [`b-${Math.random().toString(36).slice(2, 8)}`]);
        const p1 = await id("insert into patients (organization_id, number, last_name) values ($1, 1, 'Kasse') returning id", [o1]);
        const p2 = await id("insert into patients (organization_id, number, last_name) values ($1, 1, 'Fremdpraxis') returning id", [o2]);
        const vo = "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',1) returning id";
        const foreign = await id(vo, [o2, p2, today]);
        own = await id(vo, [o1, p1, today]);
        const ins = "insert into appointments (organization_id, patient_id, starts_at, ends_at, prescription_id) values ($1,$2, now(), now() + interval '30 minutes', $3) returning id";
        legacy = await id(ins, [o1, p1, foreign]);
        ok = await id(ins, [o1, p1, own]);
        await c.query("set session_replication_role = origin");
      },
      after: async (c) => {
        const rows = (await c.query("select id, prescription_id from appointments where id = any($1)", [[legacy, ok]])).rows;
        expect(rows.find((x) => x.id === legacy)!.prescription_id).toBeNull();
        expect(rows.find((x) => x.id === ok)!.prescription_id).toBe(own);
        const force = await c.query("select relname, relforcerowsecurity from pg_class where relname in ('appointments', 'prescriptions') order by relname");
        expect(force.rows).toEqual([{ relname: "appointments", relforcerowsecurity: true }, { relname: "prescriptions", relforcerowsecurity: true }]);
        const idx = await c.query("select indexdef from pg_indexes where indexname = 'appointments_prescription_id'");
        expect(idx.rows[0]?.indexdef).toMatch(/WHERE \(prescription_id IS NOT NULL\)/);
        const fn = await c.query("select proconfig from pg_proc where proname = 'podo_prescription_billed_lock'");
        expect(fn.rows[0].proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
      },
    });
    if (!ran) ctx.skip();
  });

  it("Paket B: neuer Altvermerk „Zuzahlung erhalten“ nicht mehr möglich; Server-Action ohne 500 bei Unsinn", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    expect(await presc.setCopaymentPaid(auth, { id, patientId: patient, paid: true, amountCents: 1000 })).toEqual({ error: presc.COPAYMENT_LEGACY_BLOCKED });
    // Server-Action der Quittung: riesige/ungültige Eingaben werden zur Fehlermeldung (kein integer out of range)
    const { copaymentReceiptAction } = await import("@/app/(app)/kunden/[id]/verordnungen/actions");
    const form = (amount: string) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ prescriptionId: id, patientId: patient, amount, method: "cash", confirmOverpay: "on" })) f.set(k, v);
      return f;
    };
    expect(await copaymentReceiptAction(undefined, form("21474836,48"))).toEqual({ error: "Betrag ist zu groß." });
    expect(await copaymentReceiptAction(undefined, form("99999999"))).toEqual({ error: "Betrag ist zu groß." });
    expect(await copaymentReceiptAction(undefined, form("12 50"))).toHaveProperty("error");
    expect(await copaymentReceiptAction(undefined, form("x".repeat(21)))).toHaveProperty("error");
    // höher als die Heilmittelkosten (1 × 78020)
    expect(await copaymentReceiptAction(undefined, form("60,00"))).toEqual({ error: expect.stringMatching(/höher als die Heilmittelkosten/) });
    const [row] = await fx.asOrg(org, async (c) => (await c.query("select count(*)::int as n from invoices where prescription_id = $1", [id])).rows);
    expect(row.n).toBe(0);
  });

  it("Runde 3 H-2: doppelte Positionen mit negativer Zeile werden abgelehnt, nicht verrechnet", async () => {
    const parsed = presc.prescriptionInput.parse({
      patientId: patient, issuedAt: today, diagnosisGroup: "DF", units: "6",
      positions: JSON.stringify([{ position: "78020", label: "groß", units: 5 }, { position: "78020", label: "groß", units: -3 }]),
    });
    expect(await presc.savePrescription(auth, parsed)).toEqual({ error: expect.stringMatching(/Einheiten/) });
  });

  it("Runde 3 H-4/H-6: Wiederaufnahme → alle Einheiten erbracht → abrechnungsreif: 78610 nicht als „vorzeitig beendet“; Fehlertext mit Bezugspunkt", async () => {
    const p = await fx.patient(org, { lastName: "Spange" });
    await fx.asOrg(org, (c) => c.query("update patients set birth_date = '1950-03-01' where id = $1", [p]));
    const id = await fx.asOrg(org, async (c) =>
      (
        await c.query(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, interruption_note, expired_reason,
             prescription_kind, prescription_kind_confirmed_at)
           values ($1,$2,$3,'UI1',2,'expired',($3::date + 28),'[{"position":"78610","label":"Spange","units":4}]',$4,
             'L60.0','109911114','A000500015','1','123456601','123456789',true,'a','Pause wegen Urlaub der Patientin','start_missed','03',now()) returning id`,
          [org, p, addDaysIso(today, -60), RULES_VERSION],
        )
      ).rows[0].id as string,
    );
    await pastRecord(id, addDaysIso(today, -50), p);
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: p, to: "active", interruptionNote: "Beginn war rechtzeitig, Doku nachgetragen" })).toEqual({ ok: true });
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: p, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    expect((await status(id)).status).toBe("completed");
    await signAll(id);
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: p, to: "billing_ready" })).toEqual({ ok: true });
    const [row] = await fx.asOrg(org, async (c) => (await c.query("select price_snapshot from prescriptions where id = $1", [id])).rows);
    expect(row.price_snapshot.lines.map((l: { units: number }) => l.units)).toEqual([2, 2]);
    // H-6: Wiederaufnahme vor über 12 Wochen, danach keine Behandlung → Fehlertext nennt die Wiederaufnahme
    const q = await fx.asOrg(org, async (c) =>
      (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, rules_version, reopened_at) values ($1,$2,$3,'DF',2,'open',($3::date + 28),$4,$5) returning id", [org, p, addDaysIso(today, -200), RULES_VERSION, addDaysIso(today, -100)])).rows[0].id as string,
    );
    await expect(
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: p, prescriptionId: q, findings: "o. B.", servicesText: "x" })),
    ).rejects.toThrow(/Seit der Wiederaufnahme \(\d{2}\.\d{2}\.\d{4}\) sind mehr als 12 Wochen vergangen/);
  });

  it("A5: höchstens 50 Befreiungen je Person (CHECK)", async () => {
    const p = await fx.patient(org, { lastName: "Viele" });
    const list = Array.from({ length: 51 }, (_, i) => ({ id: `e${i}`, validFrom: today, validTo: today }));
    await expect(fx.asOrg(org, (c) => c.query("update patients set copayment_exemptions = $2 where id = $1", [p, JSON.stringify(list)]))).rejects.toThrow(/patients_copayment_exemptions_max/);
    await fx.asOrg(org, (c) => c.query("update patients set copayment_exemptions = $2 where id = $1", [p, JSON.stringify(list.slice(0, 50))]));
  });

  it("A2/A4: ungültiges Datum abgelehnt; Entfernen protokolliert Zeitraum und Kasse, nur wenn wirklich entfernt", async () => {
    expect(exemptions.exemptionInput.safeParse({ patientId: patient, validFrom: "2026-02-30", validTo: "2026-12-31" }).success).toBe(false);
    const p = await fx.patient(org, { lastName: "Befreit" });
    expect(await exemptions.addCopaymentExemption(auth, { patientId: p, validFrom: today, validTo: `${today.slice(0, 4)}-12-31`, insurerName: "Beispiel-BKK", insurerIk: "109911114", note: null })).toEqual({ ok: true });
    const [e] = (await fx.asOrg(org, async (c) => (await c.query("select copayment_exemptions from patients where id = $1", [p])).rows[0].copayment_exemptions)) as { id: string }[];
    vi.mocked(audit).mockClear();
    expect(await exemptions.removeCopaymentExemption(auth, { patientId: p, id: "00000000-0000-4000-8000-000000000000" })).toEqual({ removed: false });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(await exemptions.removeCopaymentExemption(auth, { patientId: p, id: e.id })).toEqual({ removed: true });
    expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ action: "patient.copayment_exemption.remove", meta: { validFrom: today, validTo: `${today.slice(0, 4)}-12-31`, insurerName: "Beispiel-BKK", insurerIk: "109911114" } });
  });

  it("S1: abgerechnete Verordnung unveränderbar (Trigger), „Zuzahlung erhalten“ mit Betrag/Zahlungsart bleibt möglich; alter Snapshot im Protokoll", async () => {
    const id = await vo({ issuedAt: today, units: 1 });
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "o. B.", servicesText: "x" }));
    // Paket B: ohne Unterschrift nicht abrechnungsreif
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toMatchObject({ error: expect.stringMatching(/keine Unterschrift/) });
    await signAll(id);
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toEqual({ ok: true });
    vi.mocked(audit).mockClear();
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "completed" })).toEqual({ ok: true });
    expect(vi.mocked(audit).mock.calls[0][0]).toMatchObject({ meta: { previousSnapshot: { remedyCents: expect.any(Number) } } });
    expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toEqual({ ok: true });
    const batch = await presc.createBillingBatch(auth, [id], { partner: "manual" });
    expect("id" in batch).toBe(true);
    await expect(fx.asOrg(org, (c) => c.query("update prescriptions set copayment_cents = 0 where id = $1", [id]))).rejects.toThrow(/unveränderbar/);
    await expect(fx.asOrg(org, (c) => c.query("update prescriptions set status = 'completed' where id = $1", [id]))).rejects.toThrow(/unveränderbar/);
    // Altvermerk (vor Paket B) darf auch nach „abgerechnet“ zurückgesetzt werden (Trigger erlaubt copayment_paid_*)
    await fx.asOrg(org, (c) => c.query("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = 1506, copayment_paid_method = 'card' where id = $1", [id]));
    expect(await presc.setCopaymentPaid(auth, { id, patientId: patient, paid: false, reason: "Vermerk war falsch, nichts erhalten" })).toEqual({});
    const [row] = await fx.asOrg(org, async (c) => (await c.query("select copayment_paid_cents, copayment_paid_method, copayment_paid_at from prescriptions where id = $1", [id])).rows);
    expect(row).toMatchObject({ copayment_paid_cents: null, copayment_paid_method: null, copayment_paid_at: null });
    // Export: Befreiung laut Snapshot (Person ist volljährig, keine Bescheinigung) + Kreuz der VO in eigener Spalte
    const exp = await presc.billingBatchExport(auth, (batch as { id: string }).id);
    const header = exp!.lines[0] as string[];
    const line = exp!.lines[1] as string[];
    expect(line[header.indexOf("Zuzahlungsbefreit")]).toBe("nein");
    expect(line[header.indexOf("Zuzahlungsfrei angekreuzt (VO)")]).toBe("nein");
  });

  it("C5/C6: gleicher Tag ist keine Frequenzabweichung; Abweichung ohne Begründung → Meldung mit Feldtext (Besuchstag)", async () => {
    const id = await vo({ issuedAt: addDaysIso(today, -20), units: 4 });
    // zwei Einträge am selben Tag (z. B. Befundung + Behandlung): ohne Begründung möglich
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "Befundung", servicesText: "x" }));
    await dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId: id, findings: "Behandlung", servicesText: "x" }));
    // Bewohnerin im Pflegeheim, letzte Behandlung vor 10 Tagen (Frequenz 4–6 Wochen) → heute Abweichung
    const home = await fx.asOrg(org, async (c) => (await c.query("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Haus Linde') returning id", [org])).rows[0].id as string);
    const resident = await fx.patient(org, { lastName: "Bewohnerin" });
    await fx.asOrg(org, (c) => c.query("update patients set care_home_id = $2 where id = $1", [resident, home]));
    const rv = await fx.asOrg(org, async (c) =>
      (
        await c.query(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, frequency_per_week, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik)
           values ($1,$2,$3,'DF',4,'active',($3::date + 28),'[{"position":"78020","label":"groß","units":4}]','1x alle 4-6 Wochen',$4,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c') returning id`,
          [org, resident, addDaysIso(today, -20), RULES_VERSION],
        )
      ).rows[0].id as string,
    );
    await pastRecord(rv, addDaysIso(today, -10), resident);
    const { quickRecordAction } = await import("@/app/(app)/pflegeheime/actions");
    const form = (extra: Record<string, string> = {}) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ careHomeId: home, patientId: resident, servicesText: "Behandlung", prescriptionId: rv, confirm: "on", ...extra })) f.set(k, v);
      return f;
    };
    const res = await quickRecordAction(undefined, form());
    expect(res?.error).toMatch(/Frequenz unterschritten/);
    expect(res?.deviationText).toMatch(/Frequenz unterschritten/);
    expect(await quickRecordAction(undefined, form({ frequencyDeviationNote: "Absprache mit Dr. Beispiel: Druckstelle, früher behandeln" }))).toEqual({ ok: "Gespeichert" });
    // Besuchstag lädt die buchbaren Verordnungen in einer Abfrage und schreibt nichts
    const care = await import("./care-homes");
    const day = await care.visitDay(auth, home);
    expect(day!.residents.find((r) => r.id === resident)!.prescriptions.map((p) => p.id)).toEqual([rv]);
  });

  it("Nice: gewählte, nicht mehr buchbare Verordnung wird nicht still ersetzt", async () => {
    const done = await vo({ issuedAt: today, units: 1, status: "completed" });
    const plan = await planning.planningForPatient(auth, { patientId: patient, dates: [today], prescriptionId: done });
    expect(plan.selectedId).toBeNull();
    expect(plan.warnings.join(" ")).toMatch(/nicht mehr buchbar/);
  });

  it("ohne Kassen-Themen (private_only): keine Verordnungsauswahl im Termin", async () => {
    const privateAuth = { ...(auth as object), organization: { ...(auth as unknown as { organization: object }).organization, billingMode: "private_only" } } as never;
    expect(await planning.planningForPatient(privateAuth, { patientId: patient, dates: [today] })).toEqual({ options: [], selectedId: null, warnings: [] });
  });
});
