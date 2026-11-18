/**
 * GKV Paket B (Teil 1) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten, IKs mit 99…/Prüfziffer-Beispiel):
 * Unterschrift je Behandlung (Ablage verschlüsselt, unveränderlich, Sperre „abrechnungsreif“, Papier-Vermerk,
 * Leistungsnachweis-PDF) und Zuzahlungsquittung (Beleg ZZ, Kasse/TSE bzw. Praxiskasse, Tagesabschluss, Erstattung,
 * Altvermerk, Export).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const session = vi.hoisted(() => ({ auth: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ requireAuth: async () => session.auth }));
/** Audit gezielt scheitern lassen (Review R3-1: Datei darf nach Commit nicht weggeräumt werden) */
const auditCtl = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/audit", async (orig) => {
  const m = await orig<typeof import("@/lib/audit")>();
  return { ...m, audit: (...a: Parameters<typeof m.audit>) => (auditCtl.fail ? Promise.reject(new Error("Audit nicht erreichbar (Test)")) : m.audit(...a)) };
});
import { berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";
import { testPngDataUrl } from "@/lib/__tests__/png-fixture";

/** gültige Unterschrift (900×300 RGBA) als data:-URL */
const png = () => testPngDataUrl();

(TEST_DB ? describe : describe.skip)("GKV Paket B – Unterschrift und Zuzahlungsquittung (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let presc: typeof import("./prescriptions");
  let records: typeof import("./records");
  let sigs: typeof import("./signatures");
  let docs: typeof import("./gkv-documents");
  let copay: typeof import("./copayments");
  let kasse: typeof import("./kasse");
  let dbm: typeof import("@/db");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.TSE_PROVIDER;
    presc = await import("./prescriptions");
    records = await import("./records");
    sigs = await import("./signatures");
    docs = await import("./gkv-documents");
    copay = await import("./copayments");
    kasse = await import("./kasse");
    dbm = await import("@/db");
    today = (await import("@/lib/format")).berlinDateIso();
  });
  afterAll(async () => {
    await fx.end();
    await (dbm.db.$client as { end: () => Promise<void> }).end();
  });

  const world = async (settings?: unknown) => {
    const org = await fx.org(settings ? { settings } : {});
    const user = await fx.user(org);
    const patient = await fx.patient(org, { lastName: "Musterfrau", firstName: "Erika" });
    await fx.asOrg(org, (c) => c.query("update patients set birth_date = '1950-03-01', insurance_type = 'gkv' where id = $1", [patient]));
    await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    const auth = { organization: { id: org, name: "Testpraxis", slug: "t", smallBusiness: false, state: "BB", billingMode: "with_gkv" }, user: { id: user, name: "Anna Test" }, role: "owner", can: () => true } as never;
    session.auth = auth;
    const vo = (units = 2, positions = [{ position: "78020", label: "Podologische Behandlung (groß)", units }]) =>
      fx.asOrg(org, async (c) =>
        (
          await c.query(
            `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, frequency_per_week, rules_version,
               icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, doctor_name, prescription_kind, prescription_kind_confirmed_at)
             values ($1,$2,$3,'DF',$4,'open',($3::date + 28),$5,'1x alle 4-6 Wochen',$6,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c','Dr. Beispiel','03',now()) returning id`,
            [org, patient, addDaysIso(today, -3), units, JSON.stringify(positions), RULES_VERSION],
          )
        ).rows[0].id as string,
      );
    const treat = (prescriptionId: string) =>
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId, findings: "o. B.", servicesText: "Behandlung" }));
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    return { org, user, patient, auth, vo, treat, q };
  };

  /** als Eigentümer (Trigger statt Rechteentzug prüfen), im Praxis-Kontext, immer zurückgerollt */
  const asOwner = async (org: string, text: string, params: unknown[]) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@"), max: 1 });
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [org]);
      return await c.query(text, params);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
      await pool.end();
    }
  };

  // ───────────── B1 Unterschrift ─────────────

  it("B1: Unterschrift auf dem Gerät – verschlüsselt abgelegt, je Behandlung einmal, unveränderbar; Papier-Vermerk", async () => {
    const w = await world();
    const id = await w.vo(2);
    const rec = await w.treat(id);
    expect(await sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" })).toEqual({ ok: true });
    const [row] = await w.q<{ id: string; kind: string; storage_key: string; size_bytes: number; sha256: string; prescription_id: string }>("select * from treatment_signatures where record_id = $1", [rec.id]);
    expect(row).toMatchObject({ kind: "device", prescription_id: id });
    expect(row.storage_key.startsWith(`${w.org}/`)).toBe(true);
    // Datei liegt verschlüsselt (kein PNG-Klartext in der Ablage), lesbar nur entschlüsselt
    const { readFileSync } = await import("node:fs");
    const stored = readFileSync(`${process.env.STORAGE_DIR}/${row.storage_key}`);
    expect(stored.subarray(0, 5).toString()).toBe("PODO2");
    const img = await sigs.signatureImage(w.auth, row.id);
    expect(img!.subarray(1, 4).toString()).toBe("PNG");
    // zweites Mal → abgelehnt
    expect(await sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, paperSigned: true })).toEqual({ error: expect.stringMatching(/bereits eine Unterschrift/) });
    // unveränderbar (Trigger)
    // App-Rolle: kein UPDATE/DELETE-Recht (migrate.ts); Eigentümer: Trigger
    await expect(w.q("update treatment_signatures set signer_name = 'X' where id = $1", [row.id])).rejects.toThrow(/permission denied/);
    await expect(w.q("delete from treatment_signatures where id = $1", [row.id])).rejects.toThrow(/permission denied/);
    await expect(asOwner(w.org, "update treatment_signatures set signer_name = 'X' where id = $1", [row.id])).rejects.toThrow(/unveränderbar/);
    await expect(asOwner(w.org, "delete from treatment_signatures where id = $1", [row.id])).rejects.toThrow(/unveränderbar/);
    // ungültiges Bild, fehlender Name
    const rec2 = await w.treat(id);
    expect(await sigs.addSignature(w.auth, { recordId: rec2.id, patientId: w.patient, signatureData: "data:image/png;base64,AAAA", signerName: "Erika Musterfrau", signerRole: "insured" })).toEqual({ error: expect.stringMatching(/kein gültiges Bild/) });
    expect(await sigs.addSignature(w.auth, { recordId: rec2.id, patientId: w.patient, signatureData: png(), signerRole: "insured" })).toEqual({ error: expect.stringMatching(/Namen/) });
    expect(await sigs.addSignature(w.auth, { recordId: rec2.id, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured", paperSigned: true })).toHaveProperty("error");
    // bewusst gesetzter Papier-Vermerk
    expect(await sigs.addSignature(w.auth, { recordId: rec2.id, patientId: w.patient, paperSigned: true })).toEqual({ ok: true });
    const [paper] = await w.q<{ kind: string; storage_key: string | null }>("select kind, storage_key from treatment_signatures where record_id = $1", [rec2.id]);
    expect(paper).toEqual({ kind: "paper", storage_key: null });
  });

  it("B1: DB-Prüfungen – Eintrag/Verordnung müssen passen, Ablage nur der eigenen Praxis, fremde Praxis abgelehnt", async () => {
    const a = await world();
    const b = await world();
    const voA = await a.vo(2);
    const recA = await a.treat(voA);
    const voA2 = await a.vo(2);
    // falsche Verordnung zum Eintrag
    await expect(a.q("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by) values ($1,$2,$3,$4,'paper',$5)", [a.org, recA.id, a.patient, voA2, a.user])).rejects.toThrow(/passt nicht zum Behandlungseintrag/);
    // Datei außerhalb des eigenen Ablagebereichs
    await expect(
      a.q("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, signer_name, signer_role, storage_key, mime, size_bytes, sha256, created_by) values ($1,$2,$3,$4,'device','Erika','insured',$5,'image/png',10,repeat('a',64),$6)", [a.org, recA.id, a.patient, voA, `${b.org}/2026/01/x.bin`, a.user]),
    ).rejects.toThrow(/treatment_signatures_values_check/);
    // Eintrag einer fremden Praxis
    const voB = await b.vo(2);
    const recB = await b.treat(voB);
    await expect(a.q("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by) values ($1,$2,$3,$4,'paper',$5)", [a.org, recB.id, a.patient, voA, a.user])).rejects.toThrow(/gehört nicht zu dieser Praxis/);
    // Behandlung ohne Verordnung: keine Unterschrift für den Leistungsnachweis
    const plain = await dbm.withOrg(a.org, (tx) => records.insertTreatmentRecord(tx, { org: a.org, userId: a.user, role: "owner" }, { patientId: a.patient, findings: "o. B.", servicesText: "x" }));
    expect(await sigs.addSignature(a.auth, { recordId: plain.id, patientId: a.patient, paperSigned: true })).toEqual({ error: expect.stringMatching(/nur bei Behandlungen auf Verordnung/) });
  });

  it("B1: „abrechnungsreif“ erst, wenn jede Behandlung unterschrieben bzw. auf Papier vermerkt ist; Hinweis an der Verordnung", async () => {
    const w = await world();
    const id = await w.vo(2);
    const r1 = await w.treat(id);
    const r2 = await w.treat(id);
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === id)!.signatures).toEqual({ total: 2, missing: 2 });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ error: expect.stringMatching(/2 Behandlungen haben keine Unterschrift/) });
    await sigs.addSignature(w.auth, { recordId: r1.id, patientId: w.patient, signatureData: png(), signerName: "Paul Pflege", signerRole: "guardian" });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ error: expect.stringMatching(/Eine Behandlung hat keine Unterschrift/) });
    await sigs.addSignature(w.auth, { recordId: r2.id, patientId: w.patient, paperSigned: true });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
    // Übernahme (Altbestand): nur Hinweis, keine Sperre
    const legacy = await w.q<{ id: string }>(
      "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version, prescription_kind, prescription_kind_confirmed_at) values ($1,$2,$3,'DF',1,'active',($3::date + 28),'[{\"position\":\"78020\",\"label\":\"groß\",\"units\":1}]','import-tinana','03',now()) returning id",
      [w.org, w.patient, addDaysIso(today, -3)],
    );
    await w.q("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prescription_id, hash, prev_hash) values ($1,$2,$3,$4,$5,'h-legacy','p-legacy')", [w.org, w.patient, w.user, berlinToUtc(addDaysIso(today, -1), "10:00"), legacy[0].id]);
    expect(await presc.changePrescriptionStatus(w.auth, { id: legacy[0].id, patientId: w.patient, to: "completed" })).toEqual({ ok: true });
    expect(await presc.changePrescriptionStatus(w.auth, { id: legacy[0].id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
  });

  it("B1: Besuchstag (Pflegeheim) und Doku speichern die Unterschrift mit dem Eintrag; Fehler → nichts gespeichert", async () => {
    const w = await world();
    const home = (await w.q<{ id: string }>("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Haus Linde') returning id", [w.org]))[0].id;
    await w.q("update patients set care_home_id = $2 where id = $1", [w.patient, home]);
    const id = await w.vo(2);
    const { quickRecordAction } = await import("@/app/(app)/pflegeheime/actions");
    const form = (extra: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({ careHomeId: home, patientId: w.patient, prescriptionId: id, servicesText: "Behandlung", confirm: "on", ...extra })) f.set(k, v);
      return f;
    };
    // ungültige Unterschrift → kein Eintrag
    expect(await quickRecordAction(undefined, form({ signatureData: "data:image/png;base64,AAAA", signerName: "Paul Pflege", signerRole: "guardian" }))).toEqual({ error: expect.stringMatching(/kein gültiges Bild/) });
    expect((await w.q("select id from treatment_records where prescription_id = $1", [id])).length).toBe(0);
    expect(await quickRecordAction(undefined, form({ signatureData: png(), signerName: "Paul Pflege", signerRole: "guardian" }))).toEqual({ ok: "Gespeichert" });
    const rows = await w.q<{ kind: string; signer_role: string; signer_name: string }>("select s.kind, s.signer_role, s.signer_name from treatment_signatures s join treatment_records t on t.id = s.record_id where t.prescription_id = $1", [id]);
    expect(rows).toEqual([{ kind: "device", signer_role: "guardian", signer_name: "Paul Pflege" }]);
  });

  it("B1: Leistungsnachweis-PDF mit Unterschriftsbild, Papier-Vermerk und „Unterschrift fehlt“", async () => {
    const w = await world();
    const id = await w.vo(3, [{ position: "78020", label: "groß", units: 3 }]);
    const r1 = await w.treat(id);
    const r2 = await w.treat(id);
    await w.treat(id);
    await sigs.addSignature(w.auth, { recordId: r1.id, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" });
    await sigs.addSignature(w.auth, { recordId: r2.id, patientId: w.patient, paperSigned: true });
    const pdf = await docs.proofPdf(w.auth, id);
    expect(Buffer.from(pdf!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf!.filename).toMatch(/^Leistungsnachweis-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.pdf$/);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf!.bytes);
    expect(doc.getTitle()).toMatch(/Leistungsnachweis/);
    // fremde Praxis: nicht gefunden
    const other = await world();
    expect(await docs.proofPdf(other.auth, id)).toBeNull();
  });

  // ───────────── B2 Zuzahlungsquittung ─────────────

  it("B2: Zuzahlung bar → Quittung ZZ mit Positionen + Pauschale, TSE-Signatur, im Tagesabschluss; Rest/Grenzen", async () => {
    const w = await world();
    const id = await w.vo(2);
    const res = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" });
    expect(res).toMatchObject({ number: expect.stringMatching(/^ZZ\d{4}-0001$/), warning: null });
    const inv = (res as { id: string; amountCents: number });
    const [i] = await w.q<{ kind: string; status: string; prescription_id: string; total_cents: number; vat_cents: number }>("select kind, status, prescription_id, total_cents, vat_cents from invoices where id = $1", [inv.id]);
    expect(i).toMatchObject({ kind: "copayment", status: "paid", prescription_id: id, vat_cents: 0 });
    const { priceFor } = await import("@/lib/rules/podologie-verguetung");
    const pr = priceFor("78020", today)!;
    expect(i.total_cents).toBe(2 * pr.copayCents! + 1000);
    const lines = await w.q<{ description: string; total_cents: number; vat_rate: number }>("select description, total_cents, vat_rate from invoice_lines where invoice_id = $1 order by position", [inv.id]);
    expect(lines.map((l) => l.total_cents)).toEqual([2 * pr.copayCents!, 1000]);
    expect(lines[0].description).toMatch(/Pos\. 78020/);
    expect(lines.every((l) => l.vat_rate === 0)).toBe(true);
    const [pay] = await w.q<{ id: string; method: string; register: string }>("select id, method, register from payments where invoice_id = $1", [inv.id]);
    expect(pay).toMatchObject({ method: "cash", register: "podohero" });
    expect((await w.q("select id from fiscal_transactions where payment_id = $1", [pay.id])).length).toBe(1);
    // vollständig quittiert → keine zweite Quittung
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/vollständig quittiert/) });
    // Tagesabschluss enthält die Zuzahlung
    await kasse.closeDay(w.auth, { businessDate: today, denominations: { "1": i.total_cents }, openingCents: 0 });
    const [closed] = await w.q<{ cash_closing_id: string | null }>("select cash_closing_id from payments where id = $1", [pay.id]);
    expect(closed.cash_closing_id).not.toBeNull();
    // Akte: quittierte Summe
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === id)!.copaymentCollectedCents).toBe(i.total_cents);
    // Teilbetrag + Obergrenze Heilmittelkosten
    const id2 = await w.vo(1);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 6000, method: "card", confirmOverpay: true })).toEqual({ error: expect.stringMatching(/höher als die Heilmittelkosten/) });
    const part = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 500, method: "card" });
    expect(part).toMatchObject({ warning: expect.stringMatching(/Restbetrag/) });
    const [partLine] = await w.q<{ description: string }>("select description from invoice_lines where invoice_id = $1", [(part as { id: string }).id]);
    expect(partLine.description).toMatch(/Zuzahlung zur Verordnung vom/);
  });

  it("B2: eigene Praxiskasse → Vermerk mit Bon-Nr., keine PodoHero-TSE; Quittungs-PDF mit § 61-Hinweis ohne USt", async () => {
    const w = await world({ externalCashRegister: true });
    const id = await w.vo(1);
    const res = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "card", registerReceiptNo: "BON-4711" });
    expect(res).toHaveProperty("number");
    const [pay] = await w.q<{ id: string; register: string; external_ref: string }>("select id, register, external_ref from payments where invoice_id = $1", [(res as { id: string }).id]);
    expect(pay).toMatchObject({ register: "external", external_ref: "praxiskasse:BON-4711" });
    expect((await w.q("select id from fiscal_transactions where payment_id = $1", [pay.id])).length).toBe(0);
    // archiviertes PDF der Quittung
    const [arch] = await w.q<{ storage_key: string }>("select storage_key from document_archive where invoice_id = $1 and kind = 'invoice'", [(res as { id: string }).id]);
    expect(arch).toBeTruthy();
    const { readDecrypted } = await import("@/lib/storage");
    const bytes = await readDecrypted(arch.storage_key);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("B2: Altvermerk nur Anzeige – sperrt neue Quittung (bis „Vermerk war falsch“); Erstattung als negative Zahlung; Export-Datum", async () => {
    const w = await world();
    const id = await w.vo(1);
    // Altvermerk über die volle Zuzahlung (Teilbetrag: Rest quittierbar, siehe R3-3)
    const legacyCents = (await import("@/lib/rules/podologie-verguetung")).priceFor("78020", today)!.copayCents! + 1000;
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = $2, copayment_paid_method = 'cash' where id = $1", [id, legacyCents]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
    // Altvermerk ist keine Kassenbuchung
    expect((await w.q("select id from payments")).length).toBe(0);
    expect(await presc.setCopaymentPaid(w.auth, { id, patientId: w.patient, paid: false, reason: "Vermerk war falsch, nichts erhalten" })).toEqual({});
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })) as { id: string; amountCents: number };
    expect(res.amountCents).toBeGreaterThan(0);
    // Erstattung: Storno + negative Zahlung (Kassenvorgang)
    const ref = await copay.refundCopaymentReceipt(w.auth, { invoiceId: res.id, patientId: w.patient, method: "cash", reason: "Überzahlung, Tippfehler" });
    expect(ref).toMatchObject({ refundedCents: res.amountCents, refundError: null });
    const neg = await w.q<{ amount_cents: number; method: string }>("select p.amount_cents, p.method from payments p join invoices i on i.id = p.invoice_id where i.cancels_invoice_id = $1", [res.id]);
    expect(neg).toEqual([{ amount_cents: -res.amountCents, method: "cash" }]);
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    const row = list!.prescriptions.find((x) => x.id === id)!;
    expect(row.copaymentCollectedCents).toBe(0);
    expect(row.copaymentReceipts[0]).toMatchObject({ status: "cancelled", refund: { refunded: true } });
    // neu quittieren möglich; Export nennt das Datum der gültigen Quittung
    const again = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "transfer" });
    expect(again).toHaveProperty("number");
    const receipts = await dbm.withOrg(w.org, (tx) => copay.copaymentReceiptsFor(tx, w.org, [id]));
    expect(presc.copaymentPaidOn(receipts.get(id), null)).toBe(today);
    // falsche Person / keine Zuzahlungsquittung
    const other = await fx.patient(w.org, { lastName: "Anders" });
    expect(await copay.refundCopaymentReceipt(w.auth, { invoiceId: res.id, patientId: other, method: "cash", reason: "Test Test" })).toEqual({ error: "Zuzahlungsquittung nicht gefunden." });
  });

  it("B2: befreit → keine Zuzahlung fällig; CHECK prescription_id nur bei Zuzahlungsquittung", async () => {
    const w = await world();
    await w.q("update patients set copayment_exemptions = $2 where id = $1", [w.patient, JSON.stringify([{ id: "00000000-0000-4000-8000-000000000001", validFrom: addDaysIso(today, -30), validTo: addDaysIso(today, 300), insurerIk: "109911114" }])]);
    const id = await w.vo(1);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/keine Zuzahlung fällig/) });
    await expect(w.q("insert into invoices (organization_id, patient_id, prescription_id, status) values ($1,$2,$3,'draft')", [w.org, w.patient, id])).rejects.toThrow(/invoices_prescription_kind_check/);
  });

  // ───────────── Review-Runde 2 ─────────────

  it("R2-1: Zuzahlungsquittung am selben Tag blendet private Leistungen nicht aus der Sammelrechnung aus", async () => {
    const w = await world();
    const ab = await import("./appointment-billing");
    await dbm.withOrg(w.org, (tx) => records.insertTreatmentRecord(tx, { org: w.org, userId: w.user, role: "owner" }, { patientId: w.patient, findings: "privat", servicesText: "Fußpflege" }));
    const year = Number(today.slice(0, 4));
    const before = await ab.patientYearSuggestion(w.auth, w.patient, year);
    expect(before!.items).toBe(1);
    const id = await w.vo(1);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toHaveProperty("number");
    expect((await ab.patientYearSuggestion(w.auth, w.patient, year))!.items).toBe(1);
    expect((await ab.collectiveOverview(w.auth, year)).find((r) => r.patientId === w.patient)?.items).toBe(1);
  });

  it("R2-3: prescription_id einer Quittung nach dem Ausstellen unveränderlich; Verordnung muss zur Person passen", async () => {
    const w = await world();
    const id = await w.vo(1);
    const other = await w.vo(1);
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })) as { id: string };
    await expect(w.q("update invoices set prescription_id = $2 where id = $1", [res.id, other])).rejects.toThrow(/unveränderbar/);
    const stranger = await fx.patient(w.org, { lastName: "Fremd" });
    await expect(w.q("insert into invoices (organization_id, patient_id, kind, prescription_id, status) values ($1,$2,'copayment',$3,'draft')", [w.org, stranger, id])).rejects.toThrow(/passt nicht zur Person/);
  });

  it("R2-4: ohne bekannten Preis → frei eingegebener Betrag (eine Zeile, Hinweis „Betrag manuell“), ohne Betrag Fehler", async () => {
    const w = await world();
    const id = await w.vo(1, [{ label: "Behandlung ohne Positionsnummer", units: 1 } as never]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Betrag angeben/) });
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 1_000_001, method: "cash" })).toHaveProperty("error");
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 1250, method: "cash" })) as { id: string };
    const lines = await w.q<{ description: string; total_cents: number }>("select description, total_cents from invoice_lines where invoice_id = $1", [res.id]);
    expect(lines).toEqual([{ description: "Zuzahlung laut Verordnung", total_cents: 1250 }]);
    const [inv] = await w.q<{ notes: string }>("select notes from invoices where id = $1", [res.id]);
    expect(inv.notes).toMatch(/Betrag manuell, Berechnung nicht möglich/);
  });

  it("R2-5/11: Altvermerk zählt als erhalten und blockiert; Zurücksetzen nur „Vermerk war falsch“ mit Begründung", async () => {
    const w = await world();
    const id = await w.vo(1);
    // Altvermerk über die volle Zuzahlung (Teilbetrag: Rest quittierbar, siehe R3-3)
    const legacyCents = (await import("@/lib/rules/podologie-verguetung")).priceFor("78020", today)!.copayCents! + 1000;
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = $2, copayment_paid_method = 'cash' where id = $1", [id, legacyCents]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    // Paket-B-Nachzug: quittiert (ZZ-Belege) und Altvermerk getrennt
    expect(list!.prescriptions.find((x) => x.id === id)!).toMatchObject({ copaymentCollectedCents: 0, copaymentLegacyCents: legacyCents });
    expect(await presc.setCopaymentPaid(w.auth, { id, patientId: w.patient, paid: false, reason: "" })).toEqual({ error: expect.stringMatching(/Begründung/) });
    expect(await presc.setCopaymentPaid(w.auth, { id, patientId: w.patient, paid: false, reason: "Vermerk versehentlich gesetzt, nichts erhalten" })).toEqual({});
  });

  it("R2-10: Name ohne Steuerzeichen; Rollen Versicherte:r/rechtliche Betreuung/Angehörige:r/Pflegekraft", async () => {
    const w = await world();
    const id = await w.vo(1);
    const rec = await w.treat(id);
    expect(await sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, signatureData: png(), signerName: "Erika\u202eMuster", signerRole: "insured" })).toHaveProperty("error");
    expect(await sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, signatureData: png(), signerName: "Schwester Anna", signerRole: "care_staff" })).toEqual({ ok: true });
  });

  it("R2-13/17: Sammel-Vermerk „Unterschriften liegen auf Papier vor“ bis Datum; Nachtrag nicht am Behandlungstag wird markiert", async () => {
    const w = await world();
    const id = await w.vo(3);
    // Sammel-Vermerk nur für Altbestand/Übernahmen (Review R3-6)
    await w.q("update prescriptions set rules_version = 'import-tinana' where id = $1", [id]);
    const day = (d: string) => w.q<{ id: string }>("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prescription_id, hash, prev_hash) values ($1,$2,$3,$4,$5,$6,$7) returning id", [w.org, w.patient, w.user, berlinToUtc(d, "10:00"), id, `h-${Math.random()}`, `p-${Math.random()}`]);
    const r1 = (await day(addDaysIso(today, -20)))[0].id;
    await day(addDaysIso(today, -10));
    await day(addDaysIso(today, -1));
    await sigs.addSignature(w.auth, { recordId: r1, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" });
    expect(await sigs.markPaperSignatures(w.auth, { prescriptionId: id, patientId: w.patient, until: addDaysIso(today, -5) })).toEqual({ count: 1 });
    const rows = (await dbm.withOrg(w.org, (tx) => sigs.proofRows(tx, w.org, [id]))).get(id)!;
    expect(rows.map((r) => r.signature?.kind ?? null)).toEqual(["device", "paper", null]);
    expect(rows[0].signature!.late).toBe(true);
  });

  it("R2-14: Überzahlung nur mit Bestätigung; neue Quittung erst nach gebuchter Erstattung", async () => {
    const w = await world();
    const id = await w.vo(1);
    const { priceFor } = await import("@/lib/rules/podologie-verguetung");
    const due = priceFor("78020", today)!.copayCents! + 1000;
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: due + 100, method: "cash" })).toEqual({ error: expect.stringMatching(/über der offenen Zuzahlung/) });
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: due + 100, method: "cash", confirmOverpay: true })) as { id: string };
    // Storno ohne gebuchte Erstattung (Erstattung scheitert) → keine neue Quittung
    const inv = await import("./invoices");
    await inv.cancelInvoice(w.auth, res.id, "Test ohne Erstattung").catch(() => undefined);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Erstattung/) });
  });

  // ───────────── Review-Runde 3 ─────────────

  const eur = (c: number) => `${(c / 100).toFixed(2).replace(".", ",")} €`;
  const due78020 = async () => (await import("@/lib/rules/podologie-verguetung")).priceFor("78020", today)!.copayCents! + 1000;

  it("R3-1: Audit scheitert nach dem Commit → Unterschrift-Datei bleibt (DB-Zeile ist append-only)", async () => {
    const { existsSync } = await import("node:fs");
    const w = await world();
    const id = await w.vo(2);
    const rec = await w.treat(id);
    auditCtl.fail = true;
    try {
      await expect(sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" })).rejects.toThrow(/Audit/);
    } finally {
      auditCtl.fail = false;
    }
    const [a] = await w.q<{ storage_key: string }>("select storage_key from treatment_signatures where record_id = $1", [rec.id]);
    expect(existsSync(`${process.env.STORAGE_DIR}/${a.storage_key}`)).toBe(true);
    // Behandlungseintrag mit Unterschrift (Besuchstag/createTreatmentRecord)
    const prepared = sigs.prepareSignature({ signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" });
    auditCtl.fail = true;
    try {
      await expect(records.createTreatmentRecord(w.auth, { patientId: w.patient, prescriptionId: id, findings: "o. B.", servicesText: "Behandlung" }, {}, prepared as never)).rejects.toThrow(/Audit/);
    } finally {
      auditCtl.fail = false;
    }
    const rows = await w.q<{ storage_key: string }>("select s.storage_key from treatment_signatures s where s.prescription_id = $1 and s.record_id <> $2", [id, rec.id]);
    expect(rows).toHaveLength(1);
    expect(existsSync(`${process.env.STORAGE_DIR}/${rows[0].storage_key}`)).toBe(true);
  });

  it("R3-2: Akte liefert die offene Zuzahlung (Server-Berechnung); ohne Preis → manuelle Eingabe", async () => {
    const w = await world();
    const priced = await w.vo(1);
    const manual = await w.vo(1, [{ label: "Behandlung ohne Positionsnummer", units: 1 } as never]);
    const due = await due78020();
    let list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === priced)!.copaymentDue).toMatchObject({ manual: false, expectedCents: due, openCents: due });
    expect(list!.prescriptions.find((x) => x.id === manual)!.copaymentDue).toMatchObject({ manual: true, expectedCents: null, openCents: null });
    await copay.createCopaymentReceipt(w.auth, { prescriptionId: priced, patientId: w.patient, amountCents: 500, method: "cash" });
    list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === priced)!.copaymentDue).toMatchObject({ openCents: due - 500 });
  });

  it("R3-3: Altvermerk mit Teilbetrag wird angerechnet – Restquittung möglich; voller Altvermerk sperrt", async () => {
    const w = await world();
    const due = await due78020();
    const id = await w.vo(1);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = 500, copayment_paid_method = 'cash' where id = $1", [id]);
    const rest = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })) as { amountCents: number };
    expect(rest.amountCents).toBe(due - 500);
    // Paket-B-Nachzug: Rest schon per ZZ quittiert → nicht „bereits als Altvermerk erfasst“, sondern beide Beträge nennen
    const again = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" });
    expect(again).toEqual({ error: expect.stringContaining(`nichts mehr offen (quittiert ${eur(due - 500)}, Altvermerk 5,00 €)`) });
    expect((again as { error: string }).error).not.toMatch(/als Altvermerk .*erfasst/);
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === id)!.copaymentDue).toMatchObject({ openCents: 0 });
    expect(list!.prescriptions.find((x) => x.id === id)!).toMatchObject({ copaymentCollectedCents: due - 500, copaymentLegacyCents: 500 });
    // Altvermerk über den vollen Betrag → gesperrt
    const full = await w.vo(1);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = $2, copayment_paid_method = 'cash' where id = $1", [full, due]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: full, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
  });

  it("R3-4: manueller Betrag – Befreiung/unter 18 wie berechnet; über 200 € nur mit Bestätigung", async () => {
    const w = await world();
    const noPrice = [{ label: "Behandlung ohne Positionsnummer", units: 1 } as never];
    const id = await w.vo(1, noPrice);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 20001, method: "cash" })).toEqual({ error: expect.stringMatching(/200,00 €/) });
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 15000, method: "cash" })).toHaveProperty("number");
    // Summe mit bisherigen Quittungen zählt
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 6000, method: "cash" })).toEqual({ error: expect.stringMatching(/200,00 €/) });
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 6000, method: "cash", confirmOverpay: true })).toHaveProperty("number");
    // befreit (Bescheinigung gilt heute)
    await w.q("update patients set copayment_exemptions = $2 where id = $1", [w.patient, JSON.stringify([{ id: "00000000-0000-4000-8000-000000000002", validFrom: addDaysIso(today, -30), validTo: addDaysIso(today, 300), insurerIk: "109911114" }])]);
    const id2 = await w.vo(1, noPrice);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 1000, method: "cash" })).toEqual({ error: expect.stringMatching(/befreit/) });
    // unter 18
    await w.q("update patients set copayment_exemptions = '[]', birth_date = $2 where id = $1", [w.patient, addDaysIso(today, -365 * 10)]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 1000, method: "cash" })).toEqual({ error: expect.stringMatching(/unter 18/) });
  });

  it("R3-6: Sammel-Vermerk Papier nur für Verordnungen ohne Pflicht zur Gerätunterschrift", async () => {
    const w = await world();
    const id = await w.vo(2);
    await w.treat(id);
    expect(await sigs.markPaperSignatures(w.auth, { prescriptionId: id, patientId: w.patient, until: today })).toEqual({ error: expect.stringMatching(/nur für Verordnungen/) });
    expect((await w.q("select id from treatment_signatures where prescription_id = $1", [id])).length).toBe(0);
  });

  it("R3-6: Wettlauf Sammel-Vermerk ↔ Unterschrift derselben Behandlung → kein 500 (23505 abgefangen)", async () => {
    const { Pool } = await import("pg");
    const w = await world();
    const id = await w.vo(2);
    await w.q("update prescriptions set rules_version = 'import-tinana' where id = $1", [id]);
    const rec = await w.treat(id);
    const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? (TEST_DB ?? "").replace(/\/\/[^:@/]+(:[^@/]*)?@/, "//podo_owner:podo_owner@"), max: 1 });
    try {
      if (!(await owner.query("select rolsuper from pg_roles where rolname = current_user")).rows[0]?.rolsuper) return;
      const c = await owner.connect();
      try {
        // fremde Transaktion: Unterschrift zur selben Behandlung, noch nicht festgeschrieben (ohne Fremdschlüssel-Sperre)
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        await c.query("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by) values ($1,$2,$3,$4,'paper',$5)", [w.org, rec.id, w.patient, id, w.user]);
        const bulk = sigs.markPaperSignatures(w.auth, { prescriptionId: id, patientId: w.patient, until: today });
        await new Promise((r) => setTimeout(r, 400));
        await c.query("commit");
        expect(await bulk).toEqual({ count: 0 });
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    } finally {
      await owner.end();
    }
  });

  it("R3-6: Unterschrift wartet auf die Sperre der Verordnung (Sammel-Vermerk) – kein Deadlock, verständliche Meldung", async () => {
    const w = await world();
    const id = await w.vo(2);
    const rec = await w.treat(id);
    const c = await fx.pool.connect();
    try {
      // wie markPaperSignatures: Verordnung gesperrt, danach Vermerk zur selben Behandlung
      await c.query("begin");
      await c.query("select set_config('app.org_id', $1, true)", [w.org]);
      await c.query("select id from prescriptions where id = $1 for update", [id]);
      const add = sigs.addSignature(w.auth, { recordId: rec.id, patientId: w.patient, signatureData: png(), signerName: "Erika Musterfrau", signerRole: "insured" });
      await new Promise((r) => setTimeout(r, 400));
      await c.query("insert into treatment_signatures (organization_id, record_id, patient_id, prescription_id, kind, created_by) values ($1,$2,$3,$4,'paper',$5)", [w.org, rec.id, w.patient, id, w.user]);
      await c.query("commit");
      expect(await add).toEqual({ error: expect.stringMatching(/bereits eine Unterschrift/) });
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("R3-7: „Vermerk war falsch“ ohne Altvermerk → Meldung, kein Audit", async () => {
    const w = await world();
    const id = await w.vo(1);
    expect(await presc.setCopaymentPaid(w.auth, { id, patientId: w.patient, paid: false, reason: "Vermerk war falsch, nichts erhalten" })).toEqual({ error: expect.stringMatching(/kein Vermerk vorhanden/) });
    expect((await w.q("select id from audit_log where organization_id = $1 and action = 'prescription.copayment' and entity_id = $2", [w.org, id])).length).toBe(0);
  });

  // ───────────── Paket-B-Nachzug (Runde 3: Code, Sicherheit, Buchhaltung) ─────────────

  it("Nachzug: Altvermerk ohne Betrag – Belegtext mit berechneter Zuzahlung, „Altvermerk“ statt „bereits quittiert“", async () => {
    const w = await world();
    const due = await due78020();
    const id = await w.vo(1);
    // Altvermerk ohne copayment_paid_cents; zuletzt gespeicherter Rechenwert 5,00 €
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = null, copayment_cents = 500 where id = $1", [id]);
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })) as { id: string; amountCents: number };
    expect(res.amountCents).toBe(due - 500);
    const [inv] = await w.q<{ notes: string }>("select notes from invoices where id = $1", [res.id]);
    expect(inv.notes).toContain("ohne Betrag vermerkt – angerechnet mit der in der Verordnung gespeicherten Zuzahlung 5,00 €");
    expect(inv.notes).toContain("ohne Beleg in PodoHero");
    expect(inv.notes).not.toMatch(/Kassenbuchung|bereits quittiert/);
    expect(inv.notes).toContain("Altvermerk 5,00 €");
    // mit Betrag: „vermerkt: X € – angerechnet“
    const id2 = await w.vo(1);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = 700 where id = $1", [id2]);
    const res2 = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: null, method: "cash" })) as { id: string };
    const [inv2] = await w.q<{ notes: string }>("select notes from invoices where id = $1", [res2.id]);
    expect(inv2.notes).toContain("vermerkt: 7,00 € – angerechnet");
  });

  it("Nachzug: voller Altvermerk ohne Preis → nichts offen, kein Formular; Altvermerk ohne Betrag mit copayment_cents 0 gilt als voll", async () => {
    const w = await world();
    const manual = await w.vo(1, [{ label: "Behandlung ohne Positionsnummer", units: 1 } as never]);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = null, copayment_cents = null where id = $1", [manual]);
    const zero = await w.vo(1);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = null, copayment_cents = 0 where id = $1", [zero]);
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === manual)!.copaymentDue).toMatchObject({ manual: true, openCents: 0 });
    expect(list!.prescriptions.find((x) => x.id === zero)!.copaymentDue).toMatchObject({ manual: false, openCents: 0 });
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: manual, patientId: w.patient, amountCents: 1000, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: zero, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
  });

  it("Nachzug: Storno einer Zuzahlungsquittung – Begleit-E-Mail nennt „Storno Zuzahlungsquittung“", async () => {
    const w = await world();
    const id = await w.vo(1);
    const res = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })) as { id: string };
    const ref = (await copay.refundCopaymentReceipt(w.auth, { invoiceId: res.id, patientId: w.patient, method: "cash", reason: "Überzahlung, Tippfehler" })) as { creditNoteId: string };
    const invoices = await import("./invoices");
    const delivery = await import("./invoice-delivery");
    const b = await dbm.withOrg(w.org, (tx) => invoices.loadInvoiceBundle(tx, w.org, ref.creditNoteId));
    const mail = delivery.invoiceEmailText(b!);
    expect(mail.subject).toMatch(/^Storno Zuzahlungsquittung /);
    expect(mail.body).toContain("Ihre Storno Zuzahlungsquittung");
    expect(mail.body).not.toContain("Stornorechnung");
  });
});
