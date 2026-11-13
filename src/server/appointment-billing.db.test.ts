/**
 * Termin verschieben, Rechnung aus dem Termin, Anzahlungs-Quittung und Sammelrechnung zum Jahresende (DB, erfundene Daten).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Termin → Rechnung/Quittung → Sammelrechnung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let billing: typeof import("./appointment-billing");
  let invoices: typeof import("./invoices");
  let appts: typeof import("./appointments");
  let today: string;
  let year: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    billing = await import("./appointment-billing");
    invoices = await import("./invoices");
    appts = await import("./appointments");
    const { berlinDateIso } = await import("@/lib/format");
    today = berlinDateIso();
    year = Number(today.slice(0, 4));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  /** Vorlage aus Termin/Behandlung (mit Patient:in) */
  async function source(auth: never, src: { appointmentId?: string; recordId?: string }) {
    const r = await billing.billingFromSource(auth, src);
    if (!r?.patient) throw new Error("keine Vorlage");
    return r;
  }

  async function setup() {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const auth = { organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true } as never;
    const service = await f.asOrg(org, async (c) =>
      (await c.query("insert into services (organization_id, code, name, price_cents, vat_rate) values ($1,'PKB','Podologische Komplexbehandlung',4500,0) returning id", [org])).rows[0].id as string,
    );
    /** Termin (Vergangenheit dieses Jahres) mit Leistung */
    const appointment = async (patientId: string | null, startsAt: string, opts: { source?: string; status?: string; withService?: boolean; minutes?: number } = {}) =>
      f.asOrg(org, async (c) => {
        const id = (
          await c.query(
            `insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, source, status, title)
             values ($1,$2,$3,$4::timestamptz,$4::timestamptz + make_interval(mins => $5),$6,$7,'Behandlung') returning id`,
            [org, patientId, user, startsAt, opts.minutes ?? 45, opts.source ?? "manual", opts.status ?? "done"],
          )
        ).rows[0].id as string;
        if (opts.withService !== false) await c.query("insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)", [org, id, service]);
        return id;
      });
    return { org, user, auth, service, appointment };
  }

  it("Rechnung aus dem Termin: Leistungen vorausgefüllt, weitere Positionen möglich, keine Doppelabrechnung", async () => {
    const { org, user, auth, appointment } = await setup();
    const patient = await f.patient(org, { lastName: "Termin", firstName: "Tina" });
    const a1 = await appointment(patient, `${year}-02-03 10:00+01`);

    const src = await source(auth, { appointmentId: a1 });
    expect(src.patient.id).toBe(patient);
    expect(src!.lines).toEqual([expect.objectContaining({ appointmentId: a1, treatmentRecordId: null, unitPriceCents: 4500, description: `03.02.${year}: Podologische Komplexbehandlung` })]);
    expect(src!.prescription).toBe(false);

    const base = { kind: "invoice" as const, patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [] };
    const lines = [
      { ...src!.lines[0], factor: 1, unitPriceCents: src!.lines[0].unitPriceCents ?? 0 },
      { serviceId: null, treatmentRecordId: null, description: "Pflegecreme", quantity: 1, factor: 1, unitPriceCents: 1290, vatRate: 19 },
    ];
    const inv = await invoices.createInvoice(auth, { ...base, lines });
    expect(inv.totalCents).toBe(4500 + 1290);
    expect((await source(auth, { appointmentId: a1 })).billedBy.map((d) => d.number)).toEqual([inv.number]);
    await expect(invoices.createInvoice(auth, { ...base, lines: [lines[0]] })).rejects.toThrow(/Termin vom .* bereits in Rechnung/);

    // Termin mit Doku-Eintrag: Abrechnung über den Doku-Eintrag sperrt auch den Termin (und umgekehrt)
    const a2 = await appointment(patient, `${year}-02-10 10:00+01`);
    const rec = await f.asOrg(org, async (c) =>
      (await c.query("insert into treatment_records (organization_id, patient_id, author_id, appointment_id, treated_at, hash) values ($1,$2,$3,$4,$5,'h') returning id", [org, patient, user, a2, `${year}-02-10 10:05+01`])).rows[0].id as string,
    );
    const fromRec = await source(auth, { recordId: rec });
    expect(fromRec!.lines[0]).toMatchObject({ appointmentId: a2, treatmentRecordId: rec });
    await invoices.createInvoice(auth, { ...base, lines: [{ serviceId: null, treatmentRecordId: rec, description: "Behandlung", quantity: 1, factor: 1, unitPriceCents: 4500, vatRate: 0 }] });
    await expect(
      invoices.createInvoice(auth, { ...base, lines: [{ serviceId: null, treatmentRecordId: null, appointmentId: a2, description: "Behandlung", quantity: 1, factor: 1, unitPriceCents: 4500, vatRate: 0 }] }),
    ).rejects.toThrow(/bereits in Rechnung/);

    // Termin einer anderen Person
    const other = await f.patient(org, { lastName: "Andere" });
    await expect(invoices.createInvoice(auth, { ...base, patientId: other, lines: [{ ...lines[0], appointmentId: a1 }] })).rejects.toThrow(/gehört nicht/);
  });

  it("Quittung (Anzahlung) → Sammelrechnung zum Jahresende rechnet sie an; Storno gibt sie wieder frei", async () => {
    const { org, auth, appointment } = await setup();
    const patient = await f.patient(org, { lastName: "Sammel", firstName: "Sabine" });
    const a1 = await appointment(patient, `${year}-03-12 09:00+01`);
    const a2 = await appointment(patient, `${year}-06-02 09:00+02`);

    const dep = await invoices.createDeposit(auth, {
      patientId: patient,
      appointmentId: a1,
      treatmentRecordId: null,
      description: `Anzahlung auf die Sammelrechnung ${year}: Behandlung am 12.03.${year}`,
      amountCents: 4500,
      vatRate: 0,
      method: "cash",
      notes: null,
    });
    expect(dep.number).toMatch(new RegExp(`^AZ${year}-\\d{4}$`));
    expect(dep.status).toBe("paid");
    // Bar läuft über die Kasse/TSE: Zahlung mit Signatur
    const fiscal = await f.asOrg(org, async (c) =>
      (await c.query("select count(*)::int as n from fiscal_transactions ft join payments p on p.id = ft.payment_id where p.invoice_id = $1", [dep.id])).rows[0].n,
    );
    expect(fiscal).toBe(1);
    const kasse = await (await import("./kasse")).kasseOverview(auth);
    expect(kasse.open.payments).toEqual([expect.objectContaining({ invoiceNumber: dep.number, method: "cash", amountCents: 4500, deposit: true })]);
    expect(kasse.calc.cashPaymentsCents).toBe(4500);
    expect(kasse.calc.totals.businessCases.map((b) => b.gvTyp)).toContain("AnzahlungEinstellung");
    expect(kasse.calc.totals.businessCases.map((b) => b.gvTyp)).not.toContain("Umsatz");
    // Formular: Quittung mit Leistung und Termin-Bezug (Auswahl in der Sammelrechnung)
    const form = await invoices.invoiceFormData(auth, patient);
    expect(form.openDeposits).toEqual([
      expect.objectContaining({ id: dep.id, patientId: patient, totalCents: 4500, vatRate: 0, appointmentId: a1, treatmentRecordId: null, description: expect.stringMatching(/Behandlung am 12\.03\./) }),
    ]);
    // Anzahlung rechnet die Leistung nicht ab
    expect((await source(auth, { appointmentId: a1 })).billedBy).toEqual([]);

    const overview = await billing.collectiveOverview(auth, year);
    expect(overview).toEqual([expect.objectContaining({ patientId: patient, items: 2, depositCount: 1, depositCents: 4500, estimateCents: 9000 })]);

    const sug = await billing.patientYearSuggestion(auth, patient, year);
    expect(sug!.lines.map((l) => l.appointmentId)).toEqual([a1, a2]);
    expect(sug!.deposits.map((d) => d.id)).toEqual([dep.id]);

    const lines = sug!.lines.map((l) => ({ ...l, factor: 1, unitPriceCents: l.unitPriceCents ?? 0 }));
    const base = { kind: "collective" as const, patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [] };
    const sr = await invoices.createInvoice(auth, { ...base, lines, depositIds: [dep.id] });
    expect(sr.number).toMatch(/^SR/);
    expect(sr).toMatchObject({ totalCents: 9000, paidCents: 4500, status: "partially_paid", depositCents: 4500 });
    const bundle = await invoices.getInvoice(auth, sr.id);
    expect(bundle!.deposits.map((d) => d.number)).toEqual([dep.number]);
    // kein zweiter Zahlungseingang auf der Sammelrechnung (das Geld kam mit der Quittung)
    expect(bundle!.payments).toEqual([]);
    expect((await (await import("./kasse")).kasseOverview(auth)).calc.cashPaymentsCents).toBe(4500);
    expect((await invoices.getInvoice(auth, dep.id))!.creditedTo?.id).toBe(sr.id);
    expect(await billing.collectiveOverview(auth, year)).toEqual([]);

    // nicht doppelt anrechnen, nicht stornieren solange angerechnet
    await expect(invoices.createInvoice(auth, { ...base, lines: [{ ...lines[0], appointmentId: null }], depositIds: [dep.id] })).rejects.toThrow(/bereits auf eine andere Rechnung/);
    await expect(invoices.cancelInvoice(auth, dep.id, "x")).rejects.toThrow(/zuerst diese Rechnung stornieren/);

    // DB-Sicherung: Anrechnung nur für Anzahlungen derselben Person
    const other = await f.patient(org, { lastName: "Fremd" });
    const foreign = await f.invoice(org, other);
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = null where id = $1", [dep.id]))).rejects.toThrow(/bereits auf eine Rechnung angerechnet/);
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = $2 where id = $1", [foreign, sr.id]))).rejects.toThrow(/Nur Anzahlungen/);

    // Storno der Sammelrechnung: Anzahlung wird frei, nur echte Zahlungen wären zu erstatten
    const credit = await invoices.cancelInvoice(auth, sr.id, "neu ausstellen");
    expect(credit.refundCents).toBe(0);
    const cn = await invoices.getInvoice(auth, credit.id);
    // Gutschrift vollständig verrechnet: die Anzahlung bleibt als Quittung bestehen und wird neu angerechnet
    expect(cn!.invoice).toMatchObject({ totalCents: -9000, paidCents: -9000, status: "paid" });
    expect((await invoices.getInvoice(auth, dep.id))!.invoice.collectiveInvoiceId).toBeNull();
    expect(await billing.collectiveOverview(auth, year)).toEqual([expect.objectContaining({ patientId: patient, items: 2, depositCount: 1 })]);
    // erneut anrechnen (neue Sammelrechnung)
    const sr2 = await invoices.createInvoice(auth, { ...base, lines, depositIds: [dep.id] });
    expect(sr2.paidCents).toBe(4500);
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = $2 where id = $1", [dep.id, foreign]))).rejects.toThrow(/bereits auf eine Rechnung angerechnet/);
  });

  it("Erinnerung: Altbestand mit Rechnung am selben Tag zählt als abgerechnet, Verordnungen und Pflegeheim-Abrechnung fehlen", async () => {
    const { org, user, auth, appointment } = await setup();
    const p1 = await f.patient(org, { lastName: "Alt" });
    await appointment(p1, `${today} 00:05+01`, { status: "done" });
    const inv = await f.invoice(org, p1);
    expect(inv).toBeTruthy();
    // Termin heute früh + eigene Rechnung heute → abgerechnet (Heuristik)
    const rows = await billing.collectiveOverview(auth, year);
    expect(rows.find((r) => r.patientId === p1)).toBeUndefined();

    const p2 = await f.patient(org, { lastName: "Kasse" });
    await f.asOrg(org, async (c) => {
      const pr = (await c.query("insert into prescriptions (organization_id, patient_id, issued_at, diagnosis_group, units) values ($1,$2,$3,'DF',6) returning id", [org, p2, `${year}-03-01`])).rows[0].id;
      await c.query("insert into treatment_records (organization_id, patient_id, author_id, prescription_id, treated_at, hash) values ($1,$2,$3,$4,$5,'h')", [org, p2, user, pr, `${year}-04-01 10:00+02`]);
    });
    expect((await billing.collectiveOverview(auth, year)).find((r) => r.patientId === p2)).toBeUndefined();

    const home = await f.asOrg(org, async (c) => (await c.query("insert into billing_contacts (organization_id, kind, name) values ($1,'care_home','Haus Linde') returning id", [org])).rows[0].id as string);
    const p3 = await f.patient(org, { lastName: "Heim" });
    await f.asOrg(org, (c) => c.query("update patients set care_home_id = $2, billing_contact_id = $2 where id = $1", [p3, home]));
    await appointment(p3, `${year}-05-05 10:00+02`);
    expect((await billing.collectiveOverview(auth, year)).find((r) => r.patientId === p3)).toBeUndefined();
    // abgesagte und künftige Termine zählen nicht
    const p4 = await f.patient(org, { lastName: "Zukunft" });
    await appointment(p4, `${year}-01-20 10:00+01`, { status: "cancelled" });
    await appointment(p4, `${year + 1}-01-20 10:00+01`);
    expect((await billing.collectiveOverview(auth, year)).find((r) => r.patientId === p4)).toBeUndefined();
  });

  it("Termin verschieben: manuell ja (mit Überschneidungsprüfung), Doctolib/Kalender-Abo nein", async () => {
    const { org, user, auth, appointment } = await setup();
    const patient = await f.patient(org, { lastName: "Verschieb" });
    const a = await appointment(patient, `${year + 1}-03-02 09:00+01`, { status: "planned" });
    const blocker = await appointment(null, `${year + 1}-03-03 11:00+01`, { status: "planned", withService: false });
    expect(blocker).toBeTruthy();
    const { berlinToUtc } = await import("@/lib/format");

    const clash = await appts.rescheduleAppointment(auth, a, { startsAt: berlinToUtc(`${year + 1}-03-03`, "11:15"), durationMin: 30, therapistId: user, allowConflict: false });
    expect(clash).toMatchObject({ ok: false, conflict: true });
    expect(await appts.rescheduleAppointment(auth, a, { startsAt: berlinToUtc(`${year + 1}-03-03`, "14:00"), durationMin: 60, therapistId: user, allowConflict: false })).toEqual({ ok: true });
    const moved = await appts.getAppointment(auth, a);
    expect(moved!.appointment.startsAt.toISOString()).toBe(berlinToUtc(`${year + 1}-03-03`, "14:00").toISOString());
    expect(moved!.appointment.endsAt.getTime() - moved!.appointment.startsAt.getTime()).toBe(60 * 60_000);
    expect(moved!.lock).toBeNull();
    // bewusste Doppelbelegung nach Bestätigung
    expect(await appts.rescheduleAppointment(auth, a, { startsAt: berlinToUtc(`${year + 1}-03-03`, "11:00"), durationMin: 30, therapistId: user, allowConflict: true })).toEqual({ ok: true });

    const doc = await appointment(patient, `${year + 1}-03-04 09:00+01`, { source: "doctolib", status: "planned" });
    const ext = await appointment(patient, `${year + 1}-03-05 09:00+01`, { source: "extern", status: "planned" });
    const at = berlinToUtc(`${year + 1}-03-06`, "09:00");
    expect(await appts.rescheduleAppointment(auth, doc, { startsAt: at, durationMin: 30, therapistId: user, allowConflict: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Doctolib/) });
    expect(await appts.rescheduleAppointment(auth, ext, { startsAt: at, durationMin: 30, therapistId: user, allowConflict: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Kalender-Abo/) });
    expect((await appts.getAppointment(auth, doc))!.lock?.reason).toBe("doctolib");
    // unbekannte Behandler:in
    expect(await appts.rescheduleAppointment(auth, a, { startsAt: at, durationMin: 30, therapistId: "00000000-0000-4000-8000-000000000000", allowConflict: false })).toMatchObject({ ok: false });
    // Empfang/Azubi haben keinen eigenen Kalender (und belegen keinen Platz) → nicht als Behandler:in wählbar
    for (const role of ["reception", "trainee"]) {
      const staff = await f.user();
      await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,$3)", [org, staff, role]);
      expect(await appts.rescheduleAppointment(auth, a, { startsAt: at, durationMin: 30, therapistId: staff, allowConflict: false })).toMatchObject({ ok: false, error: expect.stringMatching(/nicht gefunden/) });
      expect((await appts.therapists(auth)).map((t) => t.id)).not.toContain(staff);
    }
    expect((await appts.therapists(auth)).map((t) => t.id)).toContain(user);
  });
});
