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
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("GKV Paket C – Verordnungsart, Absetzungen, Korrektur (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let presc: typeof import("./prescriptions");
  let gb: typeof import("./gkv-billing");
  let del: typeof import("./patient-deletion");
  let dbm: typeof import("@/db");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    presc = await import("./prescriptions");
    gb = await import("./gkv-billing");
    del = await import("./patient-deletion");
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
    return { org, user, patient, auth, authWith, q, vo, past, ready, billed };
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
    expect(await gb.updateDeduction(w.auth, { id: created.id, status: "done" })).toEqual({ ok: true });
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
    await expect(w.q("update prescriptions set status = 'correction_needed' where id = $1", [id])).rejects.toThrow(/unveränderbar/);
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
});
