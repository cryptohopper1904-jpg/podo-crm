/**
 * Quittungen als Teilrechnungen → Sammelrechnung als Schlussrechnung (DB, erfundene Daten).
 * Bezahlte normale Quittungen des Jahres werden mit ihren Leistungen übernommen und als „bereits bezahlt“ angerechnet –
 * ohne zweiten Umsatz in Kasse/Rechnungsliste/Buchhaltung; Storno der Sammelrechnung gibt sie wieder frei.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Quittungen → Sammelrechnung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let billing: typeof import("./appointment-billing");
  let invoices: typeof import("./invoices");
  let kasse: typeof import("./kasse");
  let view: typeof import("@/lib/invoice-view");
  let dateDe: (d: string | null) => string;
  let today: string;
  let year: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    billing = await import("./appointment-billing");
    invoices = await import("./invoices");
    kasse = await import("./kasse");
    view = await import("@/lib/invoice-view");
    const fmt = await import("@/lib/format");
    dateDe = (d) => fmt.dateDe(d);
    today = fmt.berlinDateIso();
    // Sammelrechnung im Folgejahr für das Vorjahr (läuft auch im Januar mit Leistungen in der Vergangenheit)
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
    const appointment = async (patientId: string, startsAt: string) =>
      f.asOrg(org, async (c) => {
        const id = (
          await c.query(
            `insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, source, status, title)
             values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '45 minutes','manual','done','Behandlung') returning id`,
            [org, patientId, user, startsAt],
          )
        ).rows[0].id as string;
        await c.query("insert into appointment_services (organization_id, appointment_id, service_id) values ($1,$2,$3)", [org, id, service]);
        return id;
      });
    /** normale Quittung (sofort bar bezahlt) */
    const receipt = (patientId: string, issuedAt: string, lines: { appointmentId?: string | null; description: string; unitPriceCents: number; vatRate: number; quantity?: number }[]) => {
      const total = lines.reduce((s, l) => s + l.unitPriceCents * (l.quantity ?? 1), 0);
      return invoices.createInvoice(auth, {
        kind: "receipt",
        patientId,
        billingContactId: null,
        issuedAt,
        therapeuticConfirmed: true,
        notes: null,
        lines: lines.map((l) => ({ serviceId: null, treatmentRecordId: null, appointmentId: l.appointmentId ?? null, description: l.description, quantity: l.quantity ?? 1, factor: 1, unitPriceCents: l.unitPriceCents, vatRate: l.vatRate })),
        payments: [{ method: "cash", amountCents: total }],
      });
    };
    const umsatz = async () => {
      const k = await kasse.kasseOverview(auth);
      return {
        cash: k.calc.cashPaymentsCents,
        bons: k.calc.bons.length,
        umsatz: k.calc.totals.businessCases.filter((b) => b.gvTyp === "Umsatz").reduce((s, b) => s + b.grossCents, 0),
        vat: k.calc.totals.byVat.reduce((s, v) => s + v.vatCents, 0),
      };
    };
    return { org, user, auth, appointment, receipt, umsatz };
  }

  /** Positionen der Sammelrechnung aus den offenen Quittungen (wie das Formular sie übernimmt) */
  const linesOf = (rs: Awaited<ReturnType<typeof invoices.openReceiptsForPatient>>) =>
    rs.flatMap((r) =>
      r.lines.map((l) => ({
        serviceId: null,
        treatmentRecordId: l.treatmentRecordId,
        appointmentId: l.appointmentId,
        description: `${dateDe(l.serviceDate)}: ${l.description}`,
        quantity: l.quantity,
        factor: l.factor,
        unitPriceCents: l.unitPriceCents,
        vatRate: l.vatRate,
      })),
    );

  it("übernimmt die Quittungen des Jahres, rechnet sie mit USt an, kein zweiter Umsatz; Storno gibt sie frei", async () => {
    const { org, auth, appointment, receipt, umsatz } = await setup();
    const patient = await f.patient(org, { lastName: "Quittung", firstName: "Quirin" });
    const a1 = await appointment(patient, `${year}-02-03 10:00+01`);
    const a2 = await appointment(patient, `${year}-05-06 10:00+02`);
    const r1 = await receipt(patient, `${year}-02-03`, [
      { appointmentId: a1, description: "Podologische Komplexbehandlung", unitPriceCents: 4500, vatRate: 0 },
      { description: "Pflegecreme", unitPriceCents: 1190, vatRate: 19 },
    ]);
    const r2 = await receipt(patient, `${year}-05-06`, [{ appointmentId: a2, description: "Podologische Komplexbehandlung", unitPriceCents: 4500, vatRate: 0 }]);
    // Quittung des Vorjahres: gehört nicht in die Sammelrechnung dieses Jahres
    const old = await receipt(patient, `${year - 1}-12-15`, [{ description: "Behandlung", unitPriceCents: 3000, vatRate: 0 }]);
    expect([r1.status, r2.status, old.status]).toEqual(["paid", "paid", "paid"]);
    const before = await umsatz();
    expect(before.umsatz).toBe(5690 + 4500 + 3000);

    // Übersicht und Vorschlag: Behandlungen sind über die Quittungen abgerechnet, die Quittungen des Jahres offen
    expect(await billing.collectiveOverview(auth, year)).toEqual([
      expect.objectContaining({ patientId: patient, items: 0, receiptCount: 2, receiptCents: 5690 + 4500, depositCount: 0 }),
    ]);
    expect((await billing.collectiveOverview(auth, year - 1)).find((r) => r.patientId === patient)).toMatchObject({ receiptCount: 1, receiptCents: 3000 });
    const sug = await billing.patientYearSuggestion(auth, patient, year);
    expect(sug!.lines).toEqual([]);
    expect(sug!.receipts.map((r) => r.id)).toEqual([r1.id, r2.id]);
    const form = await invoices.invoiceFormData(auth, patient, year);
    expect(form.openReceipts.map((r) => r.number)).toEqual([r1.number, r2.number]);
    expect(form.openReceipts[0].lines).toEqual([
      expect.objectContaining({ appointmentId: a1, unitPriceCents: 4500, vatRate: 0, serviceDate: `${year}-02-03` }),
      expect.objectContaining({ appointmentId: null, unitPriceCents: 1190, vatRate: 19, serviceDate: `${year}-02-03` }),
    ]);

    const open = await invoices.openReceiptsForPatient(auth, patient, year);
    const lines = linesOf(open);
    const base = { kind: "collective" as const, patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], collectiveYear: year };
    // ohne Anrechnung bleibt die Doppelabrechnung gesperrt
    await expect(invoices.createInvoice(auth, { ...base, lines })).rejects.toThrow(/bereits in Rechnung/);
    // Quittung nur auf eine Sammelrechnung
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [lines[1]], receiptIds: [r1.id] })).rejects.toThrow(/nur auf eine Sammelrechnung/);
    // nur eine Quittung angerechnet: die Behandlung der anderen bleibt gesperrt
    await expect(invoices.createInvoice(auth, { ...base, lines, receiptIds: [r1.id] })).rejects.toThrow(/06\.05\.\d{4} ist bereits in Rechnung/);
    // Steuersätze: die Sammelrechnung muss je Satz mindestens die angerechneten Beträge enthalten
    await expect(
      invoices.createInvoice(auth, { ...base, lines: lines.map((l) => ({ ...l, vatRate: 0 })), receiptIds: [r1.id, r2.id] }),
    ).rejects.toThrow(/enthalten 11,90 € mit 19 % USt, die Sammelrechnung nur 0,00 €/);
    // Jahresgrenze: Quittung aus einem anderen Jahr bzw. unpassendes Leistungsjahr
    await expect(
      invoices.createInvoice(auth, { ...base, lines: [...lines, { serviceId: null, treatmentRecordId: null, appointmentId: null, description: "Behandlung", quantity: 1, factor: 1, unitPriceCents: 3000, vatRate: 0 }], receiptIds: [r1.id, r2.id, old.id] }),
    ).rejects.toThrow(/stammt nicht aus dem Leistungsjahr/);
    await expect(invoices.createInvoice(auth, { ...base, lines, receiptIds: [r1.id, r2.id], collectiveYear: year - 1 })).rejects.toThrow(/Leistungsjahr \d{4} passt nicht/);

    const sr = await invoices.createInvoice(auth, { ...base, lines, receiptIds: [r1.id, r2.id] });
    expect(sr).toMatchObject({ totalCents: 10190, paidCents: 10190, status: "paid", receiptCents: 10190, depositCents: 0 });

    const bundle = await invoices.getInvoice(auth, sr.id);
    expect(bundle!.payments).toEqual([]);
    expect(bundle!.credited.map((d) => [d.kind, d.number, d.totalCents])).toEqual([
      ["receipt", r1.number, 5690],
      ["receipt", r2.number, 4500],
    ]);
    expect(bundle!.lines.map((l) => l.appointmentId)).toEqual([a1, null, a2]);
    // § 14 Abs. 5 UStG: USt der Quittungen wird abgesetzt, es bleibt keine USt und nichts offen
    const { computeTotals } = await import("@/lib/invoice-math");
    expect(view.paymentSummary(bundle!.invoice, bundle!.credited, dateDe, computeTotals(bundle!.lines).groups)).toEqual([
      { label: `abzgl. bereits bezahlt mit Quittung ${r1.number} vom 03.02.${year} (netto 55,00 € zzgl. 19 % USt 1,90 €)`, cents: -5690 },
      { label: `abzgl. bereits bezahlt mit Quittung ${r2.number} vom 06.05.${year}`, cents: -4500 },
      { label: "darin verbleibende USt 19 %", cents: 0 },
    ]);
    expect(view.creditedReceiptsBlock(bundle!.credited)).toMatchObject({ totalCents: 10190, vatCents: 190 });
    const r1b = await invoices.getInvoice(auth, r1.id);
    expect(r1b!.creditedTo).toMatchObject({ id: sr.id, number: sr.number });

    // kein zweiter Umsatz: Kasse unverändert, Rechnungsliste zählt den Betrag nur einmal
    expect(await umsatz()).toEqual(before);
    const list = await invoices.listInvoices(auth);
    expect(list.totals.totalCents).toBe(5690 + 4500 + 3000);
    expect(list.totals.paidCents).toBe(5690 + 4500 + 3000);
    // Buchhaltung: vollständig durch (einzeln übertragene) Quittungen gedeckt
    expect(await invoices.pushInvoiceToAccounting(auth, sr.id)).toMatchObject({ ok: true, message: expect.stringMatching(/nichts zu übertragen/) });

    // nur einmal anrechnen; Quittung nicht stornierbar, solange angerechnet
    expect(await invoices.openReceiptsForPatient(auth, patient, year)).toEqual([]);
    expect(await billing.collectiveOverview(auth, year)).toEqual([]);
    await expect(invoices.createInvoice(auth, { ...base, lines: [lines[1]], receiptIds: [r1.id] })).rejects.toThrow(/bereits auf eine andere Sammelrechnung/);
    await expect(invoices.cancelInvoice(auth, r1.id, "x")).rejects.toThrow(/Quittung ist auf SR.* angerechnet/);

    // Storno der Sammelrechnung: nichts zu erstatten, Quittungen wieder frei, Kasse unverändert
    const credit = await invoices.cancelInvoice(auth, sr.id, "neu");
    expect(credit).toMatchObject({ refundCents: 0, releasedReceipts: 2, releasedDeposits: 0 });
    const cn = await invoices.getInvoice(auth, credit.id);
    expect(cn!.invoice).toMatchObject({ totalCents: -10190, paidCents: -10190, status: "paid" });
    expect(invoices.stornoReceiptNumbers(cn!.invoice.notes)).toEqual([r1.number, r2.number]);
    expect(await invoices.pushInvoiceToAccounting(auth, credit.id)).toMatchObject({ ok: true, message: expect.stringMatching(/nichts zu übertragen/) });
    expect((await invoices.getInvoice(auth, r1.id))!.invoice.collectiveInvoiceId).toBeNull();
    expect((await invoices.openReceiptsForPatient(auth, patient, year)).map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(await umsatz()).toEqual(before);
    expect((await invoices.listInvoices(auth)).totals.totalCents).toBe(5690 + 4500 + 3000);

    // neue Sammelrechnung mit weiterer 19-%-Leistung: nur der Rest ist neuer Umsatz (Kasse +23,80 €). Die Restzahlung
    // verteilt sich nur auf den Rest je Steuersatz (hier ganz 19 %), nicht anteilig auf die 0-%-Positionen der Quittungen.
    const extra = { serviceId: null, treatmentRecordId: null, appointmentId: null, description: "Orthose", quantity: 1, factor: 1, unitPriceCents: 2380, vatRate: 19 };
    const sr2 = await invoices.createInvoice(auth, { ...base, lines: [...lines, extra], receiptIds: [r1.id, r2.id] });
    expect(sr2).toMatchObject({ totalCents: 12570, paidCents: 10190, status: "partially_paid", receiptCents: 10190 });
    expect(await invoices.addPayments(auth, sr2.id, [{ method: "cash", amountCents: 2380 }])).toMatchObject({ status: "paid", paidCents: 12570 });
    const after = await umsatz();
    expect(after.cash - before.cash).toBe(2380);
    expect(after.umsatz - before.umsatz).toBe(2380);
    expect(after.vat - before.vat).toBe(380);
    const k = await kasse.kasseOverview(auth);
    const bon = k.calc.bons.find((b) => b.invoiceNumber === sr2.number)!;
    expect(bon.lines.map((l) => [l.gvTyp, l.rate, l.grossCents, l.vatCents])).toEqual([["Umsatz", 19, 2380, 380]]);
    expect((await invoices.listInvoices(auth)).totals.totalCents).toBe(5690 + 4500 + 3000 + 2380);
    const b2 = await invoices.getInvoice(auth, sr2.id);
    expect(view.paymentSummary(b2!.invoice, b2!.credited, dateDe).at(-1)).toEqual({ label: "weitere Zahlungen", cents: 2380 });
  });

  it("fremde, stornierte, jüngere und doppelt gewählte Quittungen werden abgewiesen; DB-Sicherung", async () => {
    const { org, auth, appointment, receipt } = await setup();
    const patient = await f.patient(org, { lastName: "Eigen" });
    const other = await f.patient(org, { lastName: "Fremd" });
    const a1 = await appointment(patient, `${year}-03-03 10:00+01`);
    const mine = await receipt(patient, `${year}-03-03`, [{ appointmentId: a1, description: "Behandlung", unitPriceCents: 4500, vatRate: 0 }]);
    const foreign = await receipt(other, `${year}-03-04`, [{ description: "Behandlung", unitPriceCents: 4500, vatRate: 0 }]);
    const line = { serviceId: null, treatmentRecordId: null, appointmentId: null, description: "Behandlung", quantity: 1, factor: 1, unitPriceCents: 4500, vatRate: 0 };
    const base = { kind: "collective" as const, patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [], collectiveYear: year, lines: [line] };

    await expect(invoices.createInvoice(auth, { ...base, receiptIds: [foreign.id] })).rejects.toThrow(/keine Quittung dieser Person/);
    // Quittung einer anderen Praxis: nicht sichtbar (Mandantentrennung) → nicht gefunden
    const other2 = await setup();
    const p2 = await f.patient(other2.org, { lastName: "Mandant" });
    const alien = await other2.receipt(p2, `${year}-03-03`, [{ description: "Behandlung", unitPriceCents: 4500, vatRate: 0 }]);
    await expect(invoices.createInvoice(auth, { ...base, receiptIds: [alien.id] })).rejects.toThrow(/Quittung nicht gefunden/);
    expect(await invoices.openReceiptsForPatient(auth, p2, year)).toEqual([]);
    await expect(invoices.createInvoice(auth, { ...base, depositIds: [mine.id] })).rejects.toThrow(/keine Anzahlung dieser Person/);
    await expect(invoices.createInvoice(auth, { ...base, issuedAt: `${year}-03-01`, receiptIds: [mine.id] })).rejects.toThrow(/jünger als die Sammelrechnung/);
    await expect(invoices.createInvoice(auth, { ...base, lines: [{ ...line, unitPriceCents: 4000 }], receiptIds: [mine.id] })).rejects.toThrow(/enthalten 45,00 € mit 0 % USt, die Sammelrechnung nur 40,00 €/);
    // Rechnung einer anderen Person an die Anrechnung hängen: auch der Termin gehört nicht zu ihr
    await expect(invoices.createInvoice(auth, { ...base, patientId: other, lines: [{ ...line, appointmentId: a1 }], receiptIds: [foreign.id] })).rejects.toThrow(/gehört nicht/);

    // stornierte Quittung wird nicht angeboten und nicht angerechnet
    const gone = await receipt(patient, `${year}-03-05`, [{ description: "Behandlung", unitPriceCents: 4500, vatRate: 0 }]);
    await invoices.cancelInvoice(auth, gone.id, "Irrtum");
    expect((await invoices.openReceiptsForPatient(auth, patient, year)).map((r) => r.id)).toEqual([mine.id]);
    await expect(invoices.createInvoice(auth, { ...base, receiptIds: [gone.id] })).rejects.toThrow(/storniert/);

    // DB-Trigger: Quittung nur auf eine ausgestellte Sammelrechnung derselben Person
    const plain = await f.invoice(org, patient);
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = $2 where id = $1", [mine.id, plain]))).rejects.toThrow(/nur auf eine Sammelrechnung/);
    const sr = await invoices.createInvoice(auth, { ...base, lines: [{ ...line, appointmentId: a1 }], receiptIds: [mine.id] });
    expect(sr.status).toBe("paid");
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = $2 where id = $1", [foreign.id, sr.id]))).rejects.toThrow(/anderen Person/);
    await expect(f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id = null where id = $1", [mine.id]))).rejects.toThrow(/bereits auf eine Rechnung angerechnet/);
  });
});
