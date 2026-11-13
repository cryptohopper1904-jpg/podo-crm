/** Leistungsdatum (§ 14 Abs. 4 Nr. 6 UStG) je Belegart – festschreiben, sperren, auf dem Beleg ausgeben (echte DB, erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { dateDe } from "@/lib/format";
import { accountingServiceDate, invoiceHeading, invoiceService } from "@/lib/invoice-view";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Leistungsdatum auf Belegen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let withOrg: typeof import("@/db").withOrg;
  let berlinDateIso: typeof import("@/lib/format").berlinDateIso;
  const authFor = (org: string, user: string) =>
    ({ organization: { id: org, name: "Testpraxis Fuß", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;
  const line = (patch: Record<string, unknown> = {}) => ({ serviceId: null, description: "Podologische Komplexbehandlung", quantity: 1, factor: 1, unitPriceCents: 6500, vatRate: 0, ...patch });
  const base = (patientId: string, patch: Record<string, unknown> = {}) =>
    ({ kind: "invoice", patientId, billingContactId: null, issuedAt: "2026-11-13", dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], lines: [line()], ...patch }) as never;
  const bundle = (org: string, id: string) => withOrg(org, (tx) => invoices.loadInvoiceBundle(tx, org, id)).then((b) => b!);
  const heading = (b: Awaited<ReturnType<typeof bundle>>) => invoiceHeading(b.invoice, invoiceService(b), dateDe);
  const appointment = (org: string, patient: string, at: string) =>
    f.asOrg(org, async (c) => (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2,$3::timestamptz,$3::timestamptz + interval '45 minutes','done') returning id", [org, patient, at])).rows[0].id as string);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    invoices = await import("./invoices");
    ({ withOrg } = await import("@/db"));
    ({ berlinDateIso } = await import("@/lib/format"));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("ohne Termin-Bezug: Standard = Rechnungsdatum, eigenes Datum wird festgeschrieben; Zukunft abgelehnt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);

    const b1 = await bundle(org, (await invoices.createInvoice(auth, base(patient))).id);
    expect(b1.invoice).toMatchObject({ serviceDate: "2026-11-13", serviceDateTo: null, serviceDateFixed: true });
    expect(heading(b1)).toEqual({ heading: "Rechnung", serviceDateNote: "Leistungsdatum: 13.11.2026" });

    const rec = await invoices.createInvoice(auth, base(patient, { kind: "receipt", serviceDate: "2026-11-10", payments: [{ method: "cash", amountCents: 6500, voucherCode: null, externalRef: null }] }));
    expect(heading(await bundle(org, rec.id))).toEqual({ heading: "Quittung", serviceDateNote: "Leistungsdatum: 10.11.2026" });

    await expect(invoices.createInvoice(auth, base(patient, { serviceDate: "2999-01-01" }))).rejects.toThrow(/Leistungsdatum darf nicht in der Zukunft/);
  });

  it("mit Termin: Datum festgeschrieben – Verschieben nach dem Storno ändert Rechnung und Storno nicht", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const appt = await appointment(org, patient, "2026-03-12 09:00+01");
    const inv = await invoices.createInvoice(auth, base(patient, { serviceDate: "2026-11-13", lines: [line({ appointmentId: appt })] }));
    expect((await bundle(org, inv.id)).invoice).toMatchObject({ serviceDate: "2026-03-12", serviceDateTo: null });
    const storno = await invoices.cancelInvoice(auth, inv.id, "Test");

    // Termin ist nach dem Storno wieder frei und wird verschoben
    await f.asOrg(org, (c) => c.query("update appointments set starts_at = '2026-04-01 09:00+02', ends_at = '2026-04-01 09:45+02' where id = $1", [appt]));
    expect(heading(await bundle(org, inv.id))).toEqual({ heading: "Rechnung zur Behandlung am 12.03.2026", serviceDateNote: null });
    expect(heading(await bundle(org, storno.id))).toEqual({ heading: `Stornorechnung zur Rechnung ${inv.number}`, serviceDateNote: "Leistungsdatum der stornierten Rechnung: 12.03.2026" });
  });

  it("gemischt (Termin + Produkt ohne Bezug): Zeitraum aus beidem; künftiger Termin abgelehnt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const appt = await appointment(org, patient, "2026-11-02 10:00+01");
    const inv = await invoices.createInvoice(auth, base(patient, { serviceDate: "2026-11-06", lines: [line({ appointmentId: appt }), line({ description: "Pflegecreme" })] }));
    expect(heading(await bundle(org, inv.id))).toEqual({ heading: "Rechnung zur Behandlung im Zeitraum vom 02.11.2026 bis 06.11.2026", serviceDateNote: null });

    const future = await f.asOrg(org, async (c) =>
      (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() + interval '3 days', now() + interval '3 days 45 minutes','planned') returning id", [org, patient])).rows[0].id as string,
    );
    await expect(invoices.createInvoice(auth, base(patient, { kind: "receipt", lines: [line({ appointmentId: future })], payments: [{ method: "cash", amountCents: 6500, voucherCode: null, externalRef: null }] }))).rejects.toThrow(/Anzahlung erstellen/);
  });

  it("Sammelrechnung ohne Bezug: Leistungszeitraum von … bis; bis vor von abgelehnt", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const c = await invoices.createInvoice(auth, base(patient, { kind: "collective", serviceDate: "2026-10-01", serviceDateTo: "2026-10-31" }));
    const b = await bundle(org, c.id);
    expect(b.invoice).toMatchObject({ serviceDate: "2026-10-01", serviceDateTo: "2026-10-31" });
    expect(heading(b)).toEqual({ heading: "Sammelrechnung", serviceDateNote: "Leistungszeitraum: 01.10.2026 bis 31.10.2026" });
    await expect(invoices.createInvoice(auth, base(patient, { kind: "collective", serviceDate: "2026-10-31", serviceDateTo: "2026-10-01" }))).rejects.toThrow(/endet vor seinem Beginn/);
  });

  it("Ausfallhonorar ohne Termin-Bezug: „Termin am“ ist Pflicht", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const fee = base(patient, { kind: "no_show_fee", lines: [line({ description: "Ausfallhonorar", vatRate: 0 })] });
    await expect(invoices.createInvoice(auth, fee)).rejects.toThrow(/Datum des versäumten Termins/);
    const ok = await invoices.createInvoice(auth, { ...(fee as object), serviceDate: "2026-11-10" } as never);
    expect(heading(await bundle(org, ok.id)).heading).toBe("Ausfallhonorar für den Termin am 10.11.2026");
    // verknüpfter Termin in der Zukunft kann noch nicht versäumt sein
    const future = await f.asOrg(org, async (c) =>
      (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() + interval '2 days', now() + interval '2 days 30 minutes','planned') returning id", [org, patient])).rows[0].id as string,
    );
    await expect(invoices.createInvoice(auth, base(patient, { kind: "no_show_fee", lines: [line({ appointmentId: future, description: "Ausfallhonorar" })] }))).rejects.toThrow(/erst nach dem versäumten Termin/);
  });

  it("Anzahlung für einen künftigen Termin: Zahlungstag + „Leistung noch nicht erbracht“; Storno: „Anzahlung vom …“", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const appt = await f.asOrg(org, async (c) =>
      (await c.query("insert into appointments (organization_id, patient_id, starts_at, ends_at, status) values ($1,$2, now() + interval '8 days', now() + interval '8 days 45 minutes','planned') returning id", [org, patient])).rows[0].id as string,
    );
    const dep = await invoices.createDeposit(auth, { patientId: patient, appointmentId: appt, description: "Anzahlung Spangenbehandlung", amountCents: 5000, vatRate: 0, method: "cash" } as never);
    const b = await bundle(org, dep.id);
    const today = dateDe(berlinDateIso());
    expect(heading(b).serviceDateNote).toMatch(new RegExp(`^Anzahlung erhalten am ${today} für die Behandlung am \\d\\d\\.\\d\\d\\.\\d{4} – Leistung noch nicht erbracht\\.$`));
    const s = await bundle(org, (await invoices.cancelInvoice(auth, dep.id, "Termin abgesagt")).id);
    expect(heading(s)).toEqual({ heading: `Stornorechnung zur Anzahlung ${dep.number}`, serviceDateNote: `Storno der Anzahlung vom ${today}.` });
  });

  it("Altbeleg (vor Einführung) wird wie früher gedruckt; Leistungsangaben sind nach dem Ausstellen gesperrt; neue Zeilen standardmäßig festgeschrieben", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const inv = await invoices.createInvoice(auth, base(patient));
    // Altbeleg nachbilden: als Entwurf ohne Leistungsangabe (wie vor der Migration ausgestellt)
    const legacy = await f.asOrg(org, async (c) => {
      const id = (await c.query("insert into invoices (organization_id, patient_id, kind, status, service_date_fixed) values ($1,$2,'deposit','draft', false) returning id", [org, patient])).rows[0].id as string;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, quantity, factor, unit_price_cents, vat_rate, total_cents, position) values ($1,$2,'Anzahlung','1','1',1000,0,1000,1)", [org, id]);
      await c.query("update invoices set number = $3, status = 'paid', issued_at = '2026-01-05', total_cents = 1000, net_cents = 1000, paid_cents = 1000 where id = $2 and organization_id = $1", [org, id, `AZ-ALT-${id.slice(0, 6)}`]);
      return id;
    });
    expect(heading(await bundle(org, legacy))).toEqual({ heading: "Quittung über eine Anzahlung", serviceDateNote: null });
    const dflt = await f.asOrg(org, async (c) => (await c.query("select column_default d from information_schema.columns where table_name = 'invoices' and column_name = 'service_date_fixed'")).rows[0].d);
    expect(dflt).toBe("true");

    for (const sql of ["update invoices set service_date = '2026-01-01' where id = $1", "update invoices set service_date_to = '2026-12-31' where id = $1", "update invoices set service_date_fixed = false where id = $1"]) {
      await expect(f.asOrg(org, (c) => c.query(sql, [inv.id]))).rejects.toThrow(/unveränderbar/);
    }
  });

  it("Sammelrechnung mit übernommenen Quittungen: Leistungszeitraum deckt die Quittungen ab (nicht das Rechnungsdatum)", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const year = Number(berlinDateIso().slice(0, 4)) - 1;
    const cash = (cents: number) => [{ method: "cash", amountCents: cents, voucherCode: null, externalRef: null }];
    const r1 = await invoices.createInvoice(auth, base(patient, { kind: "receipt", issuedAt: `${year}-02-10`, payments: cash(6500) }));
    // Quittung am 20.03. für eine Behandlung am 18.03. (Leistungsdatum ausdrücklich)
    const r2 = await invoices.createInvoice(auth, base(patient, { kind: "receipt", issuedAt: `${year}-03-20`, serviceDate: `${year}-03-18`, payments: cash(6500) }));

    // Positionsdatum der offenen Quittungen = festgeschriebenes Leistungsdatum
    const open = await withOrg(org, (tx) => invoices.openReceiptsFor(tx, org, patient, year));
    expect(open.map((r) => r.lines[0].serviceDate)).toEqual([`${year}-02-10`, `${year}-03-18`]);

    const fromReceipts = [line({ fromReceipt: true }), line({ fromReceipt: true })];
    const sr = await invoices.createInvoice(auth, base(patient, { kind: "collective", issuedAt: berlinDateIso(), collectiveYear: year, receiptIds: [r1.id, r2.id], lines: fromReceipts }));
    const b = await bundle(org, sr.id);
    expect(b.invoice).toMatchObject({ serviceDate: `${year}-02-10`, serviceDateTo: `${year}-03-18` });
    expect(heading(b).serviceDateNote).toBe(`Leistungszeitraum: 10.02.${year} bis 18.03.${year}`);
    expect(accountingServiceDate(b.invoice)).toBe(`${year}-03-18`);

    // eigene Position ohne Bezug (z. B. Produkt): das Formular-Datum kommt dazu
    await invoices.cancelInvoice(auth, sr.id, "neu");
    const sr2 = await invoices.createInvoice(auth, base(patient, {
      kind: "collective",
      issuedAt: berlinDateIso(),
      collectiveYear: year,
      receiptIds: [r1.id, r2.id],
      serviceDate: `${year}-05-02`,
      lines: [...fromReceipts, line({ description: "Pflegecreme" })],
    }));
    expect((await bundle(org, sr2.id)).invoice).toMatchObject({ serviceDate: `${year}-02-10`, serviceDateTo: `${year}-05-02` });
  });

  it("weicher Doppel-Schutz vergleicht das Leistungsdatum, nicht das Rechnungsdatum", async () => {
    const org = await f.org();
    const auth = authFor(org, await f.user());
    const patient = await f.patient(org);
    const service = await f.asOrg(org, async (c) =>
      (await c.query("insert into services (organization_id, code, name, price_cents, vat_rate) values ($1,'PKB','Podologische Komplexbehandlung',6500,0) returning id", [org])).rows[0].id as string,
    );
    const today = berlinDateIso();
    const shift = (days: number) => berlinDateIso(new Date(Date.now() - days * 86_400_000));
    const doc = (serviceDate: string, extra: Record<string, unknown> = {}) =>
      invoices.createInvoice(auth, base(patient, { issuedAt: today, serviceDate, lines: [line({ serviceId: service })], ...extra }));
    const first = await doc(shift(7));
    // heute ausgestellt, Leistung wieder letzte Woche → erkannt, Meldung nennt das Leistungsdatum
    const err = await doc(shift(7)).catch((e) => e);
    expect(err).toBeInstanceOf(invoices.DuplicateInvoiceError);
    expect(err.message).toContain(`mit Leistungsdatum ${dateDe(shift(7))}`);
    expect(err.duplicate).toEqual({ id: first.id, number: first.number });
    // gleiches Rechnungsdatum, anderer Leistungstag → kein Hinweis
    await expect(doc(shift(1))).resolves.toMatchObject({ number: expect.any(String) });
  });
});
