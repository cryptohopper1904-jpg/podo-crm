/**
 * GKV Paket C gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten): Kennzeichen Verordnungsart (bestätigen, nie
 * raten, Sperre für Abrechnungsreife/-lauf), Verordnungsbesonderheit/Genehmigung, Absetzungen (Status, Unveränderlichkeit,
 * Rechte, Mandanten) und Korrektur abgerechneter Verordnungen (Korrekturvermerk, erneute Abrechnung im nächsten Lauf,
 * ohne Neuabrechnung, Trigger), Löschen der Person.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, insertLegacy, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("GKV Paket C – Verordnungsart, Absetzungen, Korrektur (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let presc: typeof import("./prescriptions");
  let gb: typeof import("./gkv-billing");
  let del: typeof import("./patient-deletion");
  let dbm: typeof import("@/db");
  let g302: typeof import("./gkv302-export");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    presc = await import("./prescriptions");
    gb = await import("./gkv-billing");
    del = await import("./patient-deletion");
    dbm = await import("@/db");
    g302 = await import("./gkv302-export");
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
    await fx.asOrg(org, (c) => c.query("update patients set birth_date = '1950-03-01', insurance_type = 'gkv' where id = $1", [patient]));
    await fx.pool.query("update organizations set ik = '109911114' where id = $1", [org]);
    const authWith = (perms: string[] | "all") =>
      ({
        organization: { id: org, name: "Testpraxis", slug: "t", smallBusiness: false, state: "BB", billingMode: "with_gkv" },
        user: { id: user, name: "Anna Test" },
        role: "owner",
        readOnly: false,
        support: null,
        can: (p: string) => perms === "all" || perms.includes(p),
      }) as never;
    const auth = authWith("all");
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    /** DF-Verordnung mit vollständigen Anlage-3-Angaben; Kennzeichen Verordnungsart nur, wenn angegeben (Bestand: NULL) */
    const vo = async (o: { status?: string; kind?: string | null; approval?: boolean } = {}) =>
      (
        await q<{ id: string }>(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, doctor_name, frequency_per_week,
             prescription_kind, prescription_kind_confirmed_at, approval_ref, approval_date)
           values ($1,$2,$3,'DF',2,$4,($3::date + 28),$5,$6,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c','Dr. Beispiel','1x alle 4-6 Wochen',
             $7, case when $7::text is null then null else now() end, $8, $9) returning id`,
          [
            org,
            patient,
            addDaysIso(today, -30),
            o.status ?? "completed",
            JSON.stringify([{ position: "78020", label: "groß", units: 2 }]),
            RULES_VERSION,
            o.kind === undefined ? null : o.kind,
            o.approval ? "G-2026/17" : null,
            o.approval ? addDaysIso(today, -40) : null,
          ],
        )
      )[0].id;
    let n = 0;
    /** Behandlung in der Vergangenheit mit Papier-Vermerk (Unterschrift) */
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
    /** abgeschlossene, abrechnungsreife Verordnung mit zwei Behandlungen */
    const ready = async (kind: string | null = "03") => {
      const id = await vo({ kind });
      await past(id, addDaysIso(today, -20));
      await past(id, addDaysIso(today, -10));
      return id;
    };
    /** abgerechnete Verordnung (über den Abrechnungslauf) */
    const billed = async () => {
      const id = await ready();
      expect(await presc.changePrescriptionStatus(auth, { id, patientId: patient, to: "billing_ready" })).toEqual({ ok: true });
      const batch = await presc.createBillingBatch(auth, [id], { partner: "manual" });
      if ("error" in batch) throw new Error(batch.error);
      return { id, batchId: batch.id };
    };
    /** Formular-Eingabe der Verordnung aus vo() (für savePrescription im Korrekturstatus) */
    const formInput = (id: string, icd10 = "E11.74") =>
      presc.prescriptionInput.parse({
        id, patientId: patient, issuedAt: addDaysIso(today, -30), diagnosisGroup: "DF", units: "2", icd10, doctorLanr: "123456601", doctorBsnr: "123456789",
        insurerIk: "109911114", insuranceNumber: "A000500015", insuredStatus: "1", leitsymptomatik: "c", doctorSigned: "on", frequencyPerWeek: "1x alle 4-6 Wochen", doctorName: "Dr. Beispiel",
        positions: JSON.stringify([{ position: "78020", label: "groß", units: 2 }]),
      });
    return { org, user, patient, auth, authWith, q, vo, past, ready, billed, formInput };
  };

  it("C1: Kennzeichen Verordnungsart – Bestand NULL sperrt „abrechnungsreif“ und den Lauf; Bestätigung mit Person/Zeit; nie 05", async () => {
    const w = await world();
    const id = await w.ready(null);
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ error: expect.stringMatching(/Kennzeichen Verordnungsart \(03\/04\) ist nicht bestätigt/) });
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    // kein Vorschlag ohne belegte Grundlage (Diagnoselisten BVB/LHB sind nicht hinterlegt) – nie raten
    expect(list!.prescriptions.find((x) => x.id === id)).toMatchObject({ prescriptionKind: null, kindSuggestion: null });
    // 05 und Unsinn werden abgelehnt (Formular und DB)
    expect(gb.billingDetailsInput.safeParse({ id, patientId: w.patient, prescriptionKind: "05" }).success).toBe(false);
    expect(gb.billingDetailsInput.safeParse({ id, patientId: w.patient, prescriptionKind: "03", approvalRef: "G1" }).success).toBe(false); // Datum fehlt
    await expect(w.q("update prescriptions set prescription_kind = '05', prescription_kind_confirmed_at = now() where id = $1", [id])).rejects.toThrow(/prescriptions_prescription_kind_check/);
    await expect(w.q("update prescriptions set prescription_kind = '03' where id = $1", [id])).rejects.toThrow(/prescriptions_prescription_kind_check/);
    await expect(w.q("update prescriptions set prescription_special = '3' where id = $1", [id])).rejects.toThrow(/prescriptions_special_approval_check/);
    // fremde Person als Bestätigende abgelehnt
    const otherOrg = await fx.org();
    const stranger = await fx.user(otherOrg);
    await expect(w.q("update prescriptions set prescription_kind = '03', prescription_kind_confirmed_at = now(), prescription_kind_confirmed_by = $2 where id = $1", [id, stranger])).rejects.toThrow(/gehört nicht zu dieser Praxis/);

    const input = gb.billingDetailsInput.parse({ id, patientId: w.patient, prescriptionKind: "04", prescriptionSpecial: "4", approvalRef: "G-2026/17", approvalDate: addDaysIso(today, -40) });
    expect(await gb.saveBillingDetails(w.auth, input)).toEqual({ ok: true });
    const [row] = await w.q<{ prescription_kind: string; prescription_kind_confirmed_by: string; prescription_kind_confirmed_at: Date; prescription_special: string; approval_ref: string; approval_date: string }>(
      "select prescription_kind, prescription_kind_confirmed_by, prescription_kind_confirmed_at, prescription_special, approval_ref, approval_date::text from prescriptions where id = $1",
      [id],
    );
    expect(row).toMatchObject({ prescription_kind: "04", prescription_kind_confirmed_by: w.user, prescription_special: "4", approval_ref: "G-2026/17", approval_date: addDaysIso(today, -40) });
    expect(row.prescription_kind_confirmed_at).toBeInstanceOf(Date);
    // Audit ohne Werte (kein „04“, keine Genehmigungsnummer)
    const audits = await w.q<{ meta: unknown }>("select meta from audit_log where organization_id = $1 and action = 'prescription.billing_details'", [w.org]);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].meta)).not.toMatch(/04|G-2026/);
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });

    // Vorschlag nur aus einer erfassten Genehmigung (B2) → 04, nicht gesetzt
    const withApproval = await w.vo({ status: "open", approval: true });
    const list2 = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list2!.prescriptions.find((x) => x.id === withApproval)).toMatchObject({ prescriptionKind: null, kindSuggestion: { kind: "04" } });

    // Abrechnungslauf: Bestand „abrechnungsreif“ ohne Kennzeichen wird abgewiesen
    const legacy = await w.vo({ status: "billing_ready" });
    const snap = (await w.q<{ price_snapshot: unknown }>("select price_snapshot from prescriptions where id = $1", [id]))[0].price_snapshot;
    await w.q("update prescriptions set price_snapshot = $2 where id = $1", [legacy, JSON.stringify(snap)]);
    expect(await presc.createBillingBatch(w.auth, [legacy], { partner: "manual" })).toEqual({ error: expect.stringMatching(/kein bestätigtes Kennzeichen Verordnungsart/) });
    const batch = await presc.createBillingBatch(w.auth, [id], { partner: "manual" });
    expect(batch).toMatchObject({ count: 1 });
    // CSV: Verordnungsart, Besonderheit und Genehmigung am Ende
    const exp = await presc.billingBatchExport(w.auth, (batch as { id: string }).id);
    const header = exp!.lines[0] as string[];
    const line = exp!.lines[1] as string[];
    expect(line[header.indexOf("Verordnungsart")]).toBe("04");
    expect(line[header.indexOf("Verordnungsbesonderheit")]).toMatch(/^4 .*Entlassmanagement/);
    expect(line[header.indexOf("Genehmigung Kennzeichen")]).toBe("G-2026/17");
    // abgerechnet: keine Änderung der Angaben mehr (App und Trigger)
    expect(await gb.saveBillingDetails(w.auth, { ...input, prescriptionKind: "03" })).toEqual({ error: expect.stringMatching(/abgerechnet/) });
    await expect(w.q("update prescriptions set prescription_special = null where id = $1", [id])).rejects.toThrow(/unveränderbar/);
  });

  it("C3: Absetzung – nur zu abgerechneten Verordnungen, Status-Workflow, Betrag nur offen änderbar, nie löschbar, Rechte und Mandanten", async () => {
    const w = await world();
    const notBilled = await w.ready();
    const base = { patientId: w.patient, amountCents: 1234, reason: "Unterschrift fehlt", deductedOn: addDaysIso(today, -1) };
    expect(await gb.createDeduction(w.auth, { ...base, prescriptionId: notBilled })).toEqual({ error: expect.stringMatching(/nur zu abgerechneten/) });
    await expect(w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, amount_cents, reason, deducted_on, created_by) values ($1,$2,$3,100,'abc',current_date,$4)", [w.org, notBilled, w.patient, w.user])).rejects.toThrow(/nur zu abgerechneten/);
    const { id, batchId } = await w.billed();
    expect(await gb.createDeduction(w.auth, { ...base, prescriptionId: id, deductedOn: addDaysIso(today, 1) })).toEqual({ error: expect.stringMatching(/Zukunft/) });
    expect(gb.deductionInput.safeParse({ ...base, prescriptionId: id, amountCents: 0 }).success).toBe(false);
    const created = await gb.createDeduction(w.auth, { ...base, prescriptionId: id, reasonCode: "R12" });
    if ("error" in created) throw new Error(created.error);
    const [d] = await w.q<{ billing_batch_id: string; status: string; amount_cents: number }>("select billing_batch_id, status, amount_cents from gkv_deductions where id = $1", [created.id]);
    expect(d).toEqual({ billing_batch_id: batchId, status: "open", amount_cents: 1234 });
    // Rechte: ohne Abrechnungsrecht nichts; Zugriff einer fremden Praxis sieht nichts
    await expect(gb.createDeduction(w.authWith(["medical.read", "medical.write"]), { ...base, prescriptionId: id })).rejects.toThrow(/invoices.write/);
    await expect(gb.listDeductions(w.authWith(["invoices.write"]))).rejects.toThrow(/medical.read/);
    const other = await world();
    expect(await gb.listDeductions(other.auth)).toEqual([]);
    expect(await gb.createDeduction(other.auth, { ...base, prescriptionId: id, patientId: w.patient })).toEqual({ error: "Verordnung nicht gefunden." });
    expect(await gb.updateDeduction(other.auth, { id: created.id, status: "done" })).toEqual({ error: "Absetzung nicht gefunden." });

    // Betrag korrigieren, solange offen; dann Widerspruch → akzeptiert → erledigt (abschließend)
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "open", amountCents: 1500 })).toEqual({ ok: true });
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "objected", note: "Widerspruch am Tag X" })).toEqual({ ok: true });
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "objected", amountCents: 1700 })).toEqual({ error: expect.stringMatching(/nur bei offenen/) });
    await expect(w.q("update gkv_deductions set amount_cents = 1 where id = $1", [created.id])).rejects.toThrow(/nur bei offenen/);
    await expect(w.q("update gkv_deductions set prescription_id = $2 where id = $1", [created.id, notBilled])).rejects.toThrow(/unveränderlich/);
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "accepted" })).toEqual({ ok: true });
    const open = await gb.listDeductions(w.auth, { statuses: ["open", "objected"] });
    expect(open).toHaveLength(0);
    expect(await gb.listDeductions(w.auth)).toEqual([expect.objectContaining({ id: created.id, amountCents: 1500, status: "accepted", reasonCode: "R12", patient: "Erika Musterfrau" })]);
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "done", outcome: "upheld" })).toEqual({ ok: true });
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "open" })).toEqual({ error: expect.stringMatching(/erledigt/) });
    await expect(w.q("update gkv_deductions set note = 'x' where id = $1", [created.id])).rejects.toThrow(/erledigt/);
    // nie löschen: App-Rolle ohne DELETE bzw. Trigger
    await expect(w.q("delete from gkv_deductions where id = $1", [created.id])).rejects.toThrow(/permission denied|nicht gelöscht/);
    await expect(w.q("truncate gkv_deductions")).rejects.toThrow(/permission denied|geleert/);
    // Audit ohne Grund/Notiz
    const audits = await w.q<{ meta: unknown }>("select meta from audit_log where organization_id = $1 and action like 'gkv_deduction.%'", [w.org]);
    expect(JSON.stringify(audits)).not.toMatch(/Unterschrift fehlt|Widerspruch am/);
  });

  it("C3: Korrektur nötig → korrigieren → erneut abrechnungsreif → nächster Lauf; Stand der Erstabrechnung bleibt; keine stille Änderung", async () => {
    const w = await world();
    const { id, batchId } = await w.billed();
    const ded = await gb.createDeduction(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 3555, reason: "ICD passt nicht", deductedOn: today });
    if ("error" in ded) throw new Error(ded.error);
    // ohne Vermerk: abgerechnete Verordnung bleibt gesperrt – auch der Statuswechsel
    await expect(w.q("update prescriptions set status = 'correction_needed' where id = $1", [id])).rejects.toThrow(/nur mit offenem Korrekturvermerk/);
    await expect(w.q("update prescriptions set icd10 = 'E11.40' where id = $1", [id])).rejects.toThrow(/unveränderbar/);
    expect(gb.correctionInput.safeParse({ prescriptionId: id, patientId: w.patient, reason: "x" }).success).toBe(false);
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "correction_needed" })).toEqual({ error: expect.stringMatching(/nicht erlaubt/) });
    // Vermerk allein öffnet nicht für Änderungen am Inhalt (nur der Statuswechsel ist erlaubt)
    const [snapBefore] = await w.q<{ price_snapshot: unknown; remedy_cost_cents: number; billed_at: Date }>("select price_snapshot, remedy_cost_cents, billed_at from prescriptions where id = $1", [id]);
    const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "ICD laut Kasse falsch – korrigieren", deductionId: ded.id });
    if ("error" in res) throw new Error(res.error);
    expect(await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "noch einmal bitte" })).toEqual({ error: expect.stringMatching(/nur für abgerechnete/) });
    const [c] = await w.q<{ original_batch_id: string; original_remedy_cost_cents: number; original_price_snapshot: unknown; deduction_id: string; resolved_at: Date | null }>(
      "select original_batch_id, original_remedy_cost_cents, original_price_snapshot, deduction_id, resolved_at from prescription_corrections where id = $1",
      [res.id],
    );
    expect(c).toEqual({ original_batch_id: batchId, original_remedy_cost_cents: snapBefore.remedy_cost_cents, original_price_snapshot: snapBefore.price_snapshot, deduction_id: ded.id, resolved_at: null });
    // Vermerk unveränderlich (nur Abschließen), nie löschbar
    await expect(w.q("update prescription_corrections set reason = 'anders' where id = $1", [res.id])).rejects.toThrow(/nur abgeschlossen/);
    await expect(w.q("delete from prescription_corrections where id = $1", [res.id])).rejects.toThrow(/permission denied|nicht gelöscht/);
    // zweiter offener Vermerk derselben Verordnung: eindeutiger Index
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    const v = list!.prescriptions.find((x) => x.id === id)!;
    expect(v).toMatchObject({ status: "correction_needed", corrections: [expect.objectContaining({ id: res.id })], deductions: [expect.objectContaining({ id: ded.id })] });
    expect(v.evaluation.light).toBe("red");

    // korrigieren (Formular „Bearbeiten“ ist in „Korrektur nötig“ erlaubt) – Regelwerk bleibt, Einheiten nicht unter den erbrachten
    const input = presc.prescriptionInput.parse({
      id, patientId: w.patient, issuedAt: addDaysIso(today, -30), diagnosisGroup: "DF", units: "2", icd10: "E11.40", doctorLanr: "123456601", doctorBsnr: "123456789",
      insurerIk: "109911114", insuranceNumber: "A000500015", insuredStatus: "1", leitsymptomatik: "c", doctorSigned: "on", frequencyPerWeek: "1x alle 4-6 Wochen",
      positions: JSON.stringify([{ position: "78020", label: "groß", units: 2 }]),
    });
    expect(await presc.savePrescription(w.auth, { ...input, units: 1, positions: [{ position: "78020", label: "groß", units: 1 }] })).toEqual({ error: expect.stringMatching(/schon 2 Einheiten/) });
    expect(await presc.savePrescription(w.auth, input)).toMatchObject({ id });
    const [after] = await w.q<{ icd10: string; rules_version: string; billed_at: Date; billing_batch_id: string }>("select icd10, rules_version, billed_at, billing_batch_id from prescriptions where id = $1", [id]);
    expect(after).toMatchObject({ icd10: "E11.40", rules_version: RULES_VERSION, billing_batch_id: batchId });
    const upd = await w.q<{ meta: { correction?: boolean } }>("select meta from audit_log where organization_id = $1 and action = 'prescription.update' and entity_id = $2", [w.org, id]);
    expect(upd.at(-1)?.meta.correction).toBe(true);

    // erneut abrechnungsreif (neuer Snapshot) und im nächsten Lauf abrechnen → Vermerk „erneut abgerechnet“
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
    const batch2 = await presc.createBillingBatch(w.auth, [id], { partner: "manual" });
    if ("error" in batch2) throw new Error(batch2.error);
    const [c2] = await w.q<{ resolution: string; resolved_batch_id: string }>("select resolution, resolved_batch_id from prescription_corrections where id = $1", [res.id]);
    expect(c2).toEqual({ resolution: "rebilled", resolved_batch_id: batch2.id });
    await expect(w.q("update prescription_corrections set resolution_note = 'x' where id = $1", [res.id])).rejects.toThrow(/abgeschlossen/);
    // Export: alter Lauf führt die Verordnung weiter (mit Hinweis), neuer Lauf mit Bezug zur Korrektur
    const old = await presc.billingBatchExport(w.auth, batchId);
    const neu = await presc.billingBatchExport(w.auth, batch2.id);
    const col = (old!.lines[0] as string[]).indexOf("Korrektur");
    expect(old!.lines).toHaveLength(2);
    expect((old!.lines[1] as string[])[col]).toBe("in späterem Lauf neu abgerechnet");
    expect((neu!.lines[1] as string[])[col]).toMatch(/^Neuabrechnung nach Korrektur vom/);
    // Audit: Statuswechsel nachvollziehbar
    const st = await w.q<{ meta: { from: string; to: string } }>("select meta from audit_log where organization_id = $1 and action = 'prescription.status' and entity_id = $2 order by id", [w.org, id]);
    expect(st.map((r) => `${r.meta.from}→${r.meta.to}`)).toContain("billed→correction_needed");
  });

  it("C3: Korrektur ohne Neuabrechnung abschließen; nur mit Abrechnungsrecht; Person mit Absetzung nicht vollständig löschbar", async () => {
    const w = await world();
    const { id, batchId } = await w.billed();
    await expect(gb.markCorrectionNeeded(w.authWith(["medical.read", "medical.write"]), { prescriptionId: id, patientId: w.patient, reason: "Begründung lang genug" })).rejects.toThrow(/invoices.write/);
    expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "nichts offen hier" })).toEqual({ error: expect.stringMatching(/nicht im Status/) });
    const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Absetzung prüfen" });
    if ("error" in res) throw new Error(res.error);
    expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ ok: true });
    const [row] = await w.q<{ status: string; billing_batch_id: string }>("select status, billing_batch_id from prescriptions where id = $1", [id]);
    expect(row).toEqual({ status: "billed", billing_batch_id: batchId });
    const [c] = await w.q<{ resolution: string; resolution_note: string }>("select resolution, resolution_note from prescription_corrections where id = $1", [res.id]);
    expect(c).toEqual({ resolution: "no_rebill", resolution_note: "Absetzung akzeptiert" });
    // danach wieder gesperrt
    await expect(w.q("update prescriptions set icd10 = 'E11.40' where id = $1", [id])).rejects.toThrow(/unveränderbar/);

    // Löschen der Person: Absetzung/Korrektur sind Aufbewahrungsgründe (zusätzlich zur Abrechnung)
    await gb.createDeduction(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 100, reason: "Frist", deductedOn: today });
    const facts = await del.retentionFacts(w.org, w.patient);
    expect(facts!.lastPrescriptionBillingAt).toBeInstanceOf(Date);
    await expect(w.q("select podo_delete_patient($1)", [w.patient])).rejects.toThrow(/Aufbewahrungspflichtige Daten/);
  });
  describe("Review-Runde 1", () => {
    it("R1-1: Stand der Erstabrechnung (original_row) vom Trigger; geänderte Verordnung nicht ohne Neuabrechnung; Audit mit Feldnamen", async () => {
      const w = await world();
      const { id, batchId } = await w.billed();
      const [before] = await w.q<{ j: Record<string, unknown> }>("select to_jsonb(p) as j from prescriptions p where id = $1", [id]);
      // original_row setzt der Trigger – ein Wert der Anwendung wird überschrieben
      await w.q("insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, created_by, original_row) values ($1,$2,$3,'Testvermerk',$4,'{\"icd10\":\"X\"}')", [w.org, id, w.patient, w.user]);
      const [c] = await w.q<{ id: string; original_row: Record<string, unknown> }>("select id, original_row from prescription_corrections where prescription_id = $1", [id]);
      expect(c.original_row).toEqual(before.j);
      await expect(w.q("update prescription_corrections set original_row = '{}' where id = $1", [c.id])).rejects.toThrow(/nur abgeschlossen/);
      await w.q("update prescriptions set status = 'correction_needed' where id = $1", [id]);

      // ICD im Korrekturstatus ändern → Audit mit Feldnamen, ohne Werte
      expect(await presc.savePrescription(w.auth, w.formInput(id, "E11.40"))).toMatchObject({ id });
      const [upd] = await w.q<{ meta: { correction?: boolean; changedFields?: string[] } }>("select meta from audit_log where organization_id = $1 and action = 'prescription.update' and entity_id = $2 order by id desc limit 1", [w.org, id]);
      expect(upd.meta).toMatchObject({ correction: true, changedFields: ["icd10"] });
      expect(JSON.stringify(upd.meta)).not.toMatch(/E11/);
      // ohne Neuabrechnung abschließen → Fehler, Vermerk bleibt offen, Status bleibt
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ error: "Geänderte Verordnung muss neu abgerechnet werden." });
      const [st] = await w.q<{ status: string; open: number }>("select p.status, (select count(*)::int from prescription_corrections c where c.prescription_id = p.id and c.resolved_at is null) as open from prescriptions p where p.id = $1", [id]);
      expect(st).toEqual({ status: "correction_needed", open: 1 });
      // DB: auch direkt nicht zurück auf „abgerechnet“ – weder ohne Abschluss noch mit Abschluss, solange geändert
      await expect(w.q("update prescriptions set status = 'billed' where id = $1", [id])).rejects.toThrow(/ohne Neuabrechnung abschließen/);
      await expect(
        fx.asOrg(w.org, async (cl) => {
          await cl.query("update prescription_corrections set resolution = 'no_rebill', resolved_at = now(), resolved_by = $2 where id = $1", [c.id, w.user]);
          await cl.query("update prescriptions set status = 'billed' where id = $1", [id]);
        }),
      ).rejects.toThrow(/Geänderte Verordnung muss neu abgerechnet werden/);
      // Abschluss in einem früheren Vorgang zählt nicht (resolved_at = now() im selben Vorgang)
      await expect(
        fx.asOrg(w.org, async (cl) => {
          await cl.query("update prescription_corrections set resolution = 'no_rebill', resolved_at = now() - interval '1 minute', resolved_by = $2 where id = $1", [c.id, w.user]);
          await cl.query("update prescriptions set status = 'billed' where id = $1", [id]);
        }),
      ).rejects.toThrow(/ohne Neuabrechnung abschließen/);

      // zurückkorrigieren auf den Stand der Erstabrechnung → ohne Neuabrechnung möglich
      expect(await presc.savePrescription(w.auth, w.formInput(id, "E11.74"))).toMatchObject({ id });
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "doch richtig" })).toEqual({ ok: true });
      const [after] = await w.q<{ status: string; billing_batch_id: string; icd10: string }>("select status, billing_batch_id, icd10 from prescriptions where id = $1", [id]);
      expect(after).toEqual({ status: "billed", billing_batch_id: batchId, icd10: "E11.74" });
    });

    it("R1-1/R1-4: unverändert über „abrechnungsreif“ und zurück → ohne Neuabrechnung; Snapshot der Erstabrechnung wiederhergestellt", async () => {
      const w = await world();
      const { id } = await w.billed();
      const [orig] = await w.q<{ price_snapshot: { computedOn: string }; remedy_cost_cents: number; copayment_cents: number }>("select price_snapshot, remedy_cost_cents, copayment_cents from prescriptions where id = $1", [id]);
      // Snapshot der Erstabrechnung künstlich „älter“ machen, damit die Neuberechnung sichtbar abweicht
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Absetzung prüfen" });
      if ("error" in res) throw new Error(res.error);
      // ohne offenen Vermerk kein Rückweg aus „abrechnungsreif“ (normale Verordnung)
      const other = await w.ready();
      expect(await presc.changePrescriptionStatus(w.auth, { id: other, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      expect(await presc.changePrescriptionStatus(w.auth, { id: other, patientId: w.patient, to: "correction_needed" })).toEqual({ error: expect.stringMatching(/offenem Korrekturvermerk/) });
      await expect(w.q("update prescriptions set status = 'correction_needed' where id = $1", [other])).rejects.toThrow(/nur mit offenem Korrekturvermerk/);
      // mit offenem Vermerk: abrechnungsreif → zurück nach „Korrektur nötig“
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      await w.q("update prescriptions set price_snapshot = jsonb_set(price_snapshot, '{computedOn}', '\"2099-01-01\"'), remedy_cost_cents = remedy_cost_cents + 1 where id = $1", [id]);
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "correction_needed" })).toEqual({ ok: true });
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ ok: true });
      const [now] = await w.q<{ status: string; price_snapshot: unknown; remedy_cost_cents: number; copayment_cents: number }>("select status, price_snapshot, remedy_cost_cents, copayment_cents from prescriptions where id = $1", [id]);
      expect(now).toEqual({ status: "billed", price_snapshot: orig.price_snapshot, remedy_cost_cents: orig.remedy_cost_cents, copayment_cents: orig.copayment_cents });
    });

    it("R1-2/R1-3: alter Lauf (CSV und § 302) mit dem Stand der Erstabrechnung, je Verordnung einmal; Zeilensumme = Laufsumme", async () => {
      const w = await world();
      const { id, batchId } = await w.billed();
      const second = await w.ready();
      expect(await presc.changePrescriptionStatus(w.auth, { id: second, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      const [b] = await w.q<{ copayment_total_cents: number; remedy_total_cents: number }>("select copayment_total_cents, remedy_total_cents from billing_batches where id = $1", [batchId]);
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "ICD laut Kasse falsch" });
      if ("error" in res) throw new Error(res.error);
      // Korrektur: ICD und Einheiten der Position ändern (Zuzahlung/Heilmittelkosten ändern sich mit dem neuen Snapshot)
      expect(await presc.savePrescription(w.auth, w.formInput(id, "E11.40"))).toMatchObject({ id });
      await w.q("update prescriptions set copayment_cents = copayment_cents + 500 where id = $1", [id]);
      const csv = async (batch: string) => {
        const exp = await presc.billingBatchExport(w.auth, batch);
        const header = exp!.lines[0] as string[];
        return (exp!.lines.slice(1) as string[][]).map((l) => Object.fromEntries(header.map((h, i) => [h, l[i]])));
      };
      const cents = (v: string) => Math.round(Number(v.replace(",", ".")) * 100);
      // offen: alter Lauf zeigt den Stand der Erstabrechnung
      let old = await csv(batchId);
      expect(old).toHaveLength(1);
      expect(old[0]["ICD-10"]).toBe("E11.74");
      expect(old[0]["Korrektur"]).toBe("Korrektur offen");
      expect(cents(old[0]["Zuzahlung EUR"])).toBe(b.copayment_total_cents);
      // § 302 „lauf“: Originalstand; „bereit“ enthält die Verordnung noch nicht (Korrektur nötig)
      const lauf = await dbm.withOrg(w.org, (tx) => g302.ladeVerordnungen(tx, w.org, { art: "lauf", batchId }));
      expect(lauf!.map((v) => [v.id, v.icd10])).toEqual([[id, "E11.74"]]);

      // neu abrechnen im zweiten Lauf
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toMatchObject({ ok: true });
      const bereit = await dbm.withOrg(w.org, (tx) => g302.ladeVerordnungen(tx, w.org, { art: "bereit" }));
      expect(bereit!.find((v) => v.id === id)?.icd10).toBe("E11.40");
      const batch2 = await presc.createBillingBatch(w.auth, [id, second], { partner: "manual" });
      if ("error" in batch2) throw new Error(batch2.error);
      old = await csv(batchId);
      expect(old).toHaveLength(1);
      expect(old[0]).toMatchObject({ "ICD-10": "E11.74", Korrektur: "in späterem Lauf neu abgerechnet" });
      expect(cents(old[0]["Zuzahlung EUR"])).toBe(b.copayment_total_cents);
      expect(cents(old[0]["Heilmittelkosten EUR"])).toBe(b.remedy_total_cents);
      const lauf2 = await dbm.withOrg(w.org, (tx) => g302.ladeVerordnungen(tx, w.org, { art: "lauf", batchId }));
      expect(lauf2!.map((v) => [v.id, v.icd10])).toEqual([[id, "E11.74"]]);
      // neuer Lauf: korrigierte Fassung; Summe der Zeilen = Laufsumme
      const neu = await csv(batch2.id);
      const [b2] = await w.q<{ copayment_total_cents: number }>("select copayment_total_cents from billing_batches where id = $1", [batch2.id]);
      expect(neu.find((r) => r["Verordnung-ID"] === id)!["ICD-10"]).toBe("E11.40");
      expect(neu.reduce((s, r) => s + cents(r["Zuzahlung EUR"]), 0)).toBe(b2.copayment_total_cents);
      const lauf3 = await dbm.withOrg(w.org, (tx) => g302.ladeVerordnungen(tx, w.org, { art: "lauf", batchId: batch2.id }));
      expect(lauf3!.map((v) => v.id).sort()).toEqual([id, second].sort());
      expect(lauf3!.find((v) => v.id === id)!.icd10).toBe("E11.40");
    });

    it("R1-5: Neuabrechnung mit geänderter Zuzahlung → Hinweis (nicht blockiert)", async () => {
      const w = await world();
      const { id } = await w.billed();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Zuzahlung prüfen" });
      if ("error" in res) throw new Error(res.error);
      // unverändert → kein Hinweis
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "correction_needed" })).toEqual({ ok: true });
      // Person inzwischen befreit (Bescheinigung) → Zuzahlung 0 statt Erstabrechnung
      await w.q(`update patients set copayment_exemptions = $2 where id = $1`, [w.patient, JSON.stringify([{ id: "e1", validFrom: addDaysIso(today, -365), validTo: addDaysIso(today, 365), insurerIk: "109911114" }])]);
      const r = await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" });
      expect(r).toEqual({ ok: true, warning: expect.stringMatching(/Zuzahlung ändert sich gegenüber der Erstabrechnung von .* auf 0,00 €/) });
    });

    it("R1-6: Absetzungen nur mit Kassenabrechnung (Feature)", async () => {
      const w = await world();
      const privat = { ...(w.auth as object), organization: { id: w.org, name: "T", slug: "t", smallBusiness: false, state: "BE", billingMode: "private_only" } } as never;
      expect(await gb.listDeductions(privat)).toEqual({ error: expect.any(String) });
    });

    it("R1-9: Absetzung mit Kassenschreiben; „erledigt“ nur mit Ausgang (App und DB-CHECK)", async () => {
      const w = await world();
      const { id } = await w.billed();
      const created = await gb.createDeduction(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 900, reason: "Frist", deductedOn: today, letterRef: "AZ 4711/26", letterDate: addDaysIso(today, -2) });
      if ("error" in created) throw new Error(created.error);
      expect(await gb.createDeduction(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 900, reason: "Frist", deductedOn: today, letterDate: addDaysIso(today, 2) })).toEqual({ error: expect.stringMatching(/Kassenschreibens liegt in der Zukunft/) });
      expect(await gb.updateDeduction(w.auth, { id: created.id, status: "done" })).toEqual({ error: expect.stringMatching(/Ausgang/) });
      await expect(w.q("update gkv_deductions set status = 'done' where id = $1", [created.id])).rejects.toThrow(/gkv_deductions_outcome_check/);
      await expect(w.q("update gkv_deductions set outcome = 'reversed' where id = $1", [created.id])).rejects.toThrow(/gkv_deductions_outcome_check/);
      await expect(w.q("update gkv_deductions set status = 'done', outcome = 'egal' where id = $1", [created.id])).rejects.toThrow(/gkv_deductions_outcome_check/);
      expect(await gb.updateDeduction(w.auth, { id: created.id, status: "done", outcome: "reversed" })).toEqual({ ok: true });
      const list = await gb.listDeductions(w.auth);
      expect(list).toEqual([expect.objectContaining({ id: created.id, status: "done", outcome: "reversed", letterRef: "AZ 4711/26", letterDate: addDaysIso(today, -2) })]);
    });

    it("R1-10: Vermerk „erneut abgerechnet“ nur mit dem Lauf, der die Verordnung enthält", async () => {
      const w = await world();
      const { id, batchId } = await w.billed();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Absetzung prüfen" });
      if ("error" in res) throw new Error(res.error);
      const other = await w.billed();
      await expect(w.q("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_batch_id = $2 where id = $1", [res.id, other.batchId])).rejects.toThrow(/enthält die Verordnung nicht/);
      await expect(w.q("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_batch_id = $2 where id = $1", [res.id, batchId])).rejects.toThrow(/enthält die Verordnung nicht/);
      await expect(w.q("update prescription_corrections set resolution = 'no_rebill', resolved_at = now(), resolved_batch_id = $2 where id = $1", [res.id, batchId])).rejects.toThrow(/keinen neuen Lauf/);
    });
  });

  describe("Review-Runde 2", () => {
    it("S1: Neuabrechnung nach Korrektur nie im alten Lauf – abrechnungsreif → abgerechnet mit altem Lauf scheitert (App-Rolle, RLS)", async () => {
      const w = await world();
      const older = await w.billed(); // Lauf, der vor dem Korrekturvermerk entstand
      const { id, batchId } = await w.billed();
      const [orig] = await w.q<{ billed_at: Date }>("select billed_at from prescriptions where id = $1", [id]);
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "ICD laut Kasse falsch" });
      if ("error" in res) throw new Error(res.error);
      // Inhalt ändern → abrechnungsreif
      expect(await presc.savePrescription(w.auth, w.formInput(id, "E11.40"))).toMatchObject({ id });
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      // exakt die Umgehung: billed mit ALTEM Lauf (und altem Zeitpunkt), dann Vermerk „rebilled“ mit altem Lauf
      await expect(
        fx.asOrg(w.org, async (cl) => {
          await cl.query("update prescriptions set status = 'billed', billed_at = $2, billing_batch_id = $3 where id = $1", [id, orig.billed_at, batchId]);
          await cl.query("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_by = $2, resolved_batch_id = $3 where id = $1", [res.id, w.user, batchId]);
        }),
      ).rejects.toThrow(/neuen Abrechnungslauf/);
      // auch ein anderer, schon vor dem Vermerk bestehender Lauf ist kein „neuer“ Lauf
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, older.batchId])).rejects.toThrow(/neuen Abrechnungslauf/);
      // ohne Lauf ebenso nicht
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = null where id = $1", [id])).rejects.toThrow(/neuen Abrechnungslauf/);
      const [st] = await w.q<{ status: string; open: number }>("select p.status, (select count(*)::int from prescription_corrections c where c.prescription_id = p.id and c.resolved_at is null) as open from prescriptions p where p.id = $1", [id]);
      expect(st).toEqual({ status: "billing_ready", open: 1 });
      // regulär über einen neuen Lauf → erlaubt, Vermerk „erneut abgerechnet“ mit dem neuen Lauf
      const batch2 = await presc.createBillingBatch(w.auth, [id], { partner: "manual" });
      if ("error" in batch2) throw new Error(batch2.error);
      const [c] = await w.q<{ resolution: string; resolved_batch_id: string }>("select resolution, resolved_batch_id from prescription_corrections where id = $1", [res.id]);
      expect(c).toEqual({ resolution: "rebilled", resolved_batch_id: batch2.id });
    });

    it("S2/S4: original_* und created_at setzt der Trigger aus der Verordnungszeile – Werte der Anwendung werden überschrieben", async () => {
      const w = await world();
      const other = await w.billed();
      const { id, batchId } = await w.billed();
      const [vo] = await w.q<{ billed_at: Date; remedy_cost_cents: number; copayment_cents: number; price_snapshot: unknown }>("select billed_at, remedy_cost_cents, copayment_cents, price_snapshot from prescriptions where id = $1", [id]);
      await w.q(
        `insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, created_by, original_batch_id, original_billed_at, original_remedy_cost_cents,
           original_copayment_cents, original_price_snapshot, created_at)
         values ($1,$2,$3,'Testvermerk',$4,$5,'2000-01-01',1,2,'{"x":1}','2000-01-01')`,
        [w.org, id, w.patient, w.user, other.batchId],
      );
      const [c] = await w.q<{ original_batch_id: string; original_billed_at: Date; original_remedy_cost_cents: number; original_copayment_cents: number; original_price_snapshot: unknown; recent: boolean }>(
        "select original_batch_id, original_billed_at, original_remedy_cost_cents, original_copayment_cents, original_price_snapshot, created_at > now() - interval '5 minutes' as recent from prescription_corrections where prescription_id = $1",
        [id],
      );
      expect(c).toEqual({
        original_batch_id: batchId,
        original_billed_at: vo.billed_at,
        original_remedy_cost_cents: vo.remedy_cost_cents,
        original_copayment_cents: vo.copayment_cents,
        original_price_snapshot: vo.price_snapshot,
        recent: true,
      });
    });

    it("S3: Neubestätigung des Kennzeichens im Korrekturstatus erzwingt Neuabrechnung (App und DB)", async () => {
      const w = await world();
      const { id } = await w.billed();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Kennzeichen prüfen" });
      if ("error" in res) throw new Error(res.error);
      // gleiche Werte erneut bestätigt → Bestätigungszeitpunkt/-person ändern sich → keine Rückkehr in den alten Lauf
      expect(await gb.saveBillingDetails(w.auth, gb.billingDetailsInput.parse({ id, patientId: w.patient, prescriptionKind: "03" }))).toEqual({ ok: true });
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ error: "Geänderte Verordnung muss neu abgerechnet werden." });
      await expect(
        fx.asOrg(w.org, async (cl) => {
          await cl.query("update prescription_corrections set resolution = 'no_rebill', resolved_at = now(), resolved_by = $2 where id = $1", [res.id, w.user]);
          await cl.query("update prescriptions set status = 'billed' where id = $1", [id]);
        }),
      ).rejects.toThrow(/Geänderte Verordnung muss neu abgerechnet werden/);
      const { CORRECTION_VOLATILE_KEYS } = await import("@/lib/rules/gkv-billing");
      expect(CORRECTION_VOLATILE_KEYS).not.toContain("prescription_kind_confirmed_at");
      expect(CORRECTION_VOLATILE_KEYS).not.toContain("prescription_kind_confirmed_by");
    });

    it("H-1: „ohne Neuabrechnung“ nur zusammen mit der Rückkehr auf „abgerechnet“ im alten Lauf (Prüfung beim Commit)", async () => {
      const w = await world();
      const { id } = await w.billed();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Absetzung prüfen" });
      if ("error" in res) throw new Error(res.error);
      await expect(w.q("update prescription_corrections set resolution = 'no_rebill', resolved_at = now(), resolved_by = $2 where id = $1", [res.id, w.user])).rejects.toThrow(/ohne Neuabrechnung.*abgerechnet/i);
      const [st] = await w.q<{ status: string; resolution: string | null }>("select p.status, c.resolution from prescriptions p join prescription_corrections c on c.prescription_id = p.id where p.id = $1", [id]);
      expect(st).toEqual({ status: "correction_needed", resolution: null });
      // regulär (App) weiterhin möglich
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ ok: true });
    });

    it("H-2: Altbestand ohne Preis-Snapshot – „ohne Neuabrechnung“ schreibt SQL-NULL zurück, nicht JSON null", async () => {
      const w = await world();
      // Lauf und Verordnung in EINER Transaktion (INSERT mit Lauf nur in einen eben angelegten Lauf, AppSec Runde 4)
      const p = await fx.asOrg(w.org, async (cl) => {
        // Anzahl/Summen = die eine Verordnung ohne Beträge (Prüfung beim Commit, 0067)
        const b = (await cl.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 0, 0, 0) returning id", [w.org])).rows[0].id as string;
        return (
          await cl.query(
            "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id) values ($1,$2,$3,'DF',2,'billed',now(),$4) returning id",
            [w.org, w.patient, addDaysIso(today, -60), b],
          )
        ).rows[0] as { id: string };
      });
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: p.id, patientId: w.patient, reason: "Altbestand prüfen" });
      if ("error" in res) throw new Error(res.error);
      expect(await gb.resolveCorrectionWithoutRebill(w.auth, { prescriptionId: p.id, patientId: w.patient, note: "Absetzung akzeptiert" })).toEqual({ ok: true });
      const [r] = await w.q<{ status: string; snap_null: boolean }>("select status, price_snapshot is null as snap_null from prescriptions where id = $1", [p.id]);
      expect(r).toEqual({ status: "billed", snap_null: true });
    });

    it("N2: CSV des alten Laufs – Versichertennummer aus der Verordnung, nicht aus der (inzwischen geänderten) Person", async () => {
      const w = await world();
      const { id, batchId } = await w.billed();
      await w.q("update patients set insurance_number = 'Z999999999' where id = $1", [w.patient]);
      const col = async () => {
        const exp = await presc.billingBatchExport(w.auth, batchId);
        const header = exp!.lines[0] as string[];
        return (exp!.lines[1] as string[])[header.indexOf("Versichertennummer")];
      };
      expect(await col()).toBe("A000500015");
      // auch mit Stand der Erstabrechnung (original_row), während die Verordnung korrigiert wird
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "Versichertennummer prüfen" });
      if ("error" in res) throw new Error(res.error);
      expect(await presc.savePrescription(w.auth, { ...w.formInput(id), insuranceNumber: "B111111111" })).toMatchObject({ id });
      expect(await col()).toBe("A000500015");
    });

    it("N5: Aktenzeichen/Datum des Kassenschreibens explizit leeren (solange nicht erledigt); fehlendes Feld = unverändert", async () => {
      const w = await world();
      const { id } = await w.billed();
      const created = await gb.createDeduction(w.auth, { prescriptionId: id, patientId: w.patient, amountCents: 900, reason: "Frist", deductedOn: today, letterRef: "AZ 1", letterDate: addDaysIso(today, -2) });
      if ("error" in created) throw new Error(created.error);
      const row = async () => (await w.q<{ letter_ref: string | null; letter_date: string | null }>("select letter_ref, letter_date::text from gkv_deductions where id = $1", [created.id]))[0];
      expect(await gb.updateDeduction(w.auth, gb.deductionUpdateInput.parse({ id: created.id, status: "open" }))).toEqual({ ok: true });
      expect(await row()).toEqual({ letter_ref: "AZ 1", letter_date: addDaysIso(today, -2) });
      expect(await gb.updateDeduction(w.auth, gb.deductionUpdateInput.parse({ id: created.id, status: "open", letterRef: "", letterDate: "" }))).toEqual({ ok: true });
      expect(await row()).toEqual({ letter_ref: null, letter_date: null });
    });

    it("Abrechnungsläufe sind nie löschbar; Anlagezeitpunkt vom Server und unveränderlich", async () => {
      const w = await world();
      const { batchId } = await w.billed();
      await expect(w.q("delete from billing_batches where id = $1", [batchId])).rejects.toThrow(/Abrechnungslauf kann nicht gelöscht werden/);
      await expect(w.q("update billing_batches set created_at = created_at - interval '1 day' where id = $1", [batchId])).rejects.toThrow(/unveränderlich/);
      // neuer Lauf nur mit seiner Verordnung (Summenprüfung beim Commit, 0067) – vorgegebener Anlagezeitpunkt wirkt nicht
      const b = await fx.asOrg(w.org, async (cl) => {
        const [r] = (await cl.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, created_at) values ($1, 1, 0, 0, 0, '2000-01-01') returning id, created_at > now() - interval '5 minutes' as recent", [w.org])).rows;
        await cl.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id) values ($1,$2,$3,'DF',2,'billed',now(),$4)", [w.org, w.patient, addDaysIso(today, -60), r.id]);
        return r as { recent: boolean };
      });
      expect(b.recent).toBe(true);
    });
  });

  describe("Review-Runde 3", () => {
    it("N1: Neuabrechnung nur in einem in derselben Transaktion angelegten, nicht übergebenen Lauf – späterer exportierter Lauf abgelehnt", async () => {
      const w = await world();
      const { id } = await w.billed();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "ICD laut Kasse falsch" });
      if ("error" in res) throw new Error(res.error);
      expect(await presc.savePrescription(w.auth, w.formInput(id, "E11.40"))).toMatchObject({ id });
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      // späterer, fremder Lauf (nach dem Vermerk angelegt) – exportiert bzw. nicht exportiert, aber in einem früheren Vorgang
      const later = await w.billed();
      expect(await presc.billingBatchExport(w.auth, later.batchId)).not.toBeNull();
      await expect(
        fx.asOrg(w.org, async (cl) => {
          await cl.query("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, later.batchId]);
          await cl.query("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_by = $2, resolved_batch_id = $3 where id = $1", [res.id, w.user, later.batchId]);
        }),
      ).rejects.toThrow(/neuen Abrechnungslauf/);
      // früher angelegter, nicht übergebener Lauf (seit 0067 nur mit seinen Verordnungen anlegbar)
      const draft = await w.billed();
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, draft.batchId])).rejects.toThrow(/neuen Abrechnungslauf/);
      // normaler Ablauf + anschließender Export
      const batch2 = await presc.createBillingBatch(w.auth, [id], { partner: "manual" });
      if ("error" in batch2) throw new Error(batch2.error);
      expect(await presc.billingBatchExport(w.auth, batch2.id)).not.toBeNull();
      const [c] = await w.q<{ resolution: string; resolved_batch_id: string }>("select resolution, resolved_batch_id from prescription_corrections where id = $1", [res.id]);
      expect(c).toEqual({ resolution: "rebilled", resolved_batch_id: batch2.id });
      // zweite Korrektur: weder der (exportierte) Lauf der Neuabrechnung noch ein früherer Lauf
      const res2 = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "noch einmal korrigieren" });
      if ("error" in res2) throw new Error(res2.error);
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, batch2.id])).rejects.toThrow(/neuen Abrechnungslauf/);
      const batch3 = await presc.createBillingBatch(w.auth, [id], { partner: "manual" });
      expect(batch3).toMatchObject({ count: 1 });
    });

    it("N3: abrechnungsreif → abgerechnet generell nur in einen Lauf derselben Transaktion, nicht übergeben (ohne Korrektur)", async () => {
      const w = await world();
      const id = await w.ready();
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      const other = await w.billed();
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, other.batchId])).rejects.toThrow(/neuen Abrechnungslauf/);
      await expect(w.q("update prescriptions set status = 'billed', billed_at = now() where id = $1", [id])).rejects.toThrow(/neuen Abrechnungslauf/);
      // in derselben Transaktion angelegt, aber schon übergeben → abgelehnt
      await expect(
        fx.asOrg(w.org, async (cl) => {
          const b = (await cl.query("insert into billing_batches (organization_id, prescription_count) values ($1, 1) returning id", [w.org])).rows[0].id as string;
          await cl.query("update billing_batches set exported_at = now(), status = 'exported' where id = $1", [b]);
          await cl.query("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, b]);
        }),
      ).rejects.toThrow(/neuen Abrechnungslauf/);
      // regulär (createBillingBatch, eine Transaktion) → ok
      expect(await presc.createBillingBatch(w.auth, [id], { partner: "manual" })).toMatchObject({ count: 1 });
    });

    it("Runde 4: CSV – leere Versichertennummer an der Verordnung (Altbestand) fällt auf die Person zurück", async () => {
      const w = await world();
      await w.q("update patients set insurance_number = 'P123456789' where id = $1", [w.patient]);
      const b = await fx.asOrg(w.org, async (cl) => {
        const id = (await cl.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 0, 0, 0) returning id", [w.org])).rows[0].id as string;
        await cl.query(
          "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id, insurance_number) values ($1,$2,$3,'DF',2,'billed',now(),$4,'')",
          [w.org, w.patient, addDaysIso(today, -60), id],
        );
        return { id };
      });
      const exp = await presc.billingBatchExport(w.auth, b.id);
      const header = exp!.lines[0] as string[];
      expect((exp!.lines[1] as string[])[header.indexOf("Versichertennummer")]).toBe("P123456789");
    });

    it("N2: Abrechnungslauf nach dem Anlegen unveränderlich – nur Übergabe (exported_at einmalig, Status draft → exported)", async () => {
      const w = await world();
      const { batchId } = await w.billed();
      for (const set of ["remedy_total_cents = 1", "total_cents = 1", "copayment_total_cents = 1", "prescription_count = 99", "partner = 'anders'", "note = 'x'"]) {
        await expect(w.q(`update billing_batches set ${set} where id = $1`, [batchId])).rejects.toThrow(/unveränderlich/);
      }
      await expect(w.q("update billing_batches set status = 'paid' where id = $1", [batchId])).rejects.toThrow(/unveränderlich|Status/);
      expect(await presc.billingBatchExport(w.auth, batchId)).not.toBeNull();
      const [b] = await w.q<{ status: string; exported: boolean }>("select status, exported_at is not null as exported from billing_batches where id = $1", [batchId]);
      expect(b).toEqual({ status: "exported", exported: true });
      expect(await presc.billingBatchExport(w.auth, batchId)).not.toBeNull(); // erneuter Export ändert nichts
      await expect(w.q("update billing_batches set exported_at = null where id = $1", [batchId])).rejects.toThrow(/unveränderlich|übergeben/);
      await expect(w.q("update billing_batches set exported_at = exported_at + interval '1 day' where id = $1", [batchId])).rejects.toThrow(/unveränderlich|übergeben/);
      await expect(w.q("update billing_batches set status = 'draft' where id = $1", [batchId])).rejects.toThrow(/unveränderlich|Status/);
    });
  });

  describe("Review-Runde 4 (AppSec Runde 4)", () => {
    /** Spalten „Verordnung-ID“ des CSV-Exports eines Laufs */
    const exportIds = async (w: Awaited<ReturnType<typeof world>>, batchId: string) => {
      const exp = await presc.billingBatchExport(w.auth, batchId);
      const header = exp!.lines[0] as string[];
      return (exp!.lines.slice(1) as string[][]).map((l) => l[header.indexOf("Verordnung-ID")]);
    };

    it("S7: Lauf an einer nicht abgerechneten Verordnung nicht setzbar (UPDATE billing_batch_id bei abrechnungsreif)", async () => {
      const w = await world();
      const done = await w.billed();
      expect(await presc.billingBatchExport(w.auth, done.batchId)).not.toBeNull();
      const id = await w.ready();
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      await expect(w.q("update prescriptions set billing_batch_id = $2 where id = $1", [id, done.batchId])).rejects.toThrow(/Abrechnungslauf/);
      expect(await exportIds(w, done.batchId)).toEqual([done.id]);
    });

    it("S6/S6b: INSERT mit altem (übergebenem) Lauf abgelehnt – abgerechnet und abrechnungsreif", async () => {
      const w = await world();
      const done = await w.billed();
      expect(await presc.billingBatchExport(w.auth, done.batchId)).not.toBeNull();
      for (const status of ["billed", "billing_ready"]) {
        await expect(
          w.q("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id) values ($1,$2,$3,'DF',2,$4,now(),$5)", [w.org, w.patient, addDaysIso(today, -60), status, done.batchId]),
        ).rejects.toThrow(/Abrechnungslauf/);
      }
      // auch ein noch nicht übergebener, aber früher angelegter Lauf
      // (seit 0067 nur mit seinen Verordnungen anlegbar)
      const draft = await w.billed();
      await expect(
        w.q("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id) values ($1,$2,$3,'DF',2,'billed',now(),$4)", [w.org, w.patient, addDaysIso(today, -60), draft.batchId]),
      ).rejects.toThrow(/Abrechnungslauf/);
      expect(await exportIds(w, done.batchId)).toEqual([done.id]);
    });

    it("S8: korrigierte Verordnung nicht in einen fremden übergebenen Lauf umhängbar", async () => {
      const w = await world();
      const { id, batchId } = await w.billed();
      const other = await w.billed();
      expect(await presc.billingBatchExport(w.auth, other.batchId)).not.toBeNull();
      const res = await gb.markCorrectionNeeded(w.auth, { prescriptionId: id, patientId: w.patient, reason: "ICD laut Kasse falsch" });
      if ("error" in res) throw new Error(res.error);
      await expect(w.q("update prescriptions set billing_batch_id = $2 where id = $1", [id, other.batchId])).rejects.toThrow(/Abrechnungslauf/);
      expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
      await expect(w.q("update prescriptions set billing_batch_id = $2 where id = $1", [id, other.batchId])).rejects.toThrow(/Abrechnungslauf/);
      expect(await exportIds(w, other.batchId)).toEqual([other.id]);
      // Export des alten Laufs führt die Verordnung weiter (Stand der Erstabrechnung)
      expect(await exportIds(w, batchId)).toEqual([id]);
    });

    it("Export: nur abgerechnete Verordnungen eines Laufs (Altbestand mit Lauf, aber nicht abgerechnet, fehlt) – CSV und § 302", async (ctx) => {
      const w = await world();
      const done = await w.billed();
      const legacy = await w.ready();
      if (!(await insertLegacy("update prescriptions set status = 'billing_ready', billing_batch_id = $2 where id = $1", [legacy, done.batchId]))) ctx.skip();
      expect(await exportIds(w, done.batchId)).toEqual([done.id]);
      const lauf = await dbm.withOrg(w.org, (tx) => g302.ladeVerordnungen(tx, w.org, { art: "lauf", batchId: done.batchId }));
      expect(lauf!.map((v) => v.id)).toEqual([done.id]);
    });

    it("R3: Lauf – beim Anlegen Entwurf ohne Übergabe; Übergabe nur mit Status, Zeitpunkt vom Server", async () => {
      const w = await world();
      // neuer Lauf nur mit seiner Verordnung (Summenprüfung beim Commit, 0067)
      const b = await fx.asOrg(w.org, async (cl) => {
        const [r] = (
          await cl.query(
            "insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, status, exported_at) values ($1, 1, 0, 0, 0, 'exported', '2000-01-01') returning id, status, exported_at",
            [w.org],
          )
        ).rows;
        await cl.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id) values ($1,$2,$3,'DF',2,'billed',now(),$4)", [w.org, w.patient, addDaysIso(today, -60), r.id]);
        return r as { id: string; status: string; exported_at: Date | null };
      });
      expect(b).toMatchObject({ status: "draft", exported_at: null });
      await expect(w.q("update billing_batches set status = 'exported' where id = $1", [b.id])).rejects.toThrow(/Übergabe|Status/);
      await expect(w.q("update billing_batches set exported_at = now() where id = $1", [b.id])).rejects.toThrow(/Übergabe|Status/);
      const [u] = await w.q<{ recent: boolean; status: string }>("update billing_batches set exported_at = '2000-01-01', status = 'exported' where id = $1 returning exported_at > now() - interval '5 minutes' as recent, status", [b.id]);
      expect(u).toEqual({ recent: true, status: "exported" });
    });
  });
});
