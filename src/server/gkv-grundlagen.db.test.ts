/**
 * GKV-Grundlagen (Paket A, docs/GKV.md) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten):
 * Migration 0061 (payerIk → insurer_ik, idempotent), „Frist überschritten“ automatisch, Buchungssperre bei
 * abgelaufener Verordnung, Preis-Snapshot bei Abrechnungsreife + Heilmittelkosten im Abrechnungslauf,
 * Befreiungsbescheinigung je Tag, Termin mit Verordnung und Planungswarnungen.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
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
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik)
           values ($1,$2,$3,$4,$5,$6,($3::date + 28),$7,$8,$9,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c') returning id`,
          [org, patient, v.issuedAt, v.group ?? "DF", v.units ?? 2, v.status ?? "open", JSON.stringify([{ position: "78020", label: "groß", units: v.units ?? 2 }]), v.frequency ?? "1x alle 4-6 Wochen", v.rules === undefined ? RULES_VERSION : v.rules],
        )
      ).rows[0].id as string,
    );

  it("Migration: payerIk aus extra in insurer_ik übernommen, ungültige bleiben, wiederholbar", async () => {
    const p1 = await fx.patient(org, { lastName: "Alt1" });
    const p2 = await fx.patient(org, { lastName: "Alt2" });
    await fx.asOrg(org, async (c) => {
      await c.query(`update patients set extra = '{"payerIk":"109911114","gender":"female","insuranceStatus":"5000000"}' where id = $1`, [p1]);
      await c.query(`update patients set extra = '{"payerIk":"12AB"}' where id = $1`, [p2]);
    });
    const sql = readFileSync(path.join(__dirname, "../../drizzle", MIGRATION), "utf8").split("--> statement-breakpoint");
    const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
    try {
      for (let run = 0; run < 2; run++) for (const stmt of sql) if (stmt.trim()) await owner.query(stmt);
    } finally {
      await owner.end();
    }
    const rows = await fx.asOrg(org, async (c) => (await c.query("select id, insurer_ik, insured_status, extra from patients where id = any($1)", [[p1, p2]])).rows);
    const a = rows.find((r) => r.id === p1)!;
    const b = rows.find((r) => r.id === p2)!;
    expect(a.insurer_ik).toBe("109911114");
    expect(a.insured_status).toBe("5");
    expect(a.extra).toEqual({ gender: "female", insuranceStatus: "5000000" });
    expect(b.insurer_ik).toBeNull();
    expect(b.extra).toEqual({ payerIk: "12AB" });
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

  it("ohne Kassen-Themen (private_only): keine Verordnungsauswahl im Termin", async () => {
    const privateAuth = { ...(auth as object), organization: { ...(auth as unknown as { organization: object }).organization, billingMode: "private_only" } } as never;
    expect(await planning.planningForPatient(privateAuth, { patientId: patient, dates: [today] })).toEqual({ options: [], selectedId: null, warnings: [] });
  });
});
