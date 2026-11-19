/**
 * GKV Paket E gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten): neutrales Übergabepaket je Abrechnungslauf
 * (Inhalt, Archiv beim ersten Export, Nachdruck byte-gleich), Unveränderlichkeit von Archiv und Auszahlungen (Trigger,
 * Rechte, Mandanten), Rückmeldung einlesen (Vorschau, Zuordnung, Bestätigen, doppeltes Einlesen), Auszahlung von Hand,
 * Auswertung Zahlungseingang.
 */
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { RUECKMELDUNG_SPALTEN } from "@/lib/gkv-handover/rueckmeldung";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const ownerUrl = () => process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@");

(TEST_DB ? describe : describe.skip)("GKV Paket E – Übergabepaket, Archiv, Rückmeldung (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let presc: typeof import("./prescriptions");
  let gb: typeof import("./gkv-billing");
  let ho: typeof import("./gkv-handover");
  let stats: typeof import("./gkv-stats");
  let dbm: typeof import("@/db");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    presc = await import("./prescriptions");
    gb = await import("./gkv-billing");
    ho = await import("./gkv-handover");
    stats = await import("./gkv-stats");
    dbm = await import("@/db");
    today = (await import("@/lib/format")).berlinDateIso();
  });
  afterAll(async () => {
    await fx.end();
    await (dbm.db.$client as { end: () => Promise<void> }).end();
  });

  const world = async () => {
    const org = await fx.org();
    const user = await fx.user(org);
    const patient = await fx.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    await fx.asOrg(org, (c) => c.query("update patients set birth_date = '1950-03-01', insurance_type = 'gkv', insurer_name = 'Test-BKK' where id = $1", [patient]));
    await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    const authWith = (perms: string[] | "all", o: { support?: boolean; billingMode?: string } = {}) =>
      ({
        organization: { id: org, name: "Testpraxis", slug: "t", smallBusiness: false, state: "BB", billingMode: o.billingMode ?? "with_gkv" },
        user: { id: user, name: "Anna Test" },
        role: "owner",
        readOnly: false,
        support: o.support ? { adminId: user } : null,
        can: (p: string) => perms === "all" || perms.includes(p),
      }) as never;
    const auth = authWith("all");
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    let n = 0;
    const vo = async (issuedOffset = -30, insuranceNumber = "A000500015") =>
      (
        await q<{ id: string }>(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, doctor_name, frequency_per_week,
             prescription_kind, prescription_kind_confirmed_at)
           values ($1,$2,$3,'DF',2,'completed',($3::date + 28),$4,$5,'E11.74','109911114',$6,'1','123456601','123456789',true,'c','Dr. Beispiel','1x alle 4-6 Wochen','03', now()) returning id`,
          [org, patient, addDaysIso(today, issuedOffset), JSON.stringify([{ position: "78020", label: "groß", units: 2 }]), RULES_VERSION, insuranceNumber],
        )
      )[0].id;
    const past = async (prescriptionId: string, day: string) => {
      const [r] = await q<{ id: string }>("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prescription_id, hash, prev_hash) values ($1,$2,$3,$4,$5,$6,$7) returning id", [
        org,
        patient,
        user,
        berlinToUtc(day, "10:00"),
        prescriptionId,
        `h-${Math.random()}`,
        `p-${++n}-${Math.random()}`,
      ]);
      await q("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by) values ($1,$2,$3,$4,'paper',$5)", [org, r.id, patient, prescriptionId, user]);
    };
    /** Lauf mit `count` abgerechneten Verordnungen (verschiedene Ausstellungstage) */
    const batch = async (count = 1, insuranceNumber = "A000500015") => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = await vo(-30 - i, insuranceNumber);
        await past(id, addDaysIso(today, -20));
        await past(id, addDaysIso(today, -10));
        expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toEqual({ ok: true });
        ids.push(id);
      }
      const b = await presc.createBillingBatch(auth, ids, { partner: "other" });
      if ("error" in b) throw new Error(b.error);
      return { batchId: b.id, ids };
    };
    return { org, user, patient, auth, authWith, q, vo, past, batch };
  };

  const unzip = async (bytes: Uint8Array) => {
    const zip = await JSZip.loadAsync(bytes);
    const files: Record<string, Buffer> = {};
    for (const [name, f] of Object.entries(zip.files)) if (!f.dir) files[name] = Buffer.from(await f.async("uint8array"));
    return files;
  };

  it("E1: Übergabepaket – Inhalt (CSV/JSON/PDF/Prüfsummen), Archiv beim ersten Export, Nachdruck byte-gleich", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(2);
    const first = await ho.handoverPackage(w.auth, batchId);
    if (!first || "error" in first) throw new Error("kein Paket");
    expect(first.reprint).toBe(false);
    expect(first.filename).toMatch(/^Uebergabe-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/);
    expect(first.sha256).toBe(sha(first.bytes));
    // Archiv-Zeile mit Prüfsumme; Lauf als übergeben vermerkt
    const [arch] = await w.q<{ sha256: string; size_bytes: number; after_first_handover: boolean; storage_key: string; kind: string; prescription_count: number }>(
      "select sha256, size_bytes, after_first_handover, storage_key, kind, prescription_count from billing_batch_exports where billing_batch_id = $1",
      [batchId],
    );
    expect(arch).toMatchObject({ sha256: first.sha256, size_bytes: first.bytes.length, after_first_handover: false, kind: "handover_zip", prescription_count: 2 });
    expect(arch.storage_key.startsWith(`${w.org}/`)).toBe(true);
    const [b] = await w.q<{ exported_at: Date | null; status: string }>("select exported_at, status from billing_batches where id = $1", [batchId]);
    expect(b.status).toBe("exported");
    expect(b.exported_at).not.toBeNull();

    const files = await unzip(first.bytes);
    const names = Object.keys(files);
    expect(names.filter((n) => !n.startsWith("dokumente/")).sort()).toEqual(["LIESMICH.txt", "PRUEFSUMMEN.sha256", "abrechnungslauf.json", "begleitzettel.pdf", "behandlungen.csv", "verordnungen.csv"]);
    const docs = names.filter((n) => n.startsWith("dokumente/"));
    expect(docs).toHaveLength(2);
    for (const id of ids) expect(docs.some((n) => new RegExp(`^dokumente/leistungsnachweis/Leistungsnachweis_.*${id.slice(0, 8)}\\.pdf$`).test(n))).toBe(true);
    for (const d of docs) expect(files[d].subarray(0, 5).toString()).toBe("%PDF-");
    // Prüfsummen stimmen für jede Datei
    const sums = files["PRUEFSUMMEN.sha256"].toString("utf8").trim().split("\n").map((l) => l.split("  "));
    expect(sums.length).toBe(Object.keys(files).length - 1);
    for (const [h, name] of sums) expect(sha(files[name])).toBe(h);
    // CSV: BOM, Semikolon, Kopf mit bisherigen + neuen Spalten, je Verordnung eine Zeile
    const csv = files["verordnungen.csv"];
    expect([...csv.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = csv.toString("utf8").slice(1).trim().split("\r\n");
    expect(lines[0].split(";").slice(0, 3)).toEqual(["Lauf-ID", "Verordnung-ID", "Versichertennummer"]);
    expect(lines[0]).toContain("Kassenanteil EUR");
    expect(lines.length).toBe(3);
    const beh = files["behandlungen.csv"].toString("utf8").slice(1).trim().split("\r\n");
    expect(beh.length).toBe(1 + 2 * 2); // je Verordnung 2 Behandlungstage × 1 Position
    expect(beh[1]).toContain(";Papier");
    const json = JSON.parse(files["abrechnungslauf.json"].toString("utf8"));
    expect(json.schema).toBe("podohero-abrechnung/1");
    expect(json.lauf.id).toBe(batchId);
    expect(json.verordnungen).toHaveLength(2);
    expect(json.verordnungen[0]).toMatchObject({ versicherung: { kassen_ik: "109911114", versichertennummer: "A000500015" }, arzt: { lanr: "123456601", bsnr: "123456789" }, diagnose: { icd10: "E11.74" } });
    expect(json.summen_verordnungen.heilmittelkosten_cent).toBe(json.lauf.heilmittelkosten_cent);
    expect(files["begleitzettel.pdf"].subarray(0, 5).toString()).toBe("%PDF-");

    // Nachdruck: exakt dieselbe Datei, gekennzeichnet; kein zweites Archiv
    const again = await ho.handoverPackage(w.auth, batchId);
    if (!again || "error" in again) throw new Error("kein Paket");
    expect(again.reprint).toBe(true);
    expect(Buffer.compare(again.bytes, first.bytes)).toBe(0);
    expect(again.filename).toMatch(/-Nachdruck\.zip$/);
    expect((await w.q("select 1 from billing_batch_exports where billing_batch_id = $1", [batchId])).length).toBe(1);
    // CSV-Download = Verordnungen-CSV aus dem Archiv
    const csvDl = await ho.handoverCsv(w.auth, batchId);
    if (!csvDl || "error" in csvDl) throw new Error("keine CSV");
    expect(Buffer.compare(csvDl.bytes, csv)).toBe(0);
    expect(csvDl.reprint).toBe(true);
    // Audit ohne Gesundheitsdaten (nur IDs, Zahlen, Prüfsumme)
    const audits = await w.q<{ action: string; meta: Record<string, unknown> }>("select action, meta from audit_log where organization_id = $1 and action like 'billing_batch.handover%' order by id", [w.org]);
    expect(audits.map((a) => a.action)).toEqual(["billing_batch.handover", "billing_batch.handover", "billing_batch.handover"]);
    expect(JSON.stringify(audits)).not.toMatch(/E11|Musterfrau|A000500015/);
  });

  it("E2: Lauf schon vor Paket E übergeben → Archiv „nach Erstübergabe“ (vom Trigger gesetzt), Hinweis im LIESMICH", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    expect(await presc.billingBatchExport(w.auth, batchId)).not.toBeNull(); // alter CSV-Weg vermerkt die Übergabe
    const p = await ho.handoverPackage(w.auth, batchId);
    if (!p || "error" in p) throw new Error("kein Paket");
    expect(p.afterFirstHandover).toBe(true);
    const files = await unzip(p.bytes);
    expect(files["LIESMICH.txt"].toString("utf8")).toMatch(/bereits am .* übergeben/);
    const [row] = await w.q<{ after_first_handover: boolean }>("select after_first_handover from billing_batch_exports where billing_batch_id = $1", [batchId]);
    expect(row.after_first_handover).toBe(true);
  });

  it("E3: Archiv und Auszahlungen append-only (App-Rolle ohne UPDATE/DELETE, Trigger auch für den Eigentümer), Speicherschlüssel und Lauf nur der eigenen Praxis", async () => {
    const w = await world();
    const other = await world();
    const { batchId } = await w.batch(1);
    const p = await ho.handoverPackage(w.auth, batchId);
    if (!p || "error" in p) throw new Error("kein Paket");
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 1000, paidAt: addDaysIso(today, -1), reference: "SR-1" })).toEqual({ id: expect.any(String) });
    for (const t of ["billing_batch_exports", "billing_batch_payouts"]) {
      await expect(w.q(`update ${t} set created_at = now() where organization_id = $1`, [w.org])).rejects.toThrow(/permission denied/);
      await expect(w.q(`delete from ${t} where organization_id = $1`, [w.org])).rejects.toThrow(/permission denied/);
    }
    const owner = new Pool({ connectionString: ownerUrl(), max: 1 });
    try {
      const c = await owner.connect();
      try {
        const asOwner = async (sql: string, params: unknown[] = []) => {
          await c.query("begin");
          try {
            await c.query("select set_config('app.org_id', $1, true)", [w.org]);
            await c.query(sql, params);
          } finally {
            await c.query("rollback");
          }
        };
        await expect(asOwner("update billing_batch_exports set sha256 = repeat('0', 64) where billing_batch_id = $1", [batchId])).rejects.toThrow(/unveränderlich/);
        await expect(asOwner("delete from billing_batch_exports where billing_batch_id = $1", [batchId])).rejects.toThrow(/unveränderlich/);
        await expect(asOwner("update billing_batch_payouts set amount_cents = 1 where billing_batch_id = $1", [batchId])).rejects.toThrow(/unveränderlich/);
        await expect(asOwner("delete from billing_batch_payouts where billing_batch_id = $1", [batchId])).rejects.toThrow(/unveränderlich/);
        await expect(asOwner("truncate billing_batch_payouts cascade")).rejects.toThrow(/geleert/);
        await expect(asOwner("truncate billing_batch_exports")).rejects.toThrow(/geleert/);
      } finally {
        c.release();
      }
    } finally {
      await owner.end();
    }
    // fremder Speicherschlüssel, fremder Lauf, fremde Person, fremde Praxis-ID → abgelehnt; created_at vom Server
    const { batchId: otherBatch } = await other.batch(1);
    const ins = (orgKey: string, batch: string, createdBy: string) =>
      w.q(
        "insert into billing_batch_exports (organization_id, billing_batch_id, kind, storage_key, sha256, size_bytes, filename, schema_version, prescription_count, created_by, created_at) values ($1,$2,'handover_zip',$3,repeat('a',64),1,'x.zip','podohero-abrechnung/1',1,$4,'2000-01-01') returning created_at, after_first_handover",
        [w.org, batch, `${orgKey}/2026/11/x.bin`, createdBy],
      );
    await expect(ins(other.org, batchId, w.user)).rejects.toThrow(/Speicherschlüssel/);
    await expect(ins(w.org, otherBatch, w.user)).rejects.toThrow();
    await expect(ins(w.org, batchId, other.user)).rejects.toThrow();
    // zweites Archiv desselben Laufs → eindeutiger Index
    await expect(ins(w.org, batchId, w.user)).rejects.toThrow(/billing_batch_exports_batch_kind/);
    await expect(
      w.q("insert into billing_batch_payouts (organization_id, billing_batch_id, amount_cents, paid_at, source, created_by) values ($1,$2,1,'2026-01-01','manual',$3)", [w.org, otherBatch, w.user]),
    ).rejects.toThrow();
    // RLS: andere Praxis sieht nichts
    expect(await other.q("select * from billing_batch_exports where billing_batch_id = $1", [batchId])).toEqual([]);
    expect(await ho.handoverPackage(other.auth, batchId)).toBeNull();
  });

  it("E4: Rechte – invoices.write + medical.read, Kassenabrechnung aktiv, Support ändert nichts", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    await expect(ho.handoverPackage(w.authWith(["invoices.write"]), batchId)).rejects.toThrow(/medical.read/);
    await expect(ho.handoverPackage(w.authWith(["medical.read"]), batchId)).rejects.toThrow(/invoices.write/);
    expect(await ho.handoverPackage(w.authWith("all", { billingMode: "private_only" }), batchId)).toEqual({ error: expect.any(String) });
    expect((await w.q("select 1 from billing_batch_exports where billing_batch_id = $1", [batchId])).length).toBe(0);
    await ho.handoverPackage(w.auth, batchId);
    const support = w.authWith("all", { support: true });
    expect(await ho.recordManualPayout(support, { batchId, amountCents: 1, paidAt: today, reference: null })).toEqual({ error: expect.stringMatching(/Support/) });
    expect(await ho.previewPayoutImport(support, batchId, Buffer.from("x"), "r.csv")).toEqual({ error: expect.stringMatching(/Support/) });
  });

  const csvFile = (...rows: string[][]) => Buffer.from(`﻿${[RUECKMELDUNG_SPALTEN.join(";"), ...rows.map((r) => r.join(";"))].join("\r\n")}\r\n`);

  it("E5: Rückmeldung – Vorschau mit Zuordnung (ID bzw. Versichertennummer + Datum), anderer Lauf übersprungen, Bestätigen legt Auszahlung und Absetzungen an, kein doppeltes Einlesen", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(2);
    const paid = addDaysIso(today, -2);
    const file = csvFile(
      [ids[0], batchId, "", "", "50,00", "12,50", "R12", "Unterschrift unleserlich", paid, "SR-77"],
      ["", "", "A000500015", addDaysIso(today, -31), "60,00", "", "", "", paid, "SR-77"],
      ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "", "", "1,00", "", "", "", paid, "SR-77"],
    );
    // Lauf noch nicht übergeben → keine Rückmeldung
    expect(await ho.previewPayoutImport(w.auth, batchId, file, "r.csv")).toEqual({ error: expect.stringMatching(/übergeben/) });
    await ho.handoverPackage(w.auth, batchId);
    const prev = await ho.previewPayoutImport(w.auth, batchId, file, "r.csv");
    if ("error" in prev) throw new Error(prev.error);
    expect(prev.fehler).toEqual([]);
    expect(prev.andererLauf).toBe(1);
    expect(prev.zeilen.map((z) => z.prescriptionId)).toEqual([ids[0], ids[1]]);
    expect(prev.summeAusgezahltCent).toBe(11000);
    expect(prev.summeAbsetzungCent).toBe(1250);
    expect(prev.zeilen[0].sollCent).toBeGreaterThan(0);
    // nichts geändert, solange nicht bestätigt
    expect(await w.q("select 1 from billing_batch_payouts where billing_batch_id = $1", [batchId])).toEqual([]);
    // falsche Prüfsumme (Datei geändert) → abgelehnt
    expect(await ho.confirmPayoutImport(w.auth, batchId, file, "r.csv", "0".repeat(64))).toEqual({ error: expect.stringMatching(/geändert/) });
    const done = await ho.confirmPayoutImport(w.auth, batchId, file, "r.csv", prev.sha256);
    if ("error" in done) throw new Error(done.error);
    expect(done.deductions).toBe(1);
    const [pay] = await w.q<{ id: string; amount_cents: number; deduction_cents: number; paid_at: string; reference: string; source: string; line_count: number; details: unknown[] }>(
      "select id, amount_cents, deduction_cents, paid_at::text, reference, source, line_count, details from billing_batch_payouts where billing_batch_id = $1",
      [batchId],
    );
    expect(pay).toMatchObject({ amount_cents: 11000, deduction_cents: 1250, paid_at: paid, reference: "SR-77", source: "import", line_count: 2 });
    expect(pay.details).toEqual([
      { prescriptionId: ids[0], paidCents: 5000, deductionCents: 1250, feeCents: 0 },
      { prescriptionId: ids[1], paidCents: 6000, deductionCents: 0, feeCents: 0 },
    ]);
    const ded = await w.q<{ prescription_id: string; amount_cents: number; reason_code: string; status: string; payout_id: string; billing_batch_id: string; letter_ref: string; deducted_on: string }>(
      "select prescription_id, amount_cents, reason_code, status, payout_id, billing_batch_id, letter_ref, deducted_on::text from gkv_deductions where organization_id = $1",
      [w.org],
    );
    expect(ded).toEqual([{ prescription_id: ids[0], amount_cents: 1250, reason_code: "R12", status: "open", payout_id: pay.id, billing_batch_id: batchId, letter_ref: "SR-77", deducted_on: paid }]);
    // Verordnungen unverändert (keine stillen Änderungen)
    expect((await w.q<{ status: string }>("select status from prescriptions where id = any($1::uuid[])", [ids])).map((r) => r.status)).toEqual(["billed", "billed"]);
    // dieselbe Datei erneut → abgelehnt (Vorschau zeigt es an)
    const again = await ho.previewPayoutImport(w.auth, batchId, file, "r.csv");
    if ("error" in again) throw new Error(again.error);
    expect(again.bereitsEingelesen).toBe(true);
    expect(await ho.confirmPayoutImport(w.auth, batchId, file, "r.csv", prev.sha256)).toEqual({ error: expect.stringMatching(/bereits eingelesen/) });
    // Absetzung, die schon erfasst ist (gleiche Verordnung, Betrag, Code), wird nicht doppelt angelegt
    const file2 = csvFile([ids[0], "", "", "", "0", "12,50", "R12", "Unterschrift unleserlich", paid, "SR-78"]);
    const p2 = await ho.previewPayoutImport(w.auth, batchId, file2, "r2.csv");
    if ("error" in p2) throw new Error(p2.error);
    expect(p2.zeilen[0].absetzungVorhanden).toBe(true);
    const d2 = await ho.confirmPayoutImport(w.auth, batchId, file2, "r2.csv", p2.sha256);
    if ("error" in d2) throw new Error(d2.error);
    expect(d2.deductions).toBe(0);
    expect(d2.skippedDeductions).toBe(1);
    expect((await w.q("select 1 from gkv_deductions where organization_id = $1", [w.org])).length).toBe(1);
    // Audit ohne Gründe/Namen
    const audits = await w.q<{ meta: unknown }>("select meta from audit_log where organization_id = $1 and action = 'billing_batch.payout_import'", [w.org]);
    expect(audits.length).toBe(2);
    expect(JSON.stringify(audits)).not.toMatch(/unleserlich|Musterfrau|A000500015/);
  });

  it("E6: Rückmeldung – nicht zuordenbare oder mehrdeutige Zeilen, Widersprüche → Fehler, nichts gespeichert", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    const paid = addDaysIso(today, -2);
    const bad = csvFile(
      ["66666666-6666-4666-8666-666666666666", "", "", "", "5", "", "", "", paid, "SR"],
      [ids[0], "", "B999", "", "5", "", "", "", paid, "SR"], // Versichertennummer passt nicht zur Verordnung
    );
    const p = await ho.previewPayoutImport(w.auth, batchId, bad, "r.csv");
    if ("error" in p) throw new Error(p.error);
    expect(p.fehler.join("\n")).toMatch(/Zeile 2: .*nicht in diesem Abrechnungslauf/);
    expect(p.fehler.join("\n")).toMatch(/Zeile 3: .*Versichertennummer/);
    expect(await ho.confirmPayoutImport(w.auth, batchId, bad, "r.csv", p.sha256)).toEqual({ error: expect.any(String) });
    // Format-Fehler kommen aus der Prüfung der Datei
    const p2 = await ho.previewPayoutImport(w.auth, batchId, Buffer.from("kaputt"), "r.csv");
    if ("error" in p2) throw new Error(p2.error);
    expect(p2.fehler.length).toBeGreaterThan(0);
    expect(await w.q("select 1 from billing_batch_payouts where organization_id = $1", [w.org])).toEqual([]);
  });

  it("E7: Absetzung mit payout_id nur zu einer Auszahlung desselben Laufs; payout_id unveränderlich", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    const { batchId: otherBatch } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    await ho.handoverPackage(w.auth, otherBatch);
    const r = await ho.recordManualPayout(w.auth, { batchId: otherBatch, amountCents: 500, paidAt: addDaysIso(today, -1), reference: null });
    if ("error" in r) throw new Error(r.error);
    await expect(
      w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, billing_batch_id, amount_cents, reason, deducted_on, created_by, payout_id) values ($1,$2,$3,$4,100,'Test',$5,$6,$7)", [
        w.org,
        ids[0],
        w.patient,
        batchId,
        today,
        w.user,
        r.id,
      ]),
    ).rejects.toThrow(/Rückmeldung/);
    // payout_id ist unveränderlich
    const [d] = await w.q<{ id: string }>(
      "insert into gkv_deductions (organization_id, prescription_id, patient_id, billing_batch_id, amount_cents, reason, deducted_on, created_by) values ($1,$2,$3,$4,100,'Test',$5,$6) returning id",
      [w.org, ids[0], w.patient, batchId, today, w.user],
    );
    await expect(w.q("update gkv_deductions set payout_id = $2 where id = $1", [d.id, r.id])).rejects.toThrow(/unveränderlich/);
  });

  it("E8: Auszahlung von Hand (Prüfung) und Auswertung: Zahlungseingang je Monat neben dem Soll", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 100, paidAt: today, reference: null })).toEqual({ error: expect.stringMatching(/übergeben/) });
    await ho.handoverPackage(w.auth, batchId);
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 100, paidAt: addDaysIso(today, 3), reference: null })).toEqual({ error: expect.stringMatching(/Zukunft/) });
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 4321, paidAt: today, reference: "Avis 1" })).toEqual({ id: expect.any(String) });
    const info = await ho.batchHandoverInfo(w.auth, batchId);
    if (!info) throw new Error("kein Lauf");
    expect(info.archive?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.payouts.map((p) => p.amountCents)).toEqual([4321]);
    expect(info.paidCents).toBe(4321);
    const period = (await import("@/lib/stats")).resolvePeriod({ zeitraum: "monat" }, today);
    const s = await stats.gkvPrivateStats(w.auth, period);
    expect(s.payouts).toEqual({ count: 1, cents: 4321 });
    expect(s.months.find((m) => m.month === today.slice(0, 7))!.payoutCents).toBe(4321);
  });
  it("E9: Praxis-Export enthält das archivierte Übergabepaket byte-gleich (Zuordnung über exportFile)", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    const p = await ho.handoverPackage(w.auth, batchId);
    if (!p || "error" in p) throw new Error("kein Paket");
    const exp = await import("./practice-export");
    const result = await exp.buildPracticeExport({ organizationId: w.org, exportedBy: { name: "Inhaberin", email: "i@example.org" } });
    const chunks: Uint8Array[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const summary = await result.done;
    expect(summary).toMatchObject({ handoverFiles: 1, handoverErrors: 0 });
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const rows = JSON.parse(await zip.file("tables/billing_batch_exports.json")!.async("string"));
    expect(rows).toHaveLength(1);
    expect(rows[0].exportFile).toBe(`abrechnung/uebergabe/${batchId}/${rows[0].filename}`);
    expect(rows[0].storageKey).toBeUndefined();
    const inner = Buffer.from(await zip.file(rows[0].exportFile)!.async("uint8array"));
    expect(Buffer.compare(inner, p.bytes)).toBe(0);
    expect(JSON.parse(await zip.file("tables/billing_batch_payouts.json")!.async("string"))).toEqual([]);
  });
  it("E10: Verordnung des Laufs in Korrektur – Paket führt sie mit dem Stand der Erstabrechnung (Spalte Korrektur), Summen = Lauf", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(2);
    expect(await gb.markCorrectionNeeded(w.auth, { prescriptionId: ids[0], patientId: w.patient, reason: "ICD-Code prüfen" })).toEqual({ id: expect.any(String) });
    const p = await ho.handoverPackage(w.auth, batchId);
    if (!p || "error" in p) throw new Error("kein Paket");
    const files = await unzip(p.bytes);
    const json = JSON.parse(files["abrechnungslauf.json"].toString("utf8"));
    expect(json.verordnungen.map((v: { id: string }) => v.id).sort()).toEqual([...ids].sort());
    expect(json.verordnungen.find((v: { id: string }) => v.id === ids[0]).korrektur).toBe("Korrektur offen");
    expect(json.summen_verordnungen.heilmittelkosten_cent).toBe(json.lauf.heilmittelkosten_cent);
    expect(json.summen_verordnungen.zuzahlung_cent).toBe(json.lauf.zuzahlung_cent);
    // Rückmeldung zur Verordnung in Korrektur: zuordenbar, Absetzung möglich (abgerechnet laut billed_at)
    const paid = addDaysIso(today, -1);
    const prev = await ho.previewPayoutImport(w.auth, batchId, csvFile([ids[0], "", "", "", "10,00", "5,00", "", "Formfehler", paid, ""]), "r.csv");
    if ("error" in prev) throw new Error(prev.error);
    expect(prev.fehler).toEqual([]);
    expect(prev.zeilen[0].hinweise.join()).toMatch(/ohne Code/);
  });
  const csvGeb = (rows: string[][]) => Buffer.from(`${[[...RUECKMELDUNG_SPALTEN, "Gebühr EUR"].join(";"), ...rows.map((r) => r.join(";"))].join("\n")}\n`);
  const readPayouts = (w: Awaited<ReturnType<typeof world>>, batchId: string) =>
    w.q<{ id: string; amount_cents: number; deduction_cents: number; fee_cents: number; source: string; reverses_payout_id: string | null; reason: string | null; storage_key: string | null; source_sha256: string | null; paid_at: string }>(
      "select id, amount_cents, deduction_cents, fee_cents, source, reverses_payout_id, reason, storage_key, source_sha256, paid_at::text from billing_batch_payouts where billing_batch_id = $1 order by created_at, amount_cents desc",
      [batchId],
    );

  it("E11: Storno einer Auszahlung – Gegenbuchung exakt negativ, Pflichtbegründung, höchstens einmal, Storno nicht stornierbar; Summen rechnen Stornos mit", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    const pay = await ho.recordManualPayout(w.auth, { batchId, amountCents: 5000, feeCents: 300, paidAt: addDaysIso(today, -3), reference: "Avis 7" });
    if ("error" in pay) throw new Error(pay.error);
    expect(await ho.reversePayout(w.auth, { payoutId: pay.id, reason: "kurz" })).toEqual({ error: expect.stringMatching(/Begründung/) });
    const st = await ho.reversePayout(w.auth, { payoutId: pay.id, reason: "Betrag falsch erfasst" });
    if ("error" in st) throw new Error(st.error);
    const rows = await readPayouts(w, batchId);
    expect(rows.find((r) => r.id === st.id)).toMatchObject({ amount_cents: -5000, fee_cents: -300, deduction_cents: 0, source: "reversal", reverses_payout_id: pay.id, reason: "Betrag falsch erfasst", paid_at: today });
    expect(await ho.reversePayout(w.auth, { payoutId: pay.id, reason: "noch einmal storno" })).toEqual({ error: expect.stringMatching(/bereits storniert/) });
    expect(await ho.reversePayout(w.auth, { payoutId: st.id, reason: "Storno vom Storno" })).toEqual({ error: expect.stringMatching(/Storno/) });
    // Trigger: Storno mit abweichendem Betrag oder ohne Begründung abgelehnt (auch direkt per SQL)
    const pay2 = await ho.recordManualPayout(w.auth, { batchId, amountCents: 1000, paidAt: addDaysIso(today, -1), reference: null });
    if ("error" in pay2) throw new Error(pay2.error);
    const raw = (amount: number, reason: string | null) =>
      w.q("insert into billing_batch_payouts (organization_id, billing_batch_id, amount_cents, fee_cents, deduction_cents, paid_at, source, reverses_payout_id, reason, created_by) values ($1,$2,$3,0,0,$4,'reversal',$5,$6,$7)", [w.org, batchId, amount, today, pay2.id, reason, w.user]);
    await expect(raw(-999, "falscher Betrag")).rejects.toThrow(/Storno/);
    await expect(raw(-1000, null)).rejects.toThrow();
    await expect(w.q("insert into billing_batch_payouts (organization_id, billing_batch_id, amount_cents, paid_at, source, created_by) values ($1,$2,-5,$3,'manual',$4)", [w.org, batchId, today, w.user])).rejects.toThrow();
    // Summen: Lauf, Übersicht, Auswertung (Storno im Monat des Stornos)
    const info = await ho.batchHandoverInfo(w.auth, batchId);
    expect(info!.paidCents).toBe(1000);
    expect(info!.feeCents).toBe(0);
    expect((await ho.payoutTotals(w.auth)).get(batchId)!.cents).toBe(1000);
    const s = await stats.gkvPrivateStats(w.auth, (await import("@/lib/stats")).resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -40), bis: today }, today));
    expect(s.payouts.cents).toBe(1000);
    expect(s.months.reduce((a, m) => a + m.payoutCents, 0)).toBe(1000);
    // Audit ohne Begründung
    const a = await w.q<{ meta: unknown }>("select meta from audit_log where organization_id = $1 and action = 'billing_batch.payout_reversal'", [w.org]);
    expect(a.length).toBe(1);
    expect(JSON.stringify(a)).not.toMatch(/Betrag falsch/);
  });

  it("E12: Rückmeldungsdatei als Beleg archiviert; nach Storno dieselbe Datei erneut einlesbar; verknüpfte Absetzungen mit Hinweis, unverändert", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    const paid = addDaysIso(today, -2);
    const file = csvFile([ids[0], "", "", "", "50,00", "5,00", "R1", "Formfehler Rückseite", paid, "SR-1"]);
    const prev = await ho.previewPayoutImport(w.auth, batchId, file, "rueck.csv");
    if ("error" in prev) throw new Error(prev.error);
    const done = await ho.confirmPayoutImport(w.auth, batchId, file, "rueck.csv", prev.sha256);
    if ("error" in done) throw new Error(done.error);
    const [row] = await readPayouts(w, batchId);
    expect(row.storage_key?.startsWith(`${w.org}/`)).toBe(true);
    expect(row.source_sha256).toBe(sha(file));
    const { readDecrypted } = await import("@/lib/storage");
    expect(Buffer.compare(await readDecrypted(row.storage_key!), file)).toBe(0);
    // Storno → erneut einlesbar, Absetzung nicht doppelt, Hinweis an verknüpften Absetzungen
    const st = await ho.reversePayout(w.auth, { payoutId: done.payoutId, reason: "falscher Lauf gemeldet" });
    if ("error" in st) throw new Error(st.error);
    const info = await ho.batchHandoverInfo(w.auth, batchId);
    expect(info!.reversedDeductionHints).toBe(1);
    expect((await w.q<{ status: string }>("select status from gkv_deductions where organization_id = $1", [w.org])).map((d) => d.status)).toEqual(["open"]);
    const again = await ho.previewPayoutImport(w.auth, batchId, file, "rueck.csv");
    if ("error" in again) throw new Error(again.error);
    expect(again.bereitsEingelesen).toBe(false);
    const d2 = await ho.confirmPayoutImport(w.auth, batchId, file, "rueck.csv", again.sha256);
    if ("error" in d2) throw new Error(d2.error);
    expect(d2.skippedDeductions).toBe(1);
    // ohne Storno: dieselbe Datei nicht ein drittes Mal
    expect(await ho.confirmPayoutImport(w.auth, batchId, file, "rueck.csv", again.sha256)).toEqual({ error: expect.stringMatching(/bereits eingelesen/) });
    // Praxis-Export: Rückmeldungsdatei als Beleg
    const exp = await import("./practice-export");
    const result = await exp.buildPracticeExport({ organizationId: w.org, exportedBy: { name: "I", email: "i@example.org" } });
    const chunks: Uint8Array[] = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
    }
    expect(await result.done).toMatchObject({ payoutFiles: 2, payoutErrors: 0 });
    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    const pr = JSON.parse(await zip.file("tables/billing_batch_payouts.json")!.async("string"));
    const withFile = pr.filter((r: { exportFile?: string }) => r.exportFile);
    expect(withFile).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(await zip.file(withFile[0].exportFile)!.async("uint8array")), file)).toBe(0);
  });

  it("E13: Doppelerfassung – gleiche Auszahlung (Datum, Referenz, Betrag) als JSON bzw. von Hand → Warnung, nur mit Bestätigung", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    const paid = addDaysIso(today, -2);
    const csv = csvFile([ids[0], "", "", "", "70,00", "", "", "", paid, "SR-9"]);
    const p1 = await ho.previewPayoutImport(w.auth, batchId, csv, "a.csv");
    if ("error" in p1) throw new Error(p1.error);
    expect(p1.duplikat).toBeNull();
    const c1 = await ho.confirmPayoutImport(w.auth, batchId, csv, "a.csv", p1.sha256);
    if ("error" in c1) throw new Error(c1.error);
    const json = Buffer.from(JSON.stringify({ schema: "podohero-rueckmeldung/1", sammelrechnungsnummer: "sr-9", auszahlungsdatum: paid, positionen: [{ verordnung_id: ids[0], ausgezahlt_cent: 7000 }] }));
    const p2 = await ho.previewPayoutImport(w.auth, batchId, json, "a.json");
    if ("error" in p2) throw new Error(p2.error);
    expect(p2.bereitsEingelesen).toBe(false);
    expect(p2.duplikat).toMatch(/bereits erfasst/);
    expect(await ho.confirmPayoutImport(w.auth, batchId, json, "a.json", p2.sha256)).toEqual({ error: expect.stringMatching(/Doppel/) });
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 7000, paidAt: paid, reference: "SR 9" })).toEqual({ error: expect.stringMatching(/Doppel/) });
    expect(await ho.recordManualPayout(w.auth, { batchId, amountCents: 7000, paidAt: paid, reference: "SR 9", confirmDuplicate: true })).toEqual({ id: expect.any(String) });
    const c2 = await ho.confirmPayoutImport(w.auth, batchId, json, "a.json", p2.sha256, { confirmDuplicate: true });
    expect("error" in c2).toBe(false);
  });

  it("E14: Noch offen = Soll − Auszahlungen − Gebühren − Absetzungen des Laufs (aus gkv_deductions, nach Status, ohne Doppelte); Gebühr aus der Rückmeldung", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    await ho.handoverPackage(w.auth, batchId);
    const info0 = await ho.batchHandoverInfo(w.auth, batchId);
    const soll = info0!.sollInsurerCents!;
    const paid = addDaysIso(today, -2);
    // Rückmeldung mit Gebühr: ausgezahlt + Gebühr + Absetzung = Soll → kein Abweichungshinweis
    const file = csvGeb([[ids[0], "", "", "", ((soll - 1500) / 100).toFixed(2).replace(".", ","), "10,00", "R1", "Unterschrift fehlt", paid, "SR-2", "5,00"]]);
    const p = await ho.previewPayoutImport(w.auth, batchId, file, "g.csv");
    if ("error" in p) throw new Error(p.error);
    expect(p.fehler).toEqual([]);
    expect(p.summeGebuehrCent).toBe(500);
    expect(p.zeilen[0].hinweise.join()).not.toMatch(/weicht/);
    const c = await ho.confirmPayoutImport(w.auth, batchId, file, "g.csv", p.sha256);
    if ("error" in c) throw new Error(c.error);
    // zusätzlich eine von Hand erfasste Absetzung (gleiche Verordnung) – zählt einmal, nach Status
    const d = await gb.createDeduction(w.auth, { prescriptionId: ids[0], patientId: w.patient, amountCents: 200, reason: "Zweite Absetzung", deductedOn: today });
    if ("error" in d) throw new Error(d.error);
    const info = await ho.batchHandoverInfo(w.auth, batchId);
    expect(info!.feeCents).toBe(500);
    expect(info!.deductions).toEqual({ reductionCents: 0, pendingCents: 1200, reversedCents: 0 });
    expect(info!.openCents).toBe(soll - (soll - 1500) - 500);
    expect((await w.q<{ fee_cents: number }>("select fee_cents from billing_batch_payouts where billing_batch_id = $1", [batchId]))[0].fee_cents).toBe(500);
  });

  it("E15: Archiv nur zu übergebenem Lauf (Trigger); Absetzung nur zu einer Verordnung des Laufs (Trigger); Obergrenze je Lauf", async () => {
    const w = await world();
    const { batchId, ids } = await w.batch(1);
    const { batchId: other } = await w.batch(1);
    await expect(
      w.q(
        "insert into billing_batch_exports (organization_id, billing_batch_id, kind, storage_key, sha256, size_bytes, filename, schema_version, prescription_count, created_by) values ($1,$2,'handover_zip',$3,repeat('a',64),1,'x.zip','podohero-abrechnung/1',1,$4)",
        [w.org, batchId, `${w.org}/2026/11/x.bin`, w.user],
      ),
    ).rejects.toThrow(/übergeben/);
    await expect(
      w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, billing_batch_id, amount_cents, reason, deducted_on, created_by) values ($1,$2,$3,$4,100,'Test',$5,$6)", [w.org, ids[0], w.patient, other, today, w.user]),
    ).rejects.toThrow(/gehört nicht zu diesem Abrechnungslauf/);
    const { paketGrenze, HANDOVER_MAX_VERORDNUNGEN } = await import("@/lib/gkv-handover/paket");
    expect(paketGrenze(HANDOVER_MAX_VERORDNUNGEN)).toBeNull();
    expect(paketGrenze(HANDOVER_MAX_VERORDNUNGEN + 1)).toMatch(/höchstens/);
  });

  it("E16: Nachdruck als Stream byte-gleich; fehlende Dokumente gezählt", async () => {
    const w = await world();
    const { batchId } = await w.batch(1);
    const first = await ho.handoverPackageStream(w.auth, batchId);
    if (!first || "error" in first) throw new Error("kein Paket");
    expect(first.missingDocuments).toBe(0);
    const again = await ho.handoverPackageStream(w.auth, batchId);
    if (!again || "error" in again) throw new Error("kein Paket");
    expect(again.reprint).toBe(true);
    const chunks: Buffer[] = [];
    for await (const c of again.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    expect(Buffer.compare(Buffer.concat(chunks), first.body as Buffer)).toBe(0);
  });
});
