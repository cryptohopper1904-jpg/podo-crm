/**
 * Übernahme-Assistent gegen PostgreSQL (RLS erzwungen, App-Rolle): Idempotenz, keine Überschreibung, Mandantentrennung.
 * Nur mit TEST_DATABASE_URL; ausschließlich erfundene Daten (Fixtures).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as s from "@/db/schema";
import { readDecrypted, storeEncrypted } from "@/lib/storage";
import { buildWorkbook } from "../excel/excel-import.test";
import { collectFiles } from "./collect";
import { applyPlan, loadExisting } from "./persist";
import { buildPlan } from "./plan";
import { tinanaUpload } from "./plan.test";
import type { PrescriptionMode } from "./types";

const url = process.env.TEST_DATABASE_URL;
type Db = NodePgDatabase<typeof s>;
type TxOf = Parameters<Parameters<Db["transaction"]>[0]>[0];

(url ? describe : describe.skip)("Übernahme-Assistent gegen PostgreSQL", () => {
  let pool: Pool;
  let db: Db;
  const stamp = Date.now();
  const inOrg = <T,>(org: string, fn: (tx: TxOf) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${org}, true)`);
      return fn(tx);
    });

  async function practice(tag: string) {
    const [org] = await db.insert(s.organizations).values({ name: `Übernahme ${tag}`, slug: `ueb-${tag}-${stamp}` }).returning();
    const [user] = await db.insert(s.users).values({ email: `ueb-${tag}-${stamp}@example.org`, name: "Therapeutin Eins", passwordHash: "x" }).returning();
    await db.insert(s.memberships).values({ organizationId: org.id, userId: user.id, role: "owner" });
    return { org: org.id, user: user.id };
  }

  /** wie die Server Action: Sperre, Bestand laden, Plan, schreiben – eine Transaktion */
  async function run(p: { org: string; user: string }, files: Awaited<ReturnType<typeof collectFiles>>, mode: PrescriptionMode = "billed") {
    return inOrg(p.org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + p.org}))`);
      const existing = await loadExisting(tx as never, p.org, files.filter((f) => f.kind === "pdf").map((f) => f.sha256));
      const plan = buildPlan(files, existing, { prescriptionMode: mode, now: new Date("2026-01-13T08:00:00Z") });
      const summary = await applyPlan(tx as never, p.org, p.user, plan, (d) => storeEncrypted(p.org, d));
      return { plan, summary };
    });
  }

  const counts = (org: string) =>
    inOrg(org, async (tx) => {
      const n = async (q: Promise<unknown[]>) => (await q).length;
      return {
        patients: await n(tx.select({ id: s.patients.id }).from(s.patients).where(eq(s.patients.organizationId, org))),
        appointments: await n(tx.select({ id: s.appointments.id }).from(s.appointments).where(eq(s.appointments.organizationId, org))),
        services: await n(tx.select({ id: s.appointmentServices.id }).from(s.appointmentServices).where(eq(s.appointmentServices.organizationId, org))),
        prescriptions: await n(tx.select({ id: s.prescriptions.id }).from(s.prescriptions).where(eq(s.prescriptions.organizationId, org))),
        media: await n(tx.select({ id: s.media.id }).from(s.media).where(eq(s.media.organizationId, org))),
        invoices: await n(tx.select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.organizationId, org))),
      };
    });

  beforeAll(() => {
    pool = new Pool({ connectionString: url });
    db = drizzle(pool, { schema: s });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("übernimmt Tinana-Patient:innen, Termine, Verordnungen und Rechnungs-PDFs – zweiter Lauf legt nichts doppelt an", async () => {
    const a = await practice("a");
    await inOrg(a.org, (tx) => tx.insert(s.services).values({ organizationId: a.org, code: "PBG", name: "Podologische Behandlung (groß)", priceCents: 5192 }));
    const first = await run(a, await tinanaUpload());
    expect(first.summary).toMatchObject({ patientsCreated: 4, patientsLinked: 0, appointments: 3, prescriptions: 2, documents: 2, excel: null });
    expect(await counts(a.org)).toEqual({ patients: 4, appointments: 3, services: 1, prescriptions: 2, media: 2, invoices: 0 });

    const rows = await inOrg(a.org, async (tx) => ({
      erika: (await tx.select().from(s.patients).where(and(eq(s.patients.organizationId, a.org), eq(s.patients.lastName, "Musterfrau"))))[0],
      appts: await tx.select().from(s.appointments).where(eq(s.appointments.organizationId, a.org)),
      rx: await tx.select().from(s.prescriptions).where(eq(s.prescriptions.organizationId, a.org)),
      docs: await tx.select().from(s.media).where(eq(s.media.organizationId, a.org)),
      cash: await tx.select().from(s.cashMovements).where(eq(s.cashMovements.organizationId, a.org)),
      payments: await tx.select().from(s.payments).where(eq(s.payments.organizationId, a.org)),
      reminders: await tx.select().from(s.reminderLog).where(eq(s.reminderLog.organizationId, a.org)),
    }));
    expect(rows.erika).toMatchObject({ externalIds: { tinana: "10000000-0000-4000-8000-000000000001" }, insurerName: "Beispiel-BKK", insuranceType: "gkv", preferredChannel: "none", source: "tinana-import" });
    expect(rows.appts.every((x) => x.source === "import" && x.externalId?.startsWith("tinana:"))).toBe(true);
    expect(rows.appts.find((x) => x.externalId === "tinana:20000000-0000-4000-8000-000000000001")).toMatchObject({ status: "done", therapistId: a.user, patientId: rows.erika.id });
    expect(rows.rx.every((x) => x.status === "billed" && x.source === "paper" && x.rulesVersion === "import-tinana" && x.externalRef?.startsWith("tinana:"))).toBe(true);
    // Fremd-Rechnungen: keine Rechnungen, Zahlungen, Kassenbuchungen; keine Erinnerungen ausgelöst
    expect(rows.cash).toEqual([]);
    expect(rows.payments).toEqual([]);
    expect(rows.reminders).toEqual([]);
    // PDFs verschlüsselt abgelegt und lesbar
    const doc = rows.docs[0];
    expect(doc).toMatchObject({ kind: "document", purpose: "document", mime: "application/pdf", uploadedBy: a.user });
    expect((await readDecrypted(doc.storageKey)).subarray(0, 5).toString()).toBe("%PDF-");

    const second = await run(a, await tinanaUpload());
    expect(second.summary).toMatchObject({ patientsCreated: 0, patientsLinked: 0, appointments: 0, prescriptions: 0, documents: 0 });
    expect(second.plan.hasWork).toBe(false);
    expect(await counts(a.org)).toEqual({ patients: 4, appointments: 3, services: 1, prescriptions: 2, media: 2, invoices: 0 });
  });

  it("überschreibt nichts: vorhandene Person wird nur verknüpft, ihre Daten bleiben", async () => {
    const b = await practice("b");
    const [old] = await inOrg(b.org, (tx) =>
      tx
        .insert(s.patients)
        .values({ organizationId: b.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", email: "bestand@example.org", notes: "Bestand", insuranceType: "self", externalIds: { legacyExcel: 5 } })
        .returning(),
    );
    const r = await run(b, await tinanaUpload(), "active");
    expect(r.summary).toMatchObject({ patientsCreated: 3, patientsLinked: 1 });
    const [after] = await inOrg(b.org, (tx) => tx.select().from(s.patients).where(eq(s.patients.id, old.id)));
    expect(after).toMatchObject({ email: "bestand@example.org", notes: "Bestand", insuranceType: "self", insurerName: null, externalIds: { legacyExcel: 5, tinana: "10000000-0000-4000-8000-000000000001" } });
    const rx = await inOrg(b.org, (tx) => tx.select().from(s.prescriptions).where(eq(s.prescriptions.patientId, old.id)));
    expect(rx).toHaveLength(1);
    expect(rx[0].status).toBe("active");
  });

  it("Mandantentrennung: Praxis C sieht und verändert nichts aus Praxis A/B, eigener Import ist unabhängig", async () => {
    const c = await practice("c");
    const [twin] = await inOrg(c.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: c.org, number: 1, firstName: "Max", lastName: "Mustermann", birthDate: "1962-11-17", insuranceType: "pkv", externalIds: {} }).returning(),
    );
    const before = await inOrg(c.org, (tx) => loadExisting(tx as never, c.org));
    expect(before.patients.map((p) => p.id)).toEqual([twin.id]);
    expect(before.appointmentRefs.size).toBe(0);
    const r = await run(c, await tinanaUpload());
    expect(r.summary).toMatchObject({ patientsCreated: 3, patientsLinked: 1, appointments: 3, prescriptions: 2 });
    // keine fremde Praxis-ID in den Zeilen von C
    const leaked = await inOrg(c.org, (tx) => tx.select({ id: s.appointments.id }).from(s.appointments).where(sql`${s.appointments.organizationId} <> ${c.org}`));
    expect(leaked).toEqual([]);
  });

  it("PodoHero-Excel über den Assistenten: zweiter Lauf legt keine Patient:innen/Fixkosten doppelt an und überschreibt keine Leistung", async () => {
    const d = await practice("d");
    const files = await collectFiles([{ name: "Rechnungsmanager.xlsx", data: new Uint8Array(await buildWorkbook()) }]);
    const first = await run(d, files);
    expect(first.summary.excel?.patients).toBeGreaterThan(0);
    const c1 = await counts(d.org);
    const fixed1 = (await inOrg(d.org, (tx) => tx.select().from(s.fixedCosts).where(eq(s.fixedCosts.organizationId, d.org)))).length;
    const [svc] = await inOrg(d.org, (tx) => tx.select().from(s.services).where(eq(s.services.organizationId, d.org)).limit(1));
    await inOrg(d.org, (tx) => tx.update(s.services).set({ priceCents: 1 }).where(eq(s.services.id, svc.id)));

    const second = await run(d, await collectFiles([{ name: "Rechnungsmanager.xlsx", data: new Uint8Array(await buildWorkbook()) }]));
    expect(second.summary.excel).toMatchObject({ patients: 0, invoices: 0, fixedCosts: 0, payments: 0 });
    expect(await counts(d.org)).toEqual(c1);
    expect((await inOrg(d.org, (tx) => tx.select().from(s.fixedCosts).where(eq(s.fixedCosts.organizationId, d.org)))).length).toBe(fixed1);
    const [svcAfter] = await inOrg(d.org, (tx) => tx.select().from(s.services).where(eq(s.services.id, svc.id)));
    expect(svcAfter.priceCents).toBe(1);
  });
});
