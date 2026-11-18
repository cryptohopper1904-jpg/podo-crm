/**
 * GKV Paket C (Teil 2) gegen PostgreSQL (App-Rolle, RLS aktiv, erfundene Daten): Auswertung Kasse vs. privat (Kassenanteil
 * laut Abrechnungslauf, Zuzahlungsquittungen getrennt, Privatumsatz, Absetzungen; Zeitraum) und Belegliste (ZZ mit
 * Storno, Abrechnungsläufe, CSV) mit Rechten und Mandantentrennung.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const session = vi.hoisted(() => ({ auth: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ requireAuth: async () => session.auth }));
import { addDaysIso } from "@/lib/calendar-grid";
import { RULES_VERSION } from "@/lib/rules/prescription";
import { resolvePeriod } from "@/lib/stats";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("GKV Paket C Teil 2 – Kasse vs. privat und Belegliste (DB)", () => {
  const fx = fixtures(TEST_DB ?? "");
  let stats: typeof import("./gkv-stats");
  let copay: typeof import("./copayments");
  let dbm: typeof import("@/db");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.TSE_PROVIDER;
    stats = await import("./gkv-stats");
    copay = await import("./copayments");
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
    session.auth = auth;
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => fx.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    const vo = async () =>
      (
        await q<{ id: string }>(
          `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, start_by, positions, rules_version, icd10, insurer_ik, insurance_number,
             insured_status, doctor_lanr, doctor_bsnr, doctor_signed, leitsymptomatik, prescription_kind, prescription_kind_confirmed_at)
           values ($1,$2,$3,'DF',1,'open',($3::date + 28),'[{"position":"78020","label":"groß","units":1}]',$4,'E11.74','109911114','A000500015','1','123456601','123456789',true,'c','03',now()) returning id`,
          [org, patient, addDaysIso(today, -3), RULES_VERSION],
        )
      )[0].id;
    return { org, user, patient, auth, authWith, q, vo };
  };

  it("Kasse vs. privat: Kassenanteil laut Lauf, ZZ getrennt (ohne Storno), Privat ohne Entwürfe/ZZ, Absetzungen; Zeitraum; fremde Praxis leer", async () => {
    const w = await world();
    // Abrechnungslauf heute: Heilmittelkosten 71,10 €, Zuzahlungen 17,12 € → Kassenanteil 53,98 €; alter Lauf ohne Heilmittelkosten
    await w.q("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 2, 1712, 1712, 7110)", [w.org]);
    await w.q("insert into billing_batches (organization_id, prescription_count, total_cents) values ($1, 1, 500)", [w.org]);
    await w.q("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, created_at) values ($1, 1, 100, 100, 1000, now() - interval '400 days')", [w.org]);
    // Zuzahlungsquittungen: eine gültige, eine stornierte (mit Stornobeleg)
    const a = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: await w.vo(), patientId: w.patient, amountCents: 1500, method: "transfer", confirmOverpay: true })) as { id: string; number: string };
    const b = (await copay.createCopaymentReceipt(w.auth, { prescriptionId: await w.vo(), patientId: w.patient, amountCents: 900, method: "transfer", confirmOverpay: true })) as { id: string; number: string };
    expect(a.number).toMatch(/^ZZ/);
    const ref = await copay.refundCopaymentReceipt(w.auth, { invoiceId: b.id, patientId: w.patient, method: "transfer", reason: "falscher Betrag" });
    expect(ref).toHaveProperty("number");
    // Privat: ausgestellte Rechnung 65,00 €, Entwurf zählt nicht
    await fx.invoice(w.org, w.patient, 6500);
    await w.q("insert into invoices (organization_id, patient_id, status, total_cents) values ($1,$2,'draft',9999)", [w.org, w.patient]);
    // Absetzung (zu einer abgerechneten Verordnung)
    const billed = (await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at) values ($1,$2,$3,'DF',1,'billed',now()) returning id", [w.org, w.patient, addDaysIso(today, -30)]))[0].id;
    await w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, amount_cents, reason, deducted_on, created_by) values ($1,$2,$3,700,'Frist',$4,$5)", [w.org, billed, w.patient, today, w.user]);

    const period = resolvePeriod({ zeitraum: "monat" }, today);
    const s = await stats.gkvPrivateStats(w.auth, period);
    expect(s.gkvEnabled).toBe(true);
    expect(s.batches).toEqual({ count: 2, prescriptions: 3, remedyCents: 7110, copaymentCents: 1712, insurerCents: 5398, withoutRemedy: 1, replaced: { count: 0, remedyCents: 0, copaymentCents: 0, insurerCents: 0 }, insurerNetCents: 5398 });
    expect(s.copayments).toEqual({ count: 1, cents: 1500 });
    expect(s.private).toEqual({ count: 1, cents: 6500 });
    expect(s.deductions.open).toEqual({ count: 1, cents: 700 });
    const month = s.months.find((m) => m.month === today.slice(0, 7))!;
    // Monatsspalte „Absetzungen“ nur Minderung (akzeptiert/erledigt-bleibt) – die offene Absetzung zählt dort nicht (R1-13)
    expect(month).toEqual({ month: today.slice(0, 7), insurerCents: 5398, copaymentCents: 1500, privateCents: 6500, deductionCents: 0 });
    expect(s.deductionSummary).toMatchObject({ pendingCents: 700, reductionCents: 0 });
    // Rechte und Mandanten
    await expect(stats.gkvPrivateStats(w.authWith(["invoices.read"]), period)).rejects.toThrow(/finance.read/);
    const other = await world();
    const so = await stats.gkvPrivateStats(other.auth, period);
    expect([so.batches.count, so.copayments.count, so.private.count, so.deductions.open.count]).toEqual([0, 0, 0, 0]);

    // Belegliste: ZZ mit Storno, Läufe; CSV-Zeilen; Recht invoices.read
    const list = await stats.belegliste(w.auth, period);
    expect(list.receipts.map((r) => [r.kind, r.status])).toEqual(
      expect.arrayContaining([
        ["copayment", "paid"],
        ["copayment", "cancelled"],
        ["storno", expect.any(String)],
      ]),
    );
    const storno = list.receipts.find((r) => r.kind === "storno")!;
    expect(storno.related).toBe(b.number);
    expect(list.receipts.find((r) => r.invoiceId === b.id)!.related).toBe(storno.number);
    expect(list.receipts.find((r) => r.invoiceId === a.id)).toMatchObject({ patient: "Erika Musterfrau", totalCents: 1500, methods: ["transfer"] });
    expect(list.batches).toHaveLength(2);
    expect(list.batches.find((x) => x.remedyCents === 7110)).toMatchObject({ copaymentCents: 1712, insurerCents: 5398, prescriptionCount: 2 });
    expect(list.batches.find((x) => x.remedyCents === null)).toMatchObject({ insurerCents: null, copaymentCents: 500 });
    const rows = stats.beleglisteRows(list);
    expect(rows[0]).toEqual(stats.BELEGLISTE_HEADER);
    expect(rows.filter((r) => r[0] === "Abrechnungslauf")).toHaveLength(2);
    expect(rows.find((r) => r[2] === a.number)![4]).toBe("15,00");
    // Datenminimierung: kein Datum der Verordnung; Lauf lesbar statt UUID; Bezug nicht mit der Notiz gefüllt
    expect(stats.BELEGLISTE_HEADER).not.toContain("Verordnung vom");
    const runs = rows.filter((r) => r[0] === "Abrechnungslauf");
    for (const r of runs) {
      expect(String(r[2])).toMatch(/^Lauf \d+ vom \d{2}\.\d{2}\.\d{4}$/);
      expect(String(r[2])).not.toMatch(/[0-9a-f]{8}-/);
    }
    await expect(stats.belegliste(w.authWith(["finance.read"]), period)).rejects.toThrow(/invoices.read/);
    expect(await stats.belegliste(other.auth, period)).toEqual({ receipts: [], batches: [] });
    // Zeitraum: Vorjahr enthält den alten Lauf, nicht die heutigen
    const prev = await stats.belegliste(w.auth, resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -420), bis: addDaysIso(today, -380) }, today));
    expect(prev.batches).toHaveLength(1);
    expect(prev.receipts).toEqual([]);
  });
  it("Review R1-11/R1-14: Neuabrechnung nicht doppelt gezählt („ersetzt durch Neuabrechnung“, Monat des neuen Laufs); Belegliste gekennzeichnet", async () => {
    const w = await world();
    const run = async (remedy: number, copayment: number, ago: string) =>
      (await w.q<{ id: string }>(`insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, created_at, note) values ($1, 1, $2, $2, $3, now() - $4::interval, 'interne Notiz') returning id`, [w.org, copayment, remedy, ago]))[0].id;
    const old = await run(7110, 1712, "400 days");
    const id = (await w.q<{ id: string }>(
      `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id, remedy_cost_cents, copayment_cents)
       values ($1,$2,$3,'DF',1,'billed',now() - interval '400 days',$4,7110,1712) returning id`,
      [w.org, w.patient, addDaysIso(today, -450), old],
    ))[0].id;
    // Korrektur → Neuabrechnung im heutigen Lauf (Weg wie createBillingBatch, Trigger aktiv)
    const c = (await w.q<{ id: string }>(
      "insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, original_batch_id, original_remedy_cost_cents, original_copayment_cents, created_by) values ($1,$2,$3,'ICD falsch',$4,7110,1712,$5) returning id",
      [w.org, id, w.patient, old, w.user],
    ))[0].id;
    await w.q("update prescriptions set status = 'correction_needed' where id = $1", [id]);
    await w.q("update prescriptions set status = 'billing_ready', remedy_cost_cents = 7500, copayment_cents = 1000 where id = $1", [id]);
    const neu = await run(7500, 1000, "0 days");
    await fx.asOrg(w.org, async (cl) => {
      await cl.query("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, neu]);
      await cl.query("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_by = $2, resolved_batch_id = $3 where id = $1", [c, w.user, neu]);
    });

    // Zeitraum mit beiden Läufen: Kassenanteil nur einmal (neuer Lauf)
    const all = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -420), bis: today }, today));
    expect(all.batches).toMatchObject({ count: 2, remedyCents: 14610, copaymentCents: 2712, insurerCents: 11898, replaced: { count: 1, remedyCents: 7110, copaymentCents: 1712, insurerCents: 5398 }, insurerNetCents: 6500 });
    expect(all.months.reduce((s, m) => s + m.insurerCents, 0)).toBe(6500);
    // nur der Monat des neuen Laufs: Abzug dort (Monatsbezug = Datum des neuen Laufs)
    const month = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "monat" }, today));
    expect(month.batches).toMatchObject({ count: 1, insurerCents: 6500, replaced: { count: 1, insurerCents: 5398 }, insurerNetCents: 1102 });
    expect(month.months.find((m) => m.month === today.slice(0, 7))!.insurerCents).toBe(1102);
    // Vorjahreszeitraum (nur alter Lauf): unverändert, kein Abzug
    const prev = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -420), bis: addDaysIso(today, -380) }, today));
    expect(prev.batches).toMatchObject({ count: 1, insurerCents: 5398, replaced: { count: 0 }, insurerNetCents: 5398 });

    // Belegliste: alter Lauf „später neu abgerechnet“, neuer Lauf „Neuabrechnung“; Bezug ohne Notiz
    const list = await stats.belegliste(w.auth, resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -420), bis: today }, today));
    const bOld = list.batches.find((x) => x.id === old)!;
    const bNew = list.batches.find((x) => x.id === neu)!;
    expect(bOld).toMatchObject({ replacedCount: 1, replacedInsurerCents: 5398, rebillCount: 0 });
    expect(bNew).toMatchObject({ replacedCount: 0, rebillCount: 1 });
    expect(bNew.label).toMatch(/^Lauf \d+ vom /);
    const rows = stats.beleglisteRows(list);
    const bezug = stats.BELEGLISTE_HEADER.indexOf("Bezug");
    const rOld = rows.find((r) => r[2] === bOld.label)!;
    const rNew = rows.find((r) => r[2] === bNew.label)!;
    expect(rOld[bezug]).toMatch(/1 Verordnung später neu abgerechnet/);
    expect(rNew[bezug]).toMatch(/enthält 1 Neuabrechnung/);
    expect(rows.flat().join(" ")).not.toMatch(/interne Notiz/);
  });

  it("Review R1-13: Absetzungen – Minderung nur akzeptiert + erledigt/Absetzung bleibt; offen/Widerspruch und Widerspruch erfolgreich getrennt", async () => {
    const w = await world();
    const billed = (await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at) values ($1,$2,$3,'DF',1,'billed',now()) returning id", [w.org, w.patient, addDaysIso(today, -30)]))[0].id;
    const ded = (cents: number, status: string, outcome: string | null) =>
      w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, amount_cents, reason, deducted_on, created_by, status, outcome) values ($1,$2,$3,$4,'Frist',$5,$6,$7,$8)", [w.org, billed, w.patient, cents, today, w.user, status, outcome]);
    await ded(700, "accepted", null);
    await ded(300, "done", "upheld");
    await ded(200, "done", "reversed");
    await ded(100, "objected", null);
    await ded(50, "open", null);
    const s = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "monat" }, today));
    expect(s.deductionSummary).toEqual({ reductionCents: 1000, reductionCount: 2, pendingCents: 150, pendingCount: 2, reversedCents: 200, reversedCount: 1 });
    expect(s.months.find((m) => m.month === today.slice(0, 7))!.deductionCents).toBe(1000);
  });
});
