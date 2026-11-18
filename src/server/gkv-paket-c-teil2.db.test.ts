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
import { fixtures, insertLegacy, TEST_DB } from "./__tests__/db-fixtures";

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
    /**
     * Lauf rückdatieren: den Anlagezeitpunkt setzt sonst der Server (Trigger billing_batches_guard, Migration 0066) – als
     * Owner mit abgeschalteten Triggern (insertLegacy); ohne Superuser `false` (Test überspringen)
     */
    const backdate = (id: string, ago: string) => insertLegacy("update billing_batches set created_at = now() - $2::interval where id = $1", [id, ago]);
    /**
     * Neuer Lauf mit seinen abgerechneten Verordnungen in EINER Transaktion: Anzahl/Summen werden beim Commit gegen die
     * Verordnungen geprüft (Migration 0067); fehlende Beträge zählen 0
     */
    const run = (vos: { remedy: number | null; copay: number | null }[], o: { created?: string } = {}) =>
      fx.asOrg(org, async (c) => {
        const copay = vos.reduce((s, v) => s + (v.copay ?? 0), 0);
        const remedy = vos.reduce((s, v) => s + (v.remedy ?? 0), 0);
        const b = (
          await c.query(
            "insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, created_at) values ($1,$2,$3,$3,$4,coalesce($5::timestamptz, now())) returning id",
            [org, vos.length, copay, remedy, o.created ?? null],
          )
        ).rows[0].id as string;
        for (const v of vos)
          await c.query(
            "insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id, remedy_cost_cents, copayment_cents) values ($1,$2,$3,'DF',1,'billed',now(),$4,$5,$6)",
            [org, patient, addDaysIso(today, -40), b, v.remedy, v.copay],
          );
        return b;
      });
    /**
     * Alter Lauf mit einer darin abgerechneten Verordnung (Heilmittelkosten 71,10 €, Zuzahlung 17,12 €): Lauf und
     * Verordnung in EINER Transaktion (INSERT mit Lauf nur in einen eben angelegten Lauf, 0066), danach rückdatiert
     */
    const oldRun = async (remedy: number | null, note: string | null = null) => {
      const r = await fx.asOrg(org, async (c) => {
        // Summen passend zur Verordnung (Prüfung beim Commit, 0067); Altlauf ohne Heilmittelkosten: remedy_total_cents
        // danach als Altbestand geleert (mit dem Rückdatieren)
        const old = (await c.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, note) values ($1, 1, 1712, 1712, 7110, $2) returning id", [org, note])).rows[0].id as string;
        const id = (
          await c.query(
            `insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at, billing_batch_id, remedy_cost_cents, copayment_cents)
             values ($1,$2,$3,'DF',1,'billed',now() - interval '400 days',$4,7110,1712) returning id`,
            [org, patient, addDaysIso(today, -450), old],
          )
        ).rows[0].id as string;
        return { old, id };
      });
      const ok = await insertLegacy("update billing_batches set created_at = now() - interval '400 days', remedy_total_cents = $2 where id = $1", [r.old, remedy]);
      return ok ? r : null;
    };
    return { org, user, patient, auth, authWith, q, vo, backdate, run, oldRun };
  };

  it("Kasse vs. privat: Kassenanteil laut Lauf, ZZ getrennt (ohne Storno), Privat ohne Entwürfe/ZZ, Absetzungen; Zeitraum; fremde Praxis leer", async (ctx) => {
    const w = await world();
    // Abrechnungslauf heute: Heilmittelkosten 71,10 €, Zuzahlungen 17,12 € → Kassenanteil 53,98 €; alter Lauf ohne Heilmittelkosten
    await w.run([
      { remedy: 7110, copay: 1712 },
      { remedy: null, copay: null },
    ]);
    // Altlauf vor Paket A (nur total_cents, keine Heilmittelkosten/Zuzahlungssumme) – heute nicht mehr anlegbar (0067)
    if (!(await insertLegacy("insert into billing_batches (organization_id, prescription_count, total_cents) values ($1, 1, 500)", [w.org]))) ctx.skip();
    const lastYear = await w.run([{ remedy: 1000, copay: 100 }]);
    if (!(await w.backdate(lastYear, "400 days"))) ctx.skip();
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
  it("Review R1-11/R1-14: Neuabrechnung nicht doppelt gezählt („ersetzt durch Neuabrechnung“, Monat des neuen Laufs); Belegliste gekennzeichnet", async (ctx) => {
    const w = await world();
    const r = await w.oldRun(7110, "interne Notiz");
    if (!r) ctx.skip();
    const { old, id } = r!;
    // Korrektur → Neuabrechnung im heutigen Lauf (Weg wie createBillingBatch, Trigger aktiv)
    const c = (await w.q<{ id: string }>(
      "insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, original_batch_id, original_remedy_cost_cents, original_copayment_cents, created_by) values ($1,$2,$3,'ICD falsch',$4,7110,1712,$5) returning id",
      [w.org, id, w.patient, old, w.user],
    ))[0].id;
    await w.q("update prescriptions set status = 'correction_needed' where id = $1", [id]);
    await w.q("update prescriptions set status = 'billing_ready', remedy_cost_cents = 7500, copayment_cents = 1000 where id = $1", [id]);
    // Weg wie createBillingBatch: Lauf anlegen, abrechnen und Vermerk abschließen in EINER Transaktion (Trigger, AppSec Runde 3)
    const neu = await fx.asOrg(w.org, async (cl) => {
      const neu = (await cl.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents, note) values ($1, 1, 1000, 1000, 7500, 'interne Notiz') returning id", [w.org])).rows[0].id as string;
      await cl.query("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, neu]);
      await cl.query("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_by = $2, resolved_batch_id = $3 where id = $1", [c, w.user, neu]);
      return neu;
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
    expect(s.deductionSummary).toEqual({ reductionCents: 1000, reductionCount: 2, pendingCents: 150, pendingCount: 2, reversedCents: 200, reversedCount: 1, replacedCents: 0, replacedCount: 0 });
    expect(s.months.find((m) => m.month === today.slice(0, 7))!.deductionCents).toBe(1000);
  });

  describe("Review-Runde 2", () => {
    /** abgerechnete Verordnung im (rückdatierten) Lauf, Korrektur, Neuabrechnung im heutigen Lauf – Trigger aktiv */
    const rebilledWorld = async (ctx: { skip: () => void }, o: { oldRemedy?: number | null; deduction?: { cents: number; status: string; outcome: string | null } } = {}) => {
      const w = await world();
      const oldRemedy = o.oldRemedy === undefined ? 7110 : o.oldRemedy;
      const r = await w.oldRun(oldRemedy);
      if (!r) ctx.skip();
      const { old, id } = r!;
      let deductionId: string | null = null;
      if (o.deduction) {
        deductionId = (await w.q<{ id: string }>(
          "insert into gkv_deductions (organization_id, prescription_id, patient_id, amount_cents, reason, deducted_on, created_by, status, outcome) values ($1,$2,$3,$4,'Frist',$5,$6,$7,$8) returning id",
          [w.org, id, w.patient, o.deduction.cents, today, w.user, o.deduction.status, o.deduction.outcome],
        ))[0].id;
      }
      const c = (await w.q<{ id: string }>("insert into prescription_corrections (organization_id, prescription_id, patient_id, reason, deduction_id, created_by) values ($1,$2,$3,'ICD falsch',$4,$5) returning id", [w.org, id, w.patient, deductionId, w.user]))[0].id;
      await w.q("update prescriptions set status = 'correction_needed' where id = $1", [id]);
      await w.q("update prescriptions set status = 'billing_ready', remedy_cost_cents = 7500, copayment_cents = 1000 where id = $1", [id]);
      const neu = await fx.asOrg(w.org, async (cl) => {
        const neu = (await cl.query("insert into billing_batches (organization_id, prescription_count, total_cents, copayment_total_cents, remedy_total_cents) values ($1, 1, 1000, 1000, 7500) returning id", [w.org])).rows[0].id as string;
        await cl.query("update prescriptions set status = 'billed', billed_at = now(), billing_batch_id = $2 where id = $1", [id, neu]);
        await cl.query("update prescription_corrections set resolution = 'rebilled', resolved_at = now(), resolved_by = $2, resolved_batch_id = $3 where id = $1", [c, w.user, neu]);
        return neu;
      });
      return { ...w, id, old, neu, correction: c };
    };
    const wide = () => resolvePeriod({ zeitraum: "frei", von: addDaysIso(today, -420), bis: today }, today);

    it("N1: Absetzung, die an einer Neuabrechnung hängt, ist keine Minderung, sondern „durch Neuabrechnung ersetzt“", async (ctx) => {
      const w = await rebilledWorld(ctx, { deduction: { cents: 3555, status: "accepted", outcome: null } });
      // weitere, normale Absetzung (Minderung) an einer anderen Verordnung
      const other = (await w.q<{ id: string }>("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units, status, billed_at) values ($1,$2,$3,'DF',1,'billed',now()) returning id", [w.org, w.patient, addDaysIso(today, -30)]))[0].id;
      await w.q("insert into gkv_deductions (organization_id, prescription_id, patient_id, amount_cents, reason, deducted_on, created_by, status) values ($1,$2,$3,700,'Frist',$4,$5,'accepted')", [w.org, other, w.patient, today, w.user]);
      const s = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "monat" }, today));
      expect(s.deductionSummary).toMatchObject({ reductionCents: 700, reductionCount: 1, replacedCents: 3555, replacedCount: 1, pendingCents: 0, reversedCents: 0 });
      expect(s.months.find((m) => m.month === today.slice(0, 7))!.deductionCents).toBe(700);
      expect(stats.deductionKind("accepted", null, true)).toBe("replaced");
      expect(stats.deductionKind("done", "upheld", false)).toBe("reduction");
    });

    it("H-5: „ersetzt“ in Auswertung und Belegliste mit derselben Bedingung und Quelle wie der Export des alten Laufs", async (ctx) => {
      // alter Lauf ohne gespeicherte Heilmittelkosten → weder Auswertung noch Belegliste ziehen etwas ab
      const a = await rebilledWorld(ctx, { oldRemedy: null });
      const sa = await stats.gkvPrivateStats(a.auth, wide());
      const la = await stats.belegliste(a.auth, wide());
      expect(sa.batches.replaced).toEqual({ count: 0, remedyCents: 0, copaymentCents: 0, insurerCents: 0 });
      expect(la.batches.find((x) => x.id === a.old)).toMatchObject({ replacedCount: 0, replacedInsurerCents: 0 });
      // mit Heilmittelkosten: Auswertung = Belegliste = Stand der Erstabrechnung (original_row, wie CSV/§ 302 des alten Laufs)
      const b = await rebilledWorld(ctx);
      const sb = await stats.gkvPrivateStats(b.auth, wide());
      const lb = await stats.belegliste(b.auth, wide());
      const [orig] = await b.q<{ remedy: number; copay: number }>("select (original_row->>'remedy_cost_cents')::int as remedy, (original_row->>'copayment_cents')::int as copay from prescription_corrections where id = $1", [b.correction]);
      expect(sb.batches.replaced).toEqual({ count: 1, remedyCents: orig.remedy, copaymentCents: orig.copay, insurerCents: orig.remedy - orig.copay });
      expect(lb.batches.find((x) => x.id === b.old)).toMatchObject({ replacedCount: 1, replacedInsurerCents: sb.batches.replaced.insurerCents });
    });

    it("H-5: Laufnummer stabil – Läufe nicht löschbar, Anlagezeitpunkt vom Server (kein Einschieben vor bestehende Läufe)", async () => {
      const w = await world();
      const mk = () => w.run([{ remedy: null, copay: null }]);
      const first = await mk();
      const second = await mk();
      const labels = async () => new Map((await stats.belegliste(w.auth, resolvePeriod({ zeitraum: "monat" }, today))).batches.map((b) => [b.id, b.label.split(" vom ")[0]]));
      expect([...(await labels()).entries()]).toEqual([[first, "Lauf 1"], [second, "Lauf 2"]]);
      await expect(w.q("delete from billing_batches where id = $1", [first])).rejects.toThrow(/nicht gelöscht/);
      // rückdatiertes Anlegen durch die Anwendung wirkt nicht: der neue Lauf bekommt die nächste Nummer
      const third = await w.run([{ remedy: null, copay: null }], { created: new Date(Date.now() - 86_400_000).toISOString() });
      expect([...(await labels()).entries()]).toEqual([[first, "Lauf 1"], [second, "Lauf 2"], [third, "Lauf 3"]]);
    });

    it("Runde 4: Absetzung an Neuabrechnung eines Altlaufs ohne Heilmittelkosten bleibt Minderung (gleiche Bedingung wie „ersetzt“)", async (ctx) => {
      const w = await rebilledWorld(ctx, { oldRemedy: null, deduction: { cents: 3555, status: "accepted", outcome: null } });
      const s = await stats.gkvPrivateStats(w.auth, resolvePeriod({ zeitraum: "monat" }, today));
      expect(s.batches.replaced.count).toBe(0);
      expect(s.deductionSummary).toMatchObject({ reductionCents: 3555, reductionCount: 1, replacedCents: 0, replacedCount: 0 });
    });

    it("Runde 3: Belegliste – Hinweis „Neuabrechnung noch nicht übergeben“, solange der Lauf der Neuabrechnung nicht exportiert ist", async (ctx) => {
      const w = await rebilledWorld(ctx);
      const note = async () => stats.batchCorrectionNote((await stats.belegliste(w.auth, wide())).batches.find((x) => x.id === w.neu)!);
      expect(await note()).toMatch(/enthält 1 Neuabrechnung nach Korrektur – noch nicht übergeben/);
      await w.q("update billing_batches set exported_at = now(), status = 'exported' where id = $1", [w.neu]);
      expect(await note()).toBe("enthält 1 Neuabrechnung nach Korrektur");
    });
  });
});
