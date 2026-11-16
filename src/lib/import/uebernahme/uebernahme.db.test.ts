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
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";
import { buildWorkbook } from "../excel/excel-import.test";
import { collectFiles } from "./collect";
import { applyPlan, loadExisting } from "./persist";
import { buildPlan } from "./plan";
import { tinanaUpload } from "./plan.test";
import { pododeskUpload } from "./pododesk.test";
import { writeDoctolibPatientsCsv } from "@/integrations/doctolib/csv";
import { ChoiceConflictError, ImportBusyError, previewUebernahme, runUebernahme, StaleSnapshotError, StoreTimeoutError, TokenUsedError, type RunDeps } from "./run";
import { persistImport } from "../excel/persist";
import { parseWorkbook } from "../excel/parse";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  async function run(p: { org: string; user: string }, files: Awaited<ReturnType<typeof collectFiles>>, mode: PrescriptionMode = "billed", now = new Date("2026-01-13T08:00:00Z")) {
    return inOrg(p.org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + p.org}))`);
      const existing = await loadExisting(tx as never, p.org, files.filter((f) => f.kind === "pdf").map((f) => f.sha256));
      const plan = buildPlan(files, existing, { prescriptionMode: mode, now });
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

  // ───── Ablauf mit Sperre, Einmal-Token und Vorab-Ablage (run.ts) ─────
  const FIX = path.resolve(__dirname, "../__fixtures__/tinana");
  const rawUpload = () => [
    ...["patients_export_2026-01-15.csv", "appointments_export_2026-01-15.csv", "prescriptions_export_2026-01-15.csv", "invoices_export_2026-01-15.csv"].map((n) => ({ name: n, data: new Uint8Array(readFileSync(path.join(FIX, n))) })),
    { name: "RE-2026-00001.pdf", data: new TextEncoder().encode("%PDF-1.4\n% Rechnung RE-2026-00001\n%%EOF") },
    { name: "RE-2026-00002.pdf", data: new TextEncoder().encode("%PDF-1.4\n% Rechnung RE-2026-00002\n%%EOF") },
  ];
  const opts = { prescriptionMode: "billed" as const, now: new Date("2026-01-13T08:00:00Z") };
  function deps(extra: Partial<RunDeps> = {}) {
    const stored: string[] = [];
    const discarded: string[] = [];
    const d: RunDeps = {
      inOrg: inOrg as never,
      store: async (org, data) => {
        const r = await storeEncrypted(org, data);
        stored.push(r.storageKey);
        return r;
      },
      discard: async (k) => {
        discarded.push(k);
        await discardStored(k);
      },
      ...extra,
    };
    return { d, stored, discarded };
  }

  it("Vorschau-Token ist nur einmal einlösbar; Audit-Eintrag in derselben Transaktion", async () => {
    const e = await practice("e");
    const { d, stored, discarded } = deps();
    const args = { org: e.org, userId: e.user, files: rawUpload(), opts, tokenHash: `t-${stamp}`, auditMeta: { sha256: "x" } };
    const r = await runUebernahme(d, args);
    expect(r.summary).toMatchObject({ patientsCreated: 4, documents: 2 });
    // beide PDFs wurden vor der Transaktion abgelegt und verwendet – nichts verworfen
    expect(stored).toHaveLength(2);
    expect(discarded).toEqual([]);
    await expect(runUebernahme(d, args)).rejects.toBeInstanceOf(TokenUsedError);
    const audits = await inOrg(e.org, (tx) => tx.select().from(s.auditLog).where(and(eq(s.auditLog.organizationId, e.org), eq(s.auditLog.action, "import.uebernahme.run"))));
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ token: `t-${stamp}`, patientsCreated: 4 });
    // die beim zweiten (abgelehnten) Lauf vorab abgelegten PDFs gibt es nicht – Bestand vorhanden, nichts neu
    expect(stored).toHaveLength(2);
  });

  it("Fehler in der Import-Transaktion: vorab abgelegte PDFs werden wieder entfernt, nichts gespeichert", async () => {
    const f = await practice("f");
    let phase = 0;
    const failing: RunDeps["inOrg"] = (org, fn) =>
      inOrg(org, async (tx) => {
        phase++;
        const r = await fn(tx as never);
        if (phase === 2) throw new Error("Abbruch beim Schreiben (Test)");
        return r;
      });
    const { d, stored, discarded } = deps({ inOrg: failing });
    await expect(runUebernahme(d, { org: f.org, userId: f.user, files: rawUpload(), opts, tokenHash: `f-${stamp}`, auditMeta: {} })).rejects.toThrow(/Abbruch/);
    expect(stored).toHaveLength(2);
    expect(discarded.sort()).toEqual([...stored].sort());
    await expect(readDecrypted(stored[0])).rejects.toThrow();
    expect(await counts(f.org)).toEqual({ patients: 0, appointments: 0, services: 0, prescriptions: 0, media: 0, invoices: 0 });
  });

  it("je Praxis nur ein Lauf gleichzeitig (pg_try_advisory_xact_lock)", async () => {
    const g = await practice("g");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = inOrg(g.org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"uebernahme:" + g.org}))`);
      locked();
      await held;
    });
    await isLocked;
    await expect(previewUebernahme({ inOrg: inOrg as never }, g.org, rawUpload(), opts)).rejects.toBeInstanceOf(ImportBusyError);
    // andere Praxis ist nicht betroffen
    const h = await practice("h");
    await expect(previewUebernahme({ inOrg: inOrg as never }, h.org, rawUpload(), opts)).resolves.toMatchObject({ plan: { hasWork: true } });
    release();
    await holder;
    await expect(previewUebernahme({ inOrg: inOrg as never }, g.org, rawUpload(), opts)).resolves.toMatchObject({ plan: { hasWork: true } });
  });

  it("Art. 17 gelöschte Person (Tinana-ID vorhanden) wird nicht neu angelegt, ihre Termine nicht übernommen", async () => {
    const i = await practice("i");
    await inOrg(i.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: i.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self", externalIds: { tinana: "10000000-0000-4000-8000-000000000001" }, contactErasedAt: new Date(), archivedAt: new Date() }),
    );
    const r = await run(i, await tinanaUpload());
    expect(r.plan.totals).toMatchObject({ patientsErased: 1, patientsNew: 3 });
    expect(r.summary.patientsCreated).toBe(3);
    const erika = await inOrg(i.org, (tx) => tx.select().from(s.patients).where(and(eq(s.patients.organizationId, i.org), eq(s.patients.lastName, "Musterfrau"))));
    expect(erika).toHaveLength(1);
    const appts = await inOrg(i.org, (tx) => tx.select().from(s.appointments).where(eq(s.appointments.patientId, erika[0].id)));
    expect(appts).toEqual([]);
  });

  it("Excel ohne Legacy-ID: zweiter Lauf erkennt die Person über Name + Geburtsdatum (skipExisting)", async () => {
    const j = await practice("j");
    const base = await parseWorkbook(new Uint8Array(await buildWorkbook()));
    const one = { ...base, patients: [{ ...base.patients[1], legacyId: null }], invoices: [], vouchers: [], fixedCosts: [], services: [] };
    const first = await inOrg(j.org, (tx) => persistImport(tx as never, j.org, one, j.user, { skipExisting: true }));
    expect(first.patients).toBe(1);
    const second = await inOrg(j.org, (tx) => persistImport(tx as never, j.org, one, j.user, { skipExisting: true }));
    expect(second.patients).toBe(0);
    expect((await counts(j.org)).patients).toBe(1);
  });

  // ───────────── Review Runde 2 ─────────────
  it("S4: dieselbe Bestandsperson für zwei Zeilen gewählt → Import abgelehnt, nichts gespeichert", async () => {
    const k = await practice("k");
    const [old] = await inOrg(k.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: k.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self" }).returning(),
    );
    const H = "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";
    const csv = [H, "t-1;Frau;;Erika;Musterfrau;;03.04.1950;;;;;;;;;;;;Nein;GKV;", "t-2;Frau;;Erika;Musterfrau;;03.04.1950;;;;;;;;;;;;Nein;GKV;"].join("\n");
    const { d } = deps();
    const choices = { "tinana:t-1": old.id, "tinana:t-2": old.id };
    await expect(
      runUebernahme(d, { org: k.org, userId: k.user, files: [{ name: "patients_export_2026-01-15.csv", data: new TextEncoder().encode(csv) }], opts: { ...opts, choices }, tokenHash: `k-${stamp}`, auditMeta: {} }),
    ).rejects.toThrow(new ChoiceConflictError("Nr. 1 kann nur einmal verknüpft werden, bitte erneut prüfen."));
    expect((await counts(k.org)).patients).toBe(1);
    const [after] = await inOrg(k.org, (tx) => tx.select().from(s.patients).where(eq(s.patients.id, old.id)));
    expect(after.externalIds).toEqual({});
  });

  it("A-B1: Planen außerhalb der Transaktion – ändert sich der Bestand bis zum Schreiben, wird abgebrochen (bitte erneut prüfen)", async () => {
    const l = await practice("l");
    let phase = 0;
    const racing: RunDeps["inOrg"] = (org, fn) =>
      inOrg(org, async (tx) => {
        phase++;
        // eine andere Person legt zwischen Prüfung und Schreiben eine Patient:in an
        if (phase === 2) await tx.insert(s.patients).values({ organizationId: org, number: 99, lastName: "Dazwischen", insuranceType: "self" });
        return fn(tx as never);
      });
    const { d, stored, discarded } = deps({ inOrg: racing });
    await expect(runUebernahme(d, { org: l.org, userId: l.user, files: rawUpload(), opts, tokenHash: `l-${stamp}`, auditMeta: {} })).rejects.toBeInstanceOf(StaleSnapshotError);
    expect(discarded.sort()).toEqual([...stored].sort());
    expect(await counts(l.org)).toEqual({ patients: 0, appointments: 0, services: 0, prescriptions: 0, media: 0, invoices: 0 });
  });

  it("A-H1: Einmal-Token – nur Audit-Einträge der letzten 20 Minuten werden durchsucht", async () => {
    const m = await practice("m");
    const token = `m-${stamp}`;
    // derselbe Token-Hash vor 30 Minuten (Token gelten 15 Minuten) blockiert nicht
    await inOrg(m.org, (tx) => tx.insert(s.auditLog).values({ organizationId: m.org, userId: m.user, action: "import.uebernahme.run", meta: { token }, at: new Date(Date.now() - 30 * 60_000) }));
    const { d } = deps();
    await expect(runUebernahme(d, { org: m.org, userId: m.user, files: rawUpload(), opts, tokenHash: token, auditMeta: {} })).resolves.toMatchObject({ summary: { patientsCreated: 4 } });
    await expect(runUebernahme(d, { org: m.org, userId: m.user, files: rawUpload(), opts, tokenHash: token, auditMeta: {} })).rejects.toBeInstanceOf(TokenUsedError);
  });

  it("verknüpfte Person zählt einmal, auch mit Tinana- UND Doctolib-ID im selben Lauf", async () => {
    const n = await practice("n");
    const [old] = await inOrg(n.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: n.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self" }).returning(),
    );
    const doctolib = writeDoctolibPatientsCsv([{ externalId: "d-1", lastName: "Musterfrau", firstName: "Erika", birthDate: "1950-04-03" }], { delimiter: ",", bom: false });
    const files = await collectFiles([...rawUpload(), { name: "doctolib.csv", data: new TextEncoder().encode(doctolib) }]);
    const r = await run(n, files);
    expect(r.plan.patientsLink.filter((x) => x.patientId === old.id).map((x) => x.key).sort()).toEqual(["doctolib", "tinana"]);
    expect(r.plan.totals.patientsLinked).toBe(1);
    expect(r.summary.patientsLinked).toBe(1);
    const [after] = await inOrg(n.org, (tx) => tx.select().from(s.patients).where(eq(s.patients.id, old.id)));
    expect(after.externalIds).toEqual({ tinana: "10000000-0000-4000-8000-000000000001", doctolib: "d-1" });
  });

  it("Excel + Tinana im selben Lauf: Excel-Zeile ohne Legacy-ID wird nicht doppelt angelegt, Legacy-Nummern bleiben", async () => {
    const o = await practice("o");
    const base = await parseWorkbook(new Uint8Array(await buildWorkbook()));
    const excel = {
      ...base,
      patients: [
        { ...base.patients[0], legacyId: 5 },
        { ...base.patients[1], legacyId: null, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03" },
      ],
      invoices: [],
      vouchers: [],
      fixedCosts: [],
      services: [],
    };
    const files = [...(await tinanaUpload()), { name: "r.xlsx", sha256: "x", size: 1, kind: "podohero.excel" as const, source: "podohero-excel" as const, label: "Excel", target: "–", status: "import" as const, records: 2, issues: [], excel }];
    const r = await run(o, files);
    expect(r.plan.totals.excel).toMatchObject({ patientsNew: 1, patientsExisting: 1 });
    expect(r.summary.excel?.patients).toBe(1);
    const all = await inOrg(o.org, (tx) => tx.select().from(s.patients).where(eq(s.patients.organizationId, o.org)));
    expect(all.filter((p) => p.lastName === "Musterfrau")).toHaveLength(1);
    expect(all.find((p) => (p.externalIds as Record<string, unknown>).legacyExcel === 5)?.number).toBe(5);
    expect(Math.min(...all.filter((p) => (p.externalIds as Record<string, unknown>).tinana).map((p) => p.number))).toBeGreaterThan(5);
  });

  it("A-H2: Excel-Zeile MIT Legacy-ID einer gelöschten Person wird nicht neu angelegt", async () => {
    const q = await practice("q");
    await inOrg(q.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: q.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self", contactErasedAt: new Date(), archivedAt: new Date() }),
    );
    const base = await parseWorkbook(new Uint8Array(await buildWorkbook()));
    const one = { ...base, patients: [{ ...base.patients[0], legacyId: 9001, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03" }], invoices: [], vouchers: [], fixedCosts: [], services: [] };
    const r = await inOrg(q.org, (tx) => persistImport(tx as never, q.org, one, q.user, { skipExisting: true }));
    expect(r.patients).toBe(0);
    expect(r.warnings.some((w) => /gelöscht, nicht übernommen/.test(w.message))).toBe(true);
    expect((await counts(q.org)).patients).toBe(1);
  });

  it("K2: Excel-Rechnung ohne Rechnungsdatum – bezahlt vermerkt, aber keine Zahlungszeile mit „heute“", async () => {
    const r2 = await practice("r2");
    const base = await parseWorkbook(new Uint8Array(await buildWorkbook()));
    const inv = base.invoices.find((i) => i.payments.length > 0)!;
    expect(inv).toBeDefined();
    const one = { ...base, patients: [], vouchers: [], fixedCosts: [], invoices: [{ ...inv, issuedAt: null, patientLegacyId: null }] };
    const res = await inOrg(r2.org, (tx) => persistImport(tx as never, r2.org, one, r2.user, { skipExisting: true }));
    expect(res.payments).toBe(0);
    expect(res.warnings.some((w) => /ohne Rechnungsdatum – Zahlung nur an der Rechnung vermerkt/.test(w.message))).toBe(true);
    const [row] = await inOrg(r2.org, (tx) => tx.select().from(s.invoices).where(and(eq(s.invoices.organizationId, r2.org), eq(s.invoices.number, inv.number))));
    expect(row.paidCents).toBe(Math.min(inv.totalCents, inv.payments.reduce((a, p) => a + p.amountCents, 0)));
    expect(row.status).toBe(inv.status);
    const pays = await inOrg(r2.org, (tx) => tx.select().from(s.payments).where(eq(s.payments.invoiceId, row.id)));
    expect(pays).toEqual([]);
  });
  // ───────────── Review Runde 3 ─────────────
  it("AppSec H1: Schreib-Transaktion mit lock_timeout 10 s und statement_timeout 120 s (nur dort, SET LOCAL)", async () => {
    const t = await practice("h1");
    const seen: { lock: string; stmt: string }[] = [];
    const probing: RunDeps["inOrg"] = (org, fn) =>
      inOrg(org, async (tx) => {
        const r = await fn(tx as never);
        const lock = (await tx.execute<{ lock_timeout: string }>(sql`show lock_timeout`)).rows[0].lock_timeout;
        const stmt = (await tx.execute<{ statement_timeout: string }>(sql`show statement_timeout`)).rows[0].statement_timeout;
        seen.push({ lock, stmt });
        return r;
      });
    const { d } = deps({ inOrg: probing });
    await runUebernahme(d, { org: t.org, userId: t.user, files: rawUpload(), opts, tokenHash: `h1-${stamp}`, auditMeta: {} });
    // (1) Bestand laden: Standard; (3) Schreiben: begrenzt
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ lock: "0", stmt: "0" });
    expect(seen[1]).toEqual({ lock: "10s", stmt: "2min" });
    // SET LOCAL: die nächste Transaktion hat wieder den Standard
    const after = await inOrg(t.org, async (tx) => (await tx.execute<{ lock_timeout: string }>(sql`show lock_timeout`)).rows[0].lock_timeout);
    expect(after).toBe("0");
  });

  it("AppSec H1: hängende Dokument-Ablage bricht nach der Zeitgrenze ab, nichts gespeichert", async () => {
    const t = await practice("h1s");
    const { d } = deps({ store: () => new Promise(() => {}), storeTimeoutMs: 50 });
    await expect(runUebernahme(d, { org: t.org, userId: t.user, files: rawUpload(), opts, tokenHash: `h1s-${stamp}`, auditMeta: {} })).rejects.toBeInstanceOf(StoreTimeoutError);
    expect(await counts(t.org)).toEqual({ patients: 0, appointments: 0, services: 0, prescriptions: 0, media: 0, invoices: 0 });
  });

  /** Ablage, die nach `ms` fertig wird (ohne Datei), und Mitschrift der entfernten Schlüssel */
  function slowStore(ms: number) {
    const stored: string[] = [];
    const discarded: string[] = [];
    let n = 0;
    const store = (_org: string, data: Buffer) =>
      new Promise<{ storageKey: string; sha256: string; sizeBytes: number }>((resolve) =>
        setTimeout(() => {
          const storageKey = `late-${++n}`;
          stored.push(storageKey);
          resolve({ storageKey, sha256: "x", sizeBytes: data.length });
        }, ms),
      );
    const discard = async (k: string) => void discarded.push(k);
    return { store, discard, stored, discarded };
  }

  it("Runde 4 R3: verspätet doch fertige Ablage (nach der Zeitgrenze) wird wieder entfernt", async () => {
    const t = await practice("r4l");
    const slow = slowStore(120);
    const { d } = deps({ store: slow.store, discard: slow.discard, storeTimeoutMs: 30 });
    await expect(runUebernahme(d, { org: t.org, userId: t.user, files: rawUpload(), opts, tokenHash: `r4l-${stamp}`, auditMeta: {} })).rejects.toBeInstanceOf(StoreTimeoutError);
    expect(slow.stored).toEqual([]);
    await new Promise((r) => setTimeout(r, 250));
    expect(slow.stored).toEqual(["late-1"]);
    expect(slow.discarded).toEqual(["late-1"]);
    expect(await counts(t.org)).toEqual({ patients: 0, appointments: 0, services: 0, prescriptions: 0, media: 0, invoices: 0 });
  });

  it("Runde 4 R7: Gesamt-Zeitgrenze für alle Ablagen eines Laufs – jede einzelne schnell genug, zusammen zu lang", async () => {
    const t = await practice("r4t");
    const slow = slowStore(60);
    const { d } = deps({ store: slow.store, discard: slow.discard, storeTimeoutMs: 5_000, storeTotalTimeoutMs: 90 });
    await expect(runUebernahme(d, { org: t.org, userId: t.user, files: rawUpload(), opts, tokenHash: `r4t-${stamp}`, auditMeta: {} })).rejects.toBeInstanceOf(StoreTimeoutError);
    await new Promise((r) => setTimeout(r, 200));
    // erste Ablage rechtzeitig (beim Abbruch entfernt), zweite nach Ablauf der Gesamtgrenze fertig (verspätet entfernt)
    expect(slow.stored).toEqual(["late-1", "late-2"]);
    expect([...slow.discarded].sort()).toEqual(["late-1", "late-2"]);
    expect(await counts(t.org)).toEqual({ patients: 0, appointments: 0, services: 0, prescriptions: 0, media: 0, invoices: 0 });
  });

  it("AppSec H3:Person zwischen Planung und Schreiben gelöscht (Art. 17) – keine Verknüpfung, keine Termine/Verordnungen", async () => {
    const t = await practice("h3");
    const [old] = await inOrg(t.org, (tx) =>
      tx.insert(s.patients).values({ organizationId: t.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self" }).returning(),
    );
    const files = await tinanaUpload();
    const r = await inOrg(t.org, async (tx) => {
      const existing = await loadExisting(tx as never, t.org, []);
      const plan = buildPlan(files, existing, { prescriptionMode: "active", now: new Date("2026-01-13T08:00:00Z") });
      expect(plan.patientsLink.map((l) => l.patientId)).toContain(old.id);
      expect(plan.appointments.some((a) => "existingId" in a.patient && a.patient.existingId === old.id) || plan.prescriptions.some((p) => "existingId" in p.patient && p.patient.existingId === old.id)).toBe(true);
      // Löschung nach der Planung (an der Fingerabdruck-Prüfung vorbei: applyPlan direkt)
      await tx.update(s.patients).set({ contactErasedAt: new Date() }).where(eq(s.patients.id, old.id));
      return applyPlan(tx as never, t.org, t.user, plan, (d) => storeEncrypted(t.org, d));
    });
    expect(r.patientsLinked).toBe(0);
    const [after] = await inOrg(t.org, (tx) => tx.select().from(s.patients).where(eq(s.patients.id, old.id)));
    expect(after.externalIds).toEqual({});
    const appts = await inOrg(t.org, (tx) => tx.select().from(s.appointments).where(eq(s.appointments.patientId, old.id)));
    const rx = await inOrg(t.org, (tx) => tx.select().from(s.prescriptions).where(eq(s.prescriptions.patientId, old.id)));
    const media = await inOrg(t.org, (tx) => tx.select().from(s.media).where(eq(s.media.patientId, old.id)));
    expect([appts, rx, media]).toEqual([[], [], []]);
  });

  it("Code-Review Runde 3: ChoiceConflictError nennt alle doppelt gewählten Nummern", async () => {
    const k = await practice("k3");
    const [a, b] = await inOrg(k.org, (tx) =>
      tx
        .insert(s.patients)
        .values([
          { organizationId: k.org, number: 1, firstName: "Erika", lastName: "Musterfrau", birthDate: "1950-04-03", insuranceType: "self" },
          { organizationId: k.org, number: 2, firstName: "Max", lastName: "Mustermann", birthDate: "1948-02-01", insuranceType: "self" },
        ])
        .returning(),
    );
    const H = "patienten_id;anrede;titel;vorname;nachname;geschlecht;geburtsdatum;strasse;hausnummer;plz;stadt;standort;email;telefon_1_label;telefon_1;telefon_2_label;telefon_2;notiz;vip;versicherungstyp;erstellt_am";
    const csv = [
      H,
      "t-1;Frau;;Erika;Musterfrau;;03.04.1950;;;;;;;;;;;;Nein;GKV;",
      "t-2;Frau;;Erika;Musterfrau;;03.04.1950;;;;;;;;;;;;Nein;GKV;",
      "t-3;Herr;;Max;Mustermann;;01.02.1948;;;;;;;;;;;;Nein;GKV;",
      "t-4;Herr;;Max;Mustermann;;01.02.1948;;;;;;;;;;;;Nein;GKV;",
    ].join("\n");
    const { d } = deps();
    const choices = { "tinana:t-1": a.id, "tinana:t-2": a.id, "tinana:t-3": b.id, "tinana:t-4": b.id };
    await expect(
      runUebernahme(d, { org: k.org, userId: k.user, files: [{ name: "patients_export_2026-01-15.csv", data: new TextEncoder().encode(csv) }], opts: { ...opts, choices }, tokenHash: `k3-${stamp}`, auditMeta: {} }),
    ).rejects.toThrow(new ChoiceConflictError("Nr. 1 und 2 können jeweils nur einmal verknüpft werden, bitte erneut prüfen."));
    expect((await counts(k.org)).patients).toBe(2);
  });
  it("Pododesk-Gesamtexport: Patient:innen, Leistungen, Termine und Farbe – zweiter Lauf legt nichts doppelt an, überschreibt nichts", async () => {
    const pd = await practice("pododesk");
    // vorhandene Leistung mit gleichem Kürzel bleibt unverändert
    await inOrg(pd.org, (tx) => tx.insert(s.services).values({ organizationId: pd.org, code: "NAG", name: "Nagelpflege (Bestand)", priceCents: 3100, vatRate: 0 }));
    const PD_NOW = new Date("2026-11-16T10:00:00Z");
    const first = await run(pd, await pododeskUpload(), "billed", PD_NOW);
    expect(first.summary).toMatchObject({ patientsCreated: 3, patientsLinked: 0, appointments: 5, prescriptions: 0, documents: 0, services: 2, therapistColors: 1, excel: null });

    const rows = await inOrg(pd.org, async (tx) => ({
      patients: await tx.select().from(s.patients).where(eq(s.patients.organizationId, pd.org)),
      appts: await tx.select().from(s.appointments).where(eq(s.appointments.organizationId, pd.org)),
      links: await tx.select().from(s.appointmentServices).where(eq(s.appointmentServices.organizationId, pd.org)),
      services: await tx.select().from(s.services).where(eq(s.services.organizationId, pd.org)),
      member: (await tx.select().from(s.memberships).where(eq(s.memberships.organizationId, pd.org)))[0],
      consents: await tx.select().from(s.consents).where(eq(s.consents.organizationId, pd.org)),
      reminders: await tx.select().from(s.reminderLog).where(eq(s.reminderLog.organizationId, pd.org)),
      users: await tx.select({ id: s.memberships.id }).from(s.memberships).where(eq(s.memberships.organizationId, pd.org)),
    }));
    const paula = rows.patients.find((p) => p.lastName === "Beispiel")!;
    expect(paula).toMatchObject({
      externalIds: { pododesk: "1" },
      source: "pododesk-import",
      preferredChannel: "none",
      insuranceType: "gkv",
      insurerName: "Beispiel-BKK",
      insuranceNumber: "X000000001",
      gpName: "Dr. med. Hanna Beispielarzt",
      email: "paula.beispiel@example.org",
      birthDate: "1953-04-15",
    });
    // Einwilligungen aus Pododesk (emailErinnerung/smsReminder/emailNewsletter) werden nie übernommen
    expect(rows.consents).toEqual([]);
    expect(rows.reminders).toEqual([]);
    expect(rows.patients.every((p) => p.preferredChannel === "none")).toBe(true);
    expect((rows.patients.find((p) => p.lastName === "Beispiel-Muster")!.extra as Record<string, { date: string }>).deceased.date).toBe("2026-10-01");
    // keine Nutzerkonten aus users.csv
    expect(rows.users).toHaveLength(1);
    expect(rows.member.color).toBe("teal");
    // Leistungen: zwei neu, „NAG“ unverändert, gelöschte „ALT“ nicht
    expect(rows.services.map((x) => x.code).sort()).toEqual(["DFa2 priv.", "NAG", "PKB"]);
    expect(rows.services.find((x) => x.code === "NAG")).toMatchObject({ name: "Nagelpflege (Bestand)", priceCents: 3100, vatRate: 0 });
    expect(rows.services.find((x) => x.code === "DFa2 priv.")).toMatchObject({ priceCents: 1200, vatRate: 19, durationMin: 30, requiresTherapeuticPurpose: false });
    expect(rows.services.find((x) => x.code === "PKB")).toMatchObject({ priceCents: 4500, vatRate: 0, durationMin: 45, requiresTherapeuticPurpose: true });
    // Termine: Quelle „import“ (nicht abrechenbar), UTC korrekt, Zuordnung über Quell-IDs
    expect(rows.appts.every((a) => a.source === "import" && a.externalId?.startsWith("pododesk:"))).toBe(true);
    const a101 = rows.appts.find((a) => a.externalId === "pododesk:101")!;
    expect(a101).toMatchObject({ status: "done", therapistId: pd.user, patientId: paula.id });
    expect(a101.startsAt.toISOString()).toBe("2026-01-13T08:00:00.000Z");
    expect(rows.appts.find((a) => a.externalId === "pododesk:102")!.startsAt.toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(rows.appts.find((a) => a.externalId === "pododesk:103")).toMatchObject({ status: "planned" });
    expect(rows.appts.find((a) => a.externalId === "pododesk:104")).toMatchObject({ status: "cancelled" });
    const svc = new Map(rows.services.map((x) => [x.id, x.code]));
    const linksOf = (ext: string) => rows.links.filter((l) => l.appointmentId === rows.appts.find((a) => a.externalId === ext)!.id).map((l) => svc.get(l.serviceId));
    expect(linksOf("pododesk:101")).toEqual(["DFa2 priv."]);
    expect(linksOf("pododesk:103")).toEqual(["NAG"]);
    expect(linksOf("pododesk:104")).toEqual([]);

    const second = await run(pd, await pododeskUpload(), "billed", PD_NOW);
    expect(second.summary).toMatchObject({ patientsCreated: 0, patientsLinked: 0, appointments: 0, services: 0, therapistColors: 0 });
    expect(second.plan.hasWork).toBe(false);
    const after = await counts(pd.org);
    expect(after).toMatchObject({ patients: 3, appointments: 5, services: rows.links.length });
  });
});
