/**
 * Doppel-Schutz: dieselbe Behandlung nicht zweimal quittieren/abrechnen (DB, erfundene Daten).
 * Hart: Positionen mit Termin-/Doku-Bezug und offene Anzahlungen. Weich: gleiche Leistung, gleiche Person, gleicher Tag.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Doppelt quittieren verhindern (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let today: string;
  let year: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    invoices = await import("./invoices");
    const fmt = await import("@/lib/format");
    today = fmt.berlinDateIso();
    year = Number(today.slice(0, 4)) - 1;
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function setup() {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const auth = { organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true } as never;
    const service = await f.asOrg(org, async (c) =>
      (await c.query("insert into services (organization_id, code, name, price_cents, vat_rate) values ($1,'PKB','Podologische Komplexbehandlung',4500,0) returning id", [org])).rows[0].id as string,
    );
    const patient = await f.patient(org, { lastName: "Doppelt" });
    const appointment = async (startsAt: string) =>
      f.asOrg(org, async (c) =>
        (
          await c.query(
            `insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, source, status, title)
             values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '45 minutes','manual','done','Behandlung') returning id`,
            [org, patient, user, startsAt],
          )
        ).rows[0].id as string,
      );
    const line = (p: { appointmentId?: string | null; serviceId?: string | null } = {}) => ({
      serviceId: p.serviceId ?? null,
      treatmentRecordId: null,
      appointmentId: p.appointmentId ?? null,
      description: "Behandlung",
      quantity: 1,
      factor: 1,
      unitPriceCents: 4500,
      vatRate: 0,
    });
    const doc = (kind: "receipt" | "invoice", lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) =>
      invoices.createInvoice(auth, {
        kind,
        patientId: patient,
        billingContactId: null,
        issuedAt: today,
        dueDays: 14,
        therapeuticConfirmed: true,
        notes: null,
        lines,
        payments: kind === "receipt" ? [{ method: "cash", amountCents: 4500 * lines.length }] : [],
        ...extra,
      });
    const deposit = (appointmentId: string) =>
      invoices.createDeposit(auth, { patientId: patient, appointmentId, treatmentRecordId: null, description: "Anzahlung auf die Sammelrechnung: Behandlung", amountCents: 4500, vatRate: 0, method: "cash", notes: null });
    /** Termin erst in die Zukunft legen (Anzahlung = Vorauszahlung), dann auf den Behandlungstag verschieben */
    const moveTo = (id: string, startsAt: string) =>
      f.asOrg(org, (c) => c.query("update appointments set starts_at = $2::timestamptz, ends_at = $2::timestamptz + interval '45 minutes' where id = $1", [id, startsAt]));
    return { org, auth, service, patient, appointment, line, doc, deposit, moveTo };
  }

  it("Termin schon quittiert: zweite Quittung/Rechnung/Anzahlung abgelehnt, mit Belegart und Nummer", async () => {
    const { appointment, line, doc, deposit } = await setup();
    const a1 = await appointment(`${year}-04-07 10:00+02`);
    const q = await doc("receipt", [line({ appointmentId: a1 })]);
    const msg = new RegExp(`Für die Behandlung vom 07\\.04\\.${year} wurde bereits die Quittung ${q.number} erstellt\\.`);
    await expect(doc("receipt", [line({ appointmentId: a1 })])).rejects.toThrow(msg);
    await expect(doc("invoice", [line({ appointmentId: a1 })])).rejects.toThrow(msg);
    await expect(deposit(a1)).rejects.toThrow(msg);
  });

  it("offene Anzahlung: keine zweite, Quittung/Rechnung nur mit Anrechnung", async () => {
    const { appointment, line, doc, deposit, moveTo } = await setup();
    const a2 = await appointment(`${year + 2}-05-12 10:00+02`);
    const az = await deposit(a2);
    // Anzahlung vor der Behandlung; danach findet der Termin statt (Vergangenheit) – die Anzahlung bleibt anrechenbar
    await moveTo(a2, `${year}-05-12 10:00+02`);
    await expect(deposit(a2)).rejects.toThrow(new RegExp(`bereits die Anzahlung ${az.number} – bitte anrechnen`));
    // Quittung kann keine Anzahlung anrechnen → Hinweis, zuerst anzurechnen oder zu stornieren
    await expect(doc("receipt", [line({ appointmentId: a2 })])).rejects.toThrow(new RegExp(`offene Anzahlung ${az.number}\\. Bitte zuerst auf eine Rechnung`));
    await expect(doc("invoice", [line({ appointmentId: a2 })])).rejects.toThrow(/bitte anrechnen/);
    // Sackgasse: Ausfallhonorar kann die Anzahlung nicht anrechnen → Hinweis mit Link auf die Anzahlung
    const dead = await doc("invoice", [line({ appointmentId: a2 })], { kind: "no_show_fee" }).catch((e) => e);
    expect(dead).toBeInstanceOf(invoices.OpenDepositError);
    expect(dead.message).toBe(`Für die Behandlung vom 12.05.${year} gibt es die offene Anzahlung ${az.number}. Bitte zuerst auf eine Rechnung der Person anrechnen oder die Anzahlung stornieren.`);
    expect(dead.deposit).toMatchObject({ id: az.id, number: az.number });
    const inv = await doc("invoice", [line({ appointmentId: a2 })], { depositIds: [az.id] });
    expect(inv).toMatchObject({ status: "paid", depositCents: 4500 });
    // danach ist die Behandlung abgerechnet
    await expect(deposit(a2)).rejects.toThrow(new RegExp(`bereits die Rechnung ${inv.number} erstellt`));
  });

  it("Anzahlung nur vor der Behandlung: Termin heute/vergangen oder Doku-Eintrag → Quittung erstellen", async () => {
    const { org, auth, patient, appointment, deposit } = await setup();
    const msg = "Für erbrachte Behandlungen bitte eine Quittung erstellen.";
    await expect(deposit(await appointment(`${year}-03-03 10:00+01`))).rejects.toThrow(msg);
    // heute (auch später am Tag) zählt nicht als künftig
    const todayLate = await appointment(`${today} 23:30 Europe/Berlin`);
    await expect(deposit(todayLate)).rejects.toThrow(msg);
    // dokumentierte Behandlung (auch ohne Termin)
    const user = await f.user();
    const rec = await f.asOrg(org, async (c) =>
      (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3,now(),'h') returning id", [org, patient, user])).rows[0].id as string,
    );
    await expect(
      invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: rec, description: "Anzahlung: Behandlung", amountCents: 1000, vatRate: 0, method: "cash", notes: null }),
    ).rejects.toThrow(msg);
    // morgen bzw. ohne Termin (z. B. Nagelspange): erlaubt
    const tomorrow = await appointment(new Date(Date.now() + 36 * 3600_000).toISOString());
    await expect(deposit(tomorrow)).resolves.toMatchObject({ status: "paid" });
    await expect(
      invoices.createDeposit(auth, { patientId: patient, appointmentId: null, treatmentRecordId: null, description: "Anzahlung: Nagelspange", amountCents: 3000, vatRate: 0, method: "transfer", notes: null }),
    ).resolves.toMatchObject({ status: "paid", totalCents: 3000 });
  });

  it("gleiche Leistung ohne Terminbezug am selben Tag: Hinweis mit Beleg, nur mit Bestätigung (protokolliert)", async () => {
    const { org, service, line, doc } = await setup();
    const first = await doc("receipt", [line({ serviceId: service })]);
    const err = await doc("receipt", [line({ serviceId: service })]).catch((e) => e);
    expect(err).toBeInstanceOf(invoices.DuplicateInvoiceError);
    expect(err.message).toMatch(new RegExp(`„Podologische Komplexbehandlung“ wurde .* bereits abgerechnet \\(Quittung ${first.number}\\)`));
    expect(err.duplicate).toEqual({ id: first.id, number: first.number });
    // Freitext ohne Leistung und andere Leistung: kein Hinweis
    await expect(doc("receipt", [line()])).resolves.toMatchObject({ status: "paid" });
    // Bestätigung gilt nur für genau den angezeigten Beleg
    await expect(doc("receipt", [line({ serviceId: service })], { duplicateAck: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(invoices.DuplicateInvoiceError);
    const second = await doc("receipt", [line({ serviceId: service })], { duplicateAck: first.id });
    expect(second.duplicateOf).toEqual({ id: first.id, number: first.number });
    const logs = await f.asOrg(org, (c) => c.query("select meta from audit_log where entity_id = $1 and action = 'invoice.create'", [second.id]));
    expect(logs.rows[0].meta).toMatchObject({ duplicateOf: first.number });
  });

  it("zwei gleichzeitige Quittungen bzw. Anzahlungen für dieselbe Behandlung → genau eine", async () => {
    const { appointment, line, doc, deposit } = await setup();
    const a3 = await appointment(`${year}-06-02 10:00+02`);
    const res = await Promise.allSettled([doc("receipt", [line({ appointmentId: a3 })]), doc("receipt", [line({ appointmentId: a3 })]), doc("invoice", [line({ appointmentId: a3 })])]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason.message))).toEqual([
      expect.stringMatching(/wurde bereits die (Quittung|Rechnung)/),
      expect.stringMatching(/wurde bereits die (Quittung|Rechnung)/),
    ]);
    const a4 = await appointment(`${year + 2}-06-09 10:00+02`);
    const deps = await Promise.allSettled([deposit(a4), deposit(a4)]);
    expect(deps.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});
