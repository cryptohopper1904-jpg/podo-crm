/**
 * GKV Paket B (Teil 2) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten): Therapiebericht (Position 78530 mit
 * Berichtsdatum im Preis-Snapshot, Sperre ab „abrechnungsreif“, PDF) und Folgeverordnung (Hinweis, Vermerk, Vorlage,
 * Dauerpatient:in, Planungshinweis, Löschen der Person).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { berlinToUtc } from "@/lib/format";
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("GKV Paket B Teil 2 – Therapiebericht und Folgeverordnung (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let presc: typeof import("./prescriptions");
  let reports: typeof import("./therapy-reports");
  let follow: typeof import("./follow-ups");
  let planning: typeof import("./appointment-prescriptions");
  let dbm: typeof import("@/db");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    presc = await import("./prescriptions");
    reports = await import("./therapy-reports");
    follow = await import("./follow-ups");
    planning = await import("./appointment-prescriptions");
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
    const auth = { organization: { id: org, name: "Testpraxis", slug: "t", smallBusiness: false, state: "BB", billingMode: "with_gkv" }, user: { id: user, name: "Anna Test" }, role: "owner", can: () => true } as never;
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    /** UI2 mit Nagelspange (78610) und Therapiebericht (78530) bzw. DF */
    const vo = async (o: { group?: "UI2" | "DF"; units?: number; status?: string; issuedAt?: string } = {}) => {
      const ui = (o.group ?? "UI2") === "UI2";
      const units = o.units ?? 2;
      const positions = ui ? [{ position: "78610", label: "Nagelspangenbehandlung", units }, { position: "78530", label: "Therapiebericht UI 2", units: 1 }] : [{ position: "78020", label: "groß", units }];
      return (
        await q<{ id: string }>(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version,
             icd10, insurer_ik, insurance_number, insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, doctor_name, frequency_per_week)
           values ($1,$2,$3,$4,$5,$6,($3::date + 28),$7,$8,$9,'109911114','A000500015','1','123456601','123456789',true,'a','Dr. Beispiel','1x wöchentlich') returning id`,
          [org, patient, o.issuedAt ?? addDaysIso(today, -20), ui ? "UI2" : "DF", units, o.status ?? "open", JSON.stringify(positions), RULES_VERSION, ui ? "L60.0" : "E11.74"],
        )
      )[0].id;
    };
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
      return r.id;
    };
    return { org, user, patient, auth, q, vo, past };
  };

  it("B3: Therapiebericht anlegen/ändern; Pflichtfelder, Datum; 78530 mit Berichtsdatum im Snapshot (copay null); danach gesperrt", async () => {
    const w = await world();
    const id = await w.vo({ status: "completed" });
    await w.past(id, addDaysIso(today, -14));
    await w.past(id, addDaysIso(today, -7));
    const list = await presc.listPatientPrescriptions(w.auth, w.patient);
    expect(list!.prescriptions.find((x) => x.id === id)).toMatchObject({ therapyReport: null, therapyReportOrdered: true });
    const base = { prescriptionId: id, patientId: w.patient, reportDate: addDaysIso(today, -3), findings: null, course: null, result: null, recommendation: null, notes: null };
    expect(await reports.saveTherapyReport(w.auth, base)).toEqual({ error: expect.stringMatching(/mindestens Befund/) });
    expect(await reports.saveTherapyReport(w.auth, { ...base, findings: "x", reportDate: addDaysIso(today, 1) })).toEqual({ error: expect.stringMatching(/Zukunft/) });
    expect(await reports.saveTherapyReport(w.auth, { ...base, findings: "Unguis incarnatus D1 rechts", course: "Spange gut verträglich" })).toEqual({ id: expect.any(String), created: true });
    expect(await reports.saveTherapyReport(w.auth, { ...base, findings: "Unguis incarnatus D1 rechts", result: "entzündungsfrei", recommendation: "Fortsetzung" })).toEqual({ id: expect.any(String), created: false });
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true });
    const [row] = await w.q<{ price_snapshot: { lines: { date: string; position: string; units: number; copayCents: number | null }[] } }>("select price_snapshot from prescriptions where id = $1", [id]);
    const lines = row.price_snapshot.lines;
    expect(lines.filter((l) => l.position === "78530")).toEqual([expect.objectContaining({ date: addDaysIso(today, -3), units: 1, copayCents: null })]);
    expect(lines.filter((l) => l.position === "78610").map((l) => l.date)).toEqual([addDaysIso(today, -14), addDaysIso(today, -7)]);
    const keys = lines.map((l) => `${l.date}|${l.position}`);
    expect(new Set(keys).size).toBe(keys.length);
    // ab „abrechnungsreif“: App und DB sperren Änderungen, Löschen nie
    expect(await reports.saveTherapyReport(w.auth, { ...base, findings: "neu" })).toEqual({ error: expect.stringMatching(/nicht mehr änderbar/) });
    await expect(w.q("update therapy_reports set findings = 'x' where prescription_id = $1", [id])).rejects.toThrow(/nicht mehr änderbar/);
    await expect(w.q("delete from therapy_reports where prescription_id = $1", [id])).rejects.toThrow(/permission denied|nicht gelöscht/);
    // PDF
    const pdf = await reports.therapyReportPdf(w.auth, id);
    expect(Buffer.from(pdf!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    const other = await w.vo({ group: "DF" });
    expect(await reports.therapyReportPdf(w.auth, other)).toBeNull();
    // Bericht muss zur Person der Verordnung passen (Trigger)
    const stranger = await fx.patient(w.org, { lastName: "Anders" });
    await expect(w.q("insert into therapy_reports (organization_id, prescription_id, patient_id, report_date, findings, created_by) values ($1,$2,$3,$4,'x',$5)", [w.org, other, stranger, today, w.user])).rejects.toThrow(/passt nicht zur Verordnung/);
  });

  it("B3: ohne Bericht wird 78530 nicht angesetzt (Hinweis im Snapshot)", async () => {
    const w = await world();
    const id = await w.vo({ units: 1, status: "completed" });
    await w.past(id, addDaysIso(today, -5));
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true, warning: expect.stringMatching(/Therapiebericht fehlt/) });
    const [row] = await w.q<{ price_snapshot: { lines: { position: string }[]; notes: string[] } }>("select price_snapshot from prescriptions where id = $1", [id]);
    expect(row.price_snapshot.lines.map((l) => l.position)).toEqual(["78610"]);
    expect(row.price_snapshot.notes.join(" ")).toMatch(/Therapiebericht \(78530\) noch nicht erstellt/);
  });

  it("B4: Hinweis „Folgeverordnung anfordern“ bei beendeter Verordnung + Termin bzw. Dauerpatient:in; Vermerk; Vorlage; neuere VO", async () => {
    const w = await world();
    const id = await w.vo({ group: "DF", units: 2, status: "completed" });
    await w.past(id, addDaysIso(today, -10));
    await w.past(id, addDaysIso(today, -3));
    const state = async () => (await presc.listPatientPrescriptions(w.auth, w.patient))!.prescriptions.find((x) => x.id === id)!.followUp;
    // ohne weitere Termine und ohne Dauerpatient:in: kein Hinweis
    expect(await state()).toBeNull();
    expect(await follow.setFollowUpExpected(w.auth, { patientId: w.patient, on: true })).toEqual({ ok: true });
    expect(await state()).toMatchObject({ reason: "ended", requestedOn: null });
    await follow.setFollowUpExpected(w.auth, { patientId: w.patient, on: false });
    // geplanter Termin in der Zukunft
    await w.q("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,$3,$4,'planned')", [w.org, w.patient, berlinToUtc(addDaysIso(today, 7), "09:00"), berlinToUtc(addDaysIso(today, 7), "09:45")]);
    expect(await state()).toMatchObject({ reason: "ended" });
    expect((await follow.followUpsDue(w.auth)).items).toEqual([expect.objectContaining({ patientId: w.patient, prescriptionId: id })]);
    expect((await follow.patientFollowUpHint(w.auth, w.patient))?.reason).toBe("ended");
    // Vorlage (Text/PDF) mit Diagnose und Verlauf aus dem Therapiebericht
    await w.q("insert into therapy_reports (organization_id, prescription_id, patient_id, report_date, course, created_by) values ($1,$2,$3,$4,'Hyperkeratosen rückläufig',$5)", [w.org, id, w.patient, addDaysIso(today, -3), w.user]);
    const txt = await follow.followUpDocument(w.auth, id, "text");
    const text = Buffer.from(txt!.bytes).toString("utf8");
    expect(text).toMatch(/Folgeverordnung/);
    expect(text).toMatch(/ICD-10 E11\.74/);
    expect(text).toMatch(/Dr\. Beispiel/);
    const pdf = await follow.followUpDocument(w.auth, id, "pdf");
    expect(Buffer.from(pdf!.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    // Vermerk „angefordert am“ – danach nicht mehr auf „Heute“, Hinweis bleibt mit Datum in der Akte
    expect(await follow.markFollowUpRequested(w.auth, { prescriptionId: id, patientId: w.patient, note: "per Fax" })).toEqual({ ok: true });
    expect(await state()).toMatchObject({ requestedOn: today });
    expect((await follow.followUpsDue(w.auth)).total).toBe(0);
    await expect(w.q("update follow_up_requests set note = 'x' where prescription_id = $1", [id])).rejects.toThrow(/permission denied|unveränderbar/);
    // neue Verordnung → kein Hinweis mehr an der alten
    await w.vo({ group: "DF", issuedAt: today });
    expect(await state()).toBeNull();
  });

  it("B4: letzte Einheit offen + Termin → Hinweis; Planen nach Ende der Verordnung ohne neue VO → Warnung", async () => {
    const w = await world();
    const id = await w.vo({ group: "DF", units: 2, status: "active" });
    await w.past(id, addDaysIso(today, -10));
    await w.q("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,$3,$4,'planned')", [w.org, w.patient, berlinToUtc(addDaysIso(today, 14), "09:00"), berlinToUtc(addDaysIso(today, 14), "09:45")]);
    expect((await follow.patientFollowUpHint(w.auth, w.patient))?.reason).toBe("last_unit");
    // Restmenge überschritten → Erinnerung an die Folgeverordnung
    const plan = await planning.planningForPatient(w.auth, { patientId: w.patient, dates: [addDaysIso(today, 14), addDaysIso(today, 42)], prescriptionId: id });
    expect(plan.warnings.join(" ")).toMatch(/Folgeverordnung/);
    // Verordnung beendet, keine neue → Hinweis beim Planen
    await w.past(id, addDaysIso(today, -2));
    await w.q("update prescriptions set status = 'completed' where id = $1", [id]);
    const after = await planning.planningForPatient(w.auth, { patientId: w.patient, dates: [addDaysIso(today, 21)] });
    expect(after.options).toEqual([]);
    expect(after.warnings).toEqual([expect.stringMatching(/nach Ende der Verordnung vom .* keine neue Verordnung vorhanden/)]);
  });

  it("R2-18/21: Therapiebericht ist aufbewahrungspflichtig; Vermerk geht mit der Person; App-Rolle kann nicht löschen", async () => {
    const w = await world();
    const p = await fx.patient(w.org, { lastName: "Löschbar" });
    const [vo] = await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',6) returning id", [w.org, p, today]);
    await w.q("insert into follow_up_requests (organization_id, prescription_id, patient_id, requested_on, created_by) values ($1,$2,$3,$4,$5)", [w.org, vo.id, p, today, w.user]);
    // App-Rolle: auch mit gesetztem podo.patient_delete kein Löschen (Rechteentzug + Prüfung auf Eigentümer)
    await expect(
      fx.asOrg(w.org, async (c) => {
        await c.query("select set_config('podo.patient_delete', $1, true)", [p]);
        await c.query("delete from follow_up_requests where patient_id = $1", [p]);
      }),
    ).rejects.toThrow(/permission denied|unveränderbar/);
    // ohne Bericht: Löschen der Person nimmt den Vermerk mit
    const [del] = await w.q<{ ok: boolean }>("select podo_delete_patient($1) as ok", [p]);
    expect(del.ok).toBe(true);
    expect((await w.q("select id from follow_up_requests where patient_id = $1", [p])).length).toBe(0);
    // mit Bericht: aufbewahrungspflichtig (App-Prüfung und DB-Funktion)
    const q2 = await fx.patient(w.org, { lastName: "MitBericht" });
    const [vo2] = await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',6) returning id", [w.org, q2, today]);
    await w.q("insert into therapy_reports (organization_id, prescription_id, patient_id, report_date, findings, created_by) values ($1,$2,$3,$4,'x',$5)", [w.org, vo2.id, q2, today, w.user]);
    const { retentionFacts } = await import("./patient-deletion");
    expect((await retentionFacts(w.org, q2))!.lastTreatmentAt).not.toBeNull();
    await expect(w.q("select podo_delete_patient($1) as ok", [q2])).rejects.toThrow(/Aufbewahrungspflicht/);
    // auch der Eigentümer (Kaskade über die Verordnung) kann den Bericht nicht löschen
    await expect(w.q("delete from prescriptions where id = $1", [vo2.id])).rejects.toThrow(/Aufbewahrungspflicht|permission denied/);
  });

  it("R2-19: gewählte, abgeschlossene Verordnung → Hinweis „nicht mehr buchbar“ vor dem Folgeverordnungs-Hinweis", async () => {
    const w = await world();
    const id = await w.vo({ group: "DF", units: 1, status: "completed" });
    await w.past(id, addDaysIso(today, -3));
    const plan = await planning.planningForPatient(w.auth, { patientId: w.patient, dates: [addDaysIso(today, 7)], prescriptionId: id });
    expect(plan.warnings).toEqual([expect.stringMatching(/nicht mehr buchbar/)]);
  });

  it("R2-20: Berichtsdatum nicht vor dem ersten Behandlungstag, ungültiges Kalenderdatum → Formularfehler", async () => {
    const w = await world();
    const id = await w.vo({ status: "active" });
    await w.past(id, addDaysIso(today, -5));
    const base = { prescriptionId: id, patientId: w.patient, findings: "x", course: null, result: null, recommendation: null, notes: null };
    expect(await reports.saveTherapyReport(w.auth, { ...base, reportDate: addDaysIso(today, -6) })).toEqual({ error: expect.stringMatching(/ersten Behandlungstag/) });
    expect(await reports.saveTherapyReport(w.auth, { ...base, reportDate: "2026-02-30" })).toEqual({ error: expect.stringMatching(/Datum/) });
    expect(await reports.saveTherapyReport(w.auth, { ...base, reportDate: addDaysIso(today, -5) })).toHaveProperty("id");
  });

  it("R2-22/23: followUpsDue nur mit medizinischem Leserecht; abrechnungsreif ohne Bericht bei 78530 → Warnung; Frist überschritten → Hinweis", async () => {
    const w = await world();
    const reception = { ...(w.auth as object), role: "reception", can: (p: string) => p !== "medical.read" && p !== "medical.write" } as never;
    await expect(follow.followUpsDue(reception)).rejects.toThrow();
    const id = await w.vo({ status: "completed", units: 1 });
    await w.past(id, addDaysIso(today, -3));
    expect(await presc.changePrescriptionStatus(w.auth, { id, patientId: w.patient, to: "billing_ready" })).toEqual({ ok: true, warning: expect.stringMatching(/Therapiebericht fehlt/) });
    // abgelaufene Verordnung mit Behandlung + Dauerpatient:in → Hinweis
    const ex = await w.vo({ group: "DF", units: 6, status: "expired", issuedAt: today });
    await w.past(ex, addDaysIso(today, 0));
    await follow.setFollowUpExpected(w.auth, { patientId: w.patient, on: true });
    expect((await follow.patientFollowUpHint(w.auth, w.patient))?.reason).toBe("ended");
  });
});
