/**
 * GKV Paket B (Teil 1) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten, IKs mit 99…/Prüfziffer-Beispiel):
 * Unterschrift je Behandlung (Ablage verschlüsselt, unveränderlich, Sperre „abrechnungsreif“, Papier-Vermerk,
 * Leistungsnachweis-PDF) und Zuzahlungsquittung (Beleg ZZ, Kasse/TSE bzw. Praxiskasse, Tagesabschluss, Erstattung,
 * Altvermerk, Export).
 */
import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const session = vi.hoisted(() => ({ auth: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ requireAuth: async () => session.auth }));
import { berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

/** gültiges PNG (Graustufen) als data:-URL */
function png(width = 300, height = 100): string {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit-Tiefe
  ihdr[9] = 0; // Graustufen
  const raw = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  for (let x = 10; x < width - 10; x++) raw[50 * (width + 1) + 1 + x] = 0; // Strich
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

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
               icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, doctor_name)
             values ($1,$2,$3,'DF',$4,'open',($3::date + 28),$5,'1x alle 4-6 Wochen',$6,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c','Dr. Beispiel') returning id`,
            [org, patient, addDaysIso(today, -3), units, JSON.stringify(positions), RULES_VERSION],
          )
        ).rows[0].id as string,
      );
    const treat = (prescriptionId: string) =>
      dbm.withOrg(org, (tx) => records.insertTreatmentRecord(tx, { org, userId: user, role: "owner" }, { patientId: patient, prescriptionId, findings: "o. B.", servicesText: "Behandlung" }));
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    return { org, user, patient, auth, vo, treat, q };
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
    await expect(w.q("update treatment_signatures set signer_name = 'X' where id = $1", [row.id])).rejects.toThrow(/unveränderbar/);
    await expect(w.q("delete from treatment_signatures where id = $1", [row.id])).rejects.toThrow(/unveränderbar/);
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
    await sigs.addSignature(w.auth, { recordId: r1.id, patientId: w.patient, signatureData: png(), signerName: "Paul Pflege", signerRole: "caregiver" });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ error: expect.stringMatching(/Eine Behandlung hat keine Unterschrift/) });
    await sigs.addSignature(w.auth, { recordId: r2.id, patientId: w.patient, paperSigned: true });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
    // Übernahme (Altbestand): nur Hinweis, keine Sperre
    const legacy = await w.q<{ id: string }>(
      "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version) values ($1,$2,$3,'DF',1,'active',($3::date + 28),'[{\"position\":\"78020\",\"label\":\"groß\",\"units\":1}]','import-tinana') returning id",
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
    expect(await quickRecordAction(undefined, form({ signatureData: "data:image/png;base64,AAAA", signerName: "Paul Pflege", signerRole: "caregiver" }))).toEqual({ error: expect.stringMatching(/kein gültiges Bild/) });
    expect((await w.q("select id from treatment_records where prescription_id = $1", [id])).length).toBe(0);
    expect(await quickRecordAction(undefined, form({ signatureData: png(), signerName: "Paul Pflege", signerRole: "caregiver" }))).toEqual({ ok: "Gespeichert" });
    const rows = await w.q<{ kind: string; signer_role: string; signer_name: string }>("select s.kind, s.signer_role, s.signer_name from treatment_signatures s join treatment_records t on t.id = s.record_id where t.prescription_id = $1", [id]);
    expect(rows).toEqual([{ kind: "device", signer_role: "caregiver", signer_name: "Paul Pflege" }]);
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
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 6000, method: "card" })).toEqual({ error: expect.stringMatching(/höher als die Heilmittelkosten/) });
    const part = await copay.createCopaymentReceipt(w.auth, { prescriptionId: id2, patientId: w.patient, amountCents: 500, method: "card" });
    expect(part).toMatchObject({ warning: expect.stringMatching(/Restbetrag/) });
    const [partLine] = await w.q<{ description: string }>("select description from invoice_lines where invoice_id = $1", [(part as { id: string }).id]);
    expect(partLine.description).toMatch(/Zuzahlung zur Heilmittelverordnung vom/);
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

  it("B2: Altvermerk nur Anzeige – sperrt neue Quittung bis zum Zurücksetzen; Erstattung als negative Zahlung; Export-Datum", async () => {
    const w = await world();
    const id = await w.vo(1);
    await w.q("update prescriptions set copayment_paid_at = now(), copayment_paid_cents = 1347, copayment_paid_method = 'cash' where id = $1", [id]);
    expect(await copay.createCopaymentReceipt(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: null, method: "cash" })).toEqual({ error: expect.stringMatching(/Altvermerk/) });
    // Altvermerk ist keine Kassenbuchung
    expect((await w.q("select id from payments")).length).toBe(0);
    expect(await presc.setCopaymentPaid(w.auth, { id, patientId: w.patient, paid: false })).toEqual({});
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
});
