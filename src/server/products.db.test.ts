/**
 * Produkte & Warenwirtschaft (DB, erfundene Daten): Verkauf über Rechnungen mit USt-Regel (serverseitig),
 * Bestand aus Lagerbewegungen (Verkauf, Storno, Wareneingang, Inventur), Nachbestell-Liste, RLS und Unveränderbarkeit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Produkte & Warenwirtschaft (DB)", () => {
  const f = fixtures(TEST_DB!);
  let invoices: typeof import("./invoices");
  let products: typeof import("./products");
  let today: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.TSE_PROVIDER;
    invoices = await import("./invoices");
    products = await import("./products");
    today = (await import("@/lib/format")).berlinDateIso();
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  async function setup(opts: { smallBusiness?: boolean } = {}) {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    if (opts.smallBusiness) await f.pool.query("update organizations set small_business = true where id = $1", [org]);
    const auth = { organization: { id: org, name: "Praxis Test", slug: "t", smallBusiness: !!opts.smallBusiness }, user: { id: user, name: "Test" }, can: () => true } as never;
    const patient = await f.patient(org);
    const svc = await f.asOrg(org, async (c) => {
      const treat = (await c.query("insert into services (organization_id, code, name, price_cents, vat_rate, requires_therapeutic_purpose) values ($1,'PK','Komplexbehandlung',6500,0,true) returning id", [org])).rows[0].id as string;
      const cosm = (await c.query("insert into services (organization_id, code, name, price_cents, vat_rate, category, requires_therapeutic_purpose) values ($1,'LA','Nägel lackieren',1000,19,'cosmetic',false) returning id", [org])).rows[0].id as string;
      return { treat, cosm };
    });
    const supplier = (await products.saveSupplier(auth, null, { name: "Fußpflege-Großhandel", customerNumber: "K-42" })).id;
    const salbe = (
      await products.saveProduct(auth, null, { name: "Hornhautsalbe", code: "HS", category: "salbe", priceCents: 1290, vatRate: 19, unit: "Stück", trackStock: true, minStock: 2, supplierId: supplier })
    ).id;
    const base = { patientId: patient, billingContactId: null, issuedAt: today, dueDays: 14, therapeuticConfirmed: true, notes: null, payments: [] };
    const svcLine = (serviceId: string, vatRate: number, priceCents: number) => ({ serviceId, treatmentRecordId: null, description: "", quantity: 1, factor: 1, unitPriceCents: priceCents, vatRate });
    const prodLine = (productId: string, quantity: number, p: { inTreatment?: boolean; vatRate?: number; treatmentLine?: number | null; priceCents?: number } = {}) => ({
      serviceId: null,
      productId,
      inTreatment: p.inTreatment ?? false,
      treatmentLine: p.treatmentLine ?? null,
      treatmentRecordId: null,
      description: "",
      quantity,
      factor: 1,
      unitPriceCents: p.priceCents ?? 1290,
      vatRate: p.vatRate ?? (p.inTreatment ? 0 : 19),
    });
    return { org, user, auth, patient, svc, supplier, salbe, base, svcLine, prodLine };
  }

  const stockOf = async (auth: never, id: string) => (await products.getProduct(auth, id))!.stock;
  const linesOf = (org: string, invoiceId: string) =>
    f.asOrg(org, async (c) => (await c.query("select line_kind, product_id, in_treatment, treatment_position, vat_rate, description, unit_price_cents, total_cents from invoice_lines where invoice_id = $1 order by position", [invoiceId])).rows);

  it("Verkauf zum Mitnehmen: 19 %, Katalogpreis, Bestand sinkt beim Ausstellen und steigt beim Storno", async () => {
    const { org, auth, salbe, base, prodLine } = await setup();
    await products.bookReceipt(auth, { productId: salbe, quantity: 10, occurredOn: today, unitCostCents: 600, deliveryNote: "LS-1" });
    expect(await stockOf(auth, salbe)).toBe(10);

    const inv = await invoices.createInvoice(auth, { ...base, kind: "receipt", therapeuticConfirmed: false, lines: [prodLine(salbe, 3)], payments: [{ method: "cash", amountCents: 3870 }] });
    expect(inv.totalCents).toBe(3 * 1290);
    expect(await linesOf(org, inv.id)).toEqual([
      expect.objectContaining({ line_kind: "product", product_id: salbe, in_treatment: false, vat_rate: 19, description: "Hornhautsalbe", unit_price_cents: 1290 }),
    ]);
    expect(await stockOf(auth, salbe)).toBe(7);

    const storno = await invoices.cancelInvoice(auth, inv.id, "Test");
    expect(await stockOf(auth, salbe)).toBe(10);
    // Storno ohne Rückbuchung (Ware verbraucht/beim Kunden): Bestand bleibt
    const inv2 = await invoices.createInvoice(auth, { ...base, kind: "invoice", therapeuticConfirmed: false, lines: [prodLine(salbe, 2)] });
    expect(await stockOf(auth, salbe)).toBe(8);
    await invoices.cancelInvoice(auth, inv2.id, "verbraucht", { restockLineIds: [] });
    expect(await stockOf(auth, salbe)).toBe(8);
    await products.correctStock(auth, { productId: salbe, kind: "inventory", amount: 10 });
    // Gutschrift trägt die Produktposition ebenfalls (negativ), Bewegungen verweisen auf die Belege
    expect(await linesOf(org, storno.id)).toEqual([expect.objectContaining({ line_kind: "product", product_id: salbe, total_cents: -3870 })]);
    const p = await products.getProduct(auth, salbe);
    expect(p!.movements.map((m) => [m.kind, m.quantity, m.invoiceId])).toEqual(
      expect.arrayContaining([
        ["receipt", 10, null],
        ["sale", -3, inv.id],
        ["storno", 3, storno.id],
      ]),
    );
  });

  it("0 % für ein Produkt wird serverseitig nur mit Heilbehandlung auf demselben Beleg akzeptiert", async () => {
    const { org, user, auth, svc, salbe, base, svcLine, prodLine } = await setup();
    // ohne Behandlungsposition
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [prodLine(salbe, 1, { inTreatment: true })] })).rejects.toThrow(/nur zusammen mit einer Heilbehandlung/);
    // nur kosmetische Leistung (19 %)
    await expect(
      invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.cosm, 19, 1000), prodLine(salbe, 1, { inTreatment: true })] }),
    ).rejects.toThrow(/nur zusammen mit einer Heilbehandlung/);
    // 0 % ohne Kennzeichen „angewendet“ (manipuliertes Formular)
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 1, { vatRate: 0 })] })).rejects.toThrow(/19 %/);
    // Kennzeichen bei einer Leistungsposition
    await expect(
      invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [{ ...svcLine(svc.treat, 0, 6500), inTreatment: true }] }),
    ).rejects.toThrow(/nur für Produkte/);
    // mit Behandlung, aber ohne USt-Wächter-Bestätigung
    await expect(
      invoices.createInvoice(auth, { ...base, therapeuticConfirmed: false, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 1, { inTreatment: true })] }),
    ).rejects.toThrow(/USt-Wächter/);

    const ok = await invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 2, { inTreatment: true })] });
    expect(ok.totalCents).toBe(6500 + 2 * 1290);
    expect(ok.productsInTreatment).toBe(1);
    const lines = await linesOf(org, ok.id);
    expect(lines[1]).toMatchObject({ line_kind: "product", in_treatment: true, vat_rate: 0, description: "Hornhautsalbe – in der Behandlung angewendet", treatment_position: 1 });
    const [inv] = (await f.asOrg(org, (c) => c.query("select vat_cents, notes from invoices where id = $1", [ok.id]))).rows;
    expect(inv.vat_cents).toBe(0);
    expect(inv.notes).toMatch(/USt-Wächter/);

    // dieselbe Rechnung als „zum Mitnehmen“: 19 % auf das Produkt
    const take = await invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 1)] });
    const [t] = (await f.asOrg(org, (c) => c.query("select vat_cents from invoices where id = $1", [take.id]))).rows;
    expect(t.vat_cents).toBe(206);

    // Sammelrechnung mit zwei Behandlungen: Zuordnung nötig
    await expect(
      invoices.createInvoice(auth, { ...base, kind: "collective", lines: [svcLine(svc.treat, 0, 6500), svcLine(svc.treat, 0, 6500), prodLine(salbe, 1, { inTreatment: true })] }),
    ).rejects.toThrow(/zuordnen/);
    // Storno: in der Behandlung verbrauchte Ware wird nie zurückgebucht, verkaufte nur nach Auswahl je Position
    await products.bookReceipt(auth, { productId: salbe, quantity: 20, occurredOn: today });
    const start = (await products.getProduct(auth, salbe))!.stock;
    const mixed = await invoices.createInvoice(auth, {
      ...base,
      kind: "invoice",
      lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 1, { inTreatment: true }), prodLine(salbe, 2), prodLine(salbe, 3)],
    });
    expect((await products.getProduct(auth, salbe))!.stock).toBe(start - 6);
    const mixedLines = (await f.asOrg(org, (c) => c.query("select id from invoice_lines where invoice_id = $1 order by position", [mixed.id]))).rows.map((r) => r.id as string);
    // nur Position 3 (2 Stück) zurück; Position 2 (angewendet) wird selbst bei Auswahl ignoriert
    await invoices.cancelInvoice(auth, mixed.id, "Test", { restockLineIds: [mixedLines[1], mixedLines[2]] });
    expect((await products.getProduct(auth, salbe))!.stock).toBe(start - 6 + 2);
    const all = await invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), prodLine(salbe, 1, { inTreatment: true }), prodLine(salbe, 2)] });
    await invoices.cancelInvoice(auth, all.id, "Test"); // ohne Auswahl: alle verkauften, nie die angewendeten
    expect((await products.getProduct(auth, salbe))!.stock).toBe(start - 6 + 2 - 3 + 2);

    // Sammelrechnung: Bezug (Position) und Datum der Behandlung stehen an der Produktposition
    const year = today.slice(0, 4);
    const rec = (day: string, prev: string | null, hash: string) =>
      f.asOrg(org, async (c) =>
        (await c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, prev_hash, hash) values ($1,$2,$3,$4,$5,$6) returning id", [org, base.patientId, user, `${year}-01-${day} 10:00+01`, prev, hash])).rows[0].id as string,
      );
    const r1 = await rec("05", null, "a");
    const r2 = await rec("12", "a", "b");
    const coll = await invoices.createInvoice(auth, {
      ...base,
      kind: "collective",
      lines: [
        { ...svcLine(svc.treat, 0, 6500), treatmentRecordId: r1 },
        { ...svcLine(svc.treat, 0, 6500), treatmentRecordId: r2 },
        prodLine(salbe, 1, { inTreatment: true, treatmentLine: 1 }),
      ],
    });
    expect((await linesOf(org, coll.id))[2]).toMatchObject({ in_treatment: true, treatment_position: 2, description: `Hornhautsalbe – in der Behandlung vom 12.01.${year} angewendet` });
    // Beschreibung kommt immer aus dem Katalog (kein Freitext auf Produktpositionen)
    const free = await invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.treat, 0, 6500), { ...prodLine(salbe, 1), description: "Gratis-Probe" }] });
    expect((await linesOf(org, free.id))[1]).toMatchObject({ description: "Hornhautsalbe", treatment_position: null });

    // archivierte Leistung: nicht mehr für neue Positionen
    await f.asOrg(org, (c) => c.query("update services set active = false where id = $1", [svc.cosm]));
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [svcLine(svc.cosm, 19, 1000)] })).rejects.toThrow(/archiviert/);

    // Datenbank: „angewendet“ nur bei Produktposition mit 0 % (zweite Sicherung)
    await expect(
      f.asOrg(org, async (c) => {
        const id = (await c.query("insert into invoices (organization_id, patient_id, status) values ($1,$2,'draft') returning id", [org, base.patientId])).rows[0].id;
        await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, line_kind, product_id, in_treatment, treatment_position) values ($1,$2,'X',1290,1290,0,'product',$3,true,null)", [org, id, salbe]);
      }),
    ).rejects.toThrow(/invoice_lines_kind_check/);
  });

  it("Kleinunternehmer: Produkte ohne USt, keine Behandlungs-Prüfung", async () => {
    const { org, auth, salbe, base, prodLine } = await setup({ smallBusiness: true });
    const inv = await invoices.createInvoice(auth, { ...base, kind: "invoice", therapeuticConfirmed: false, lines: [prodLine(salbe, 1, { inTreatment: true })] });
    expect(await linesOf(org, inv.id)).toEqual([expect.objectContaining({ vat_rate: 0, in_treatment: false, description: "Hornhautsalbe" })]);
  });

  it("archivierte Produkte sind nicht mehr verkäuflich und fehlen in der Rechnungsauswahl", async () => {
    const { auth, salbe, base, prodLine } = await setup();
    await products.setProductActive(auth, salbe, false);
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", lines: [prodLine(salbe, 1)] })).rejects.toThrow(/archiviert/);
    const data = await invoices.invoiceFormData(auth);
    expect(data.products.map((p) => p.id)).not.toContain(salbe);
    await products.setProductActive(auth, salbe, true);
    expect((await invoices.invoiceFormData(auth)).products.map((p) => p.id)).toContain(salbe);
  });

  it("Inventur und Bruch als Bewegungen, Bestand = Summe; Nachbestell-Liste nach Lieferant", async () => {
    const { auth, salbe } = await setup();
    const creme = (await products.saveProduct(auth, null, { name: "Fußcreme", category: "creme", priceCents: 990, vatRate: 19, unit: "Tube", trackStock: true, minStock: 5 })).id;
    await products.saveProduct(auth, null, { name: "Ohne Bestand", category: "sonstiges", priceCents: 500, vatRate: 19, unit: "Stück", trackStock: false, minStock: 3 });
    await products.bookReceipt(auth, { productId: salbe, quantity: 6, occurredOn: today });
    expect(await products.correctStock(auth, { productId: salbe, kind: "inventory", amount: 4, note: "Zählung" })).toEqual({ before: 6, after: 4, quantity: -2 });
    await products.correctStock(auth, { productId: salbe, kind: "breakage", amount: 1 });
    await products.correctStock(auth, { productId: salbe, kind: "own_use", amount: 1 });
    expect(await stockOf(auth, salbe)).toBe(2);
    await expect(products.correctStock(auth, { productId: salbe, kind: "inventory", amount: 2 })).rejects.toThrow(/stimmt bereits/);
    const p = await products.getProduct(auth, salbe);
    expect(p!.movements.reduce((s, m) => s + m.quantity, 0)).toBe(p!.stock);
    expect(p!.movements.every((m) => m.userName === "Test")).toBe(true);

    const groups = await products.productReorderGroups(auth);
    expect(groups).toEqual([
      expect.objectContaining({ supplier: "Fußpflege-Großhandel", customerNumber: "K-42", lines: [expect.objectContaining({ name: "Hornhautsalbe", stock: 2, orderQty: 2 })] }),
      expect.objectContaining({ supplier: "ohne Lieferant", lines: [expect.objectContaining({ name: "Fußcreme", stock: 0, orderQty: 10 })] }),
    ]);
    expect(creme).toBeTruthy();

    // Obergrenze je Buchung (auch in der DB)
    await expect(products.correctStock(auth, { productId: salbe, kind: "inventory", amount: 1_000_003 })).rejects.toThrow(/Höchstens/);
    // Zukunftsdatum beim Wareneingang
    await expect(products.bookReceipt(auth, { productId: salbe, quantity: 1, occurredOn: "2999-01-01" })).rejects.toThrow(/Zukunft/);
  });

  it("Kürzel: Leistungen und Produkte kollidieren in beide Richtungen nicht", async () => {
    const { org, auth } = await setup();
    // Produkt mit dem Kürzel einer Leistung (PK) → abgelehnt, auch klein geschrieben
    await expect(products.saveProduct(auth, null, { name: "Salbe PK", code: "pk", category: "salbe", priceCents: 100, vatRate: 19, unit: "Stück", trackStock: false, minStock: 0 })).rejects.toThrow(/schon eine Leistung/);
    // umgekehrt: Leistungs-Kürzel gegen Produkte (wie saveServiceAction prüft)
    const { withOrg } = await import("@/db");
    expect(await withOrg(org, (tx) => products.codeTaken(tx, org, "hs", "product"))).toBe(true);
    expect(await withOrg(org, (tx) => products.codeTaken(tx, org, "XY", "product"))).toBe(false);
    expect(await withOrg(org, (tx) => products.codeTaken(tx, org, "pk", "service"))).toBe(true);
  });

  it("Bestandsführung: nicht abschaltbar mit Bewegungen; ohne Bestandsführung keine Ab-/Rückbuchung", async () => {
    const { auth, base, prodLine } = await setup();
    const input = { name: "Zehenschutz", category: "hilfsmittel" as const, priceCents: 450, vatRate: 19 as const, unit: "Stück", trackStock: false, minStock: 0 };
    const zs = (await products.saveProduct(auth, null, input)).id;
    const inv = await invoices.createInvoice(auth, { ...base, kind: "invoice", therapeuticConfirmed: false, lines: [prodLine(zs, 2, { priceCents: 450 })] });
    expect(await stockOf(auth, zs)).toBe(0);
    // Bestandsführung erst nach dem Verkauf eingeschaltet → Storno bucht nichts zurück
    await products.saveProduct(auth, zs, { ...input, trackStock: true });
    await invoices.cancelInvoice(auth, inv.id, "Test");
    const p = await products.getProduct(auth, zs);
    expect(p!.movements).toEqual([]);
    expect(p!.stock).toBe(0);

    await products.bookReceipt(auth, { productId: zs, quantity: 3, occurredOn: today });
    await expect(products.saveProduct(auth, zs, { ...input, trackStock: false })).rejects.toThrow(/nicht mehr abschalten/);
    // Wareneingang für archivierte Produkte gesperrt
    await products.setProductActive(auth, zs, false);
    await expect(products.bookReceipt(auth, { productId: zs, quantity: 1, occurredOn: today })).rejects.toThrow(/archiviert/);
  });

  it("Preis seit Formularöffnung geändert → eigene Meldung; parallele Inventur und Verkauf bleiben konsistent", async () => {
    const { auth, salbe, base, prodLine } = await setup();
    await expect(invoices.createInvoice(auth, { ...base, kind: "invoice", therapeuticConfirmed: false, lines: [prodLine(salbe, 1, { priceCents: 990 })] })).rejects.toThrow(/inzwischen geändert/);

    await products.bookReceipt(auth, { productId: salbe, quantity: 10, occurredOn: today });
    const [inv, sale] = await Promise.all([
      products.correctStock(auth, { productId: salbe, kind: "inventory", amount: 8 }),
      invoices.createInvoice(auth, { ...base, kind: "invoice", therapeuticConfirmed: false, lines: [prodLine(salbe, 3)] }),
    ]);
    expect(sale.totalCents).toBe(3 * 1290);
    const p = await products.getProduct(auth, salbe);
    // Reihenfolge egal, aber die Inventur sieht den Verkauf entweder ganz oder gar nicht
    expect([5, 8]).toContain(p!.stock);
    expect(inv.after).toBe(8);
    expect(p!.movements.reduce((s, m) => s + m.quantity, 0)).toBe(p!.stock);
  });

  it("Lagerbewegungen sind unveränderbar, Mandanten getrennt (RLS), keine fremden Bezüge", async () => {
    const a = await setup();
    const b = await setup();
    await products.bookReceipt(a.auth, { productId: a.salbe, quantity: 5, occurredOn: today });
    const mov = (await f.asOrg(a.org, (c) => c.query("select id from stock_movements where product_id = $1", [a.salbe]))).rows[0].id;
    await expect(f.asOrg(a.org, (c) => c.query("update stock_movements set quantity = 50 where id = $1", [mov]))).rejects.toThrow(/unveränderbar/);
    await expect(f.asOrg(a.org, (c) => c.query("delete from stock_movements where id = $1", [mov]))).rejects.toThrow(/unveränderbar/);

    for (const [table, id] of [
      ["products", a.salbe],
      ["suppliers", a.supplier],
      ["stock_movements", mov],
    ] as const) {
      expect((await f.asOrg(b.org, (c) => c.query(`select 1 from ${table} where id = $1`, [id]))).rowCount).toBe(0);
      expect((await f.pool.query(`select 1 from ${table} where id = $1`, [id])).rowCount).toBe(0); // ohne Mandant: nichts
      expect((await f.asOrg(a.org, (c) => c.query(`select 1 from ${table} where id = $1`, [id]))).rowCount).toBe(1);
    }
    // Schreiben in fremden Mandanten
    await expect(f.asOrg(b.org, (c) => c.query("insert into products (organization_id, name, price_cents) values ($1,'X',100)", [a.org]))).rejects.toThrow();
    // Bezug auf Produkt/Lieferant einer anderen Praxis
    await expect(
      f.asOrg(b.org, (c) => c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on) values ($1,$2,'receipt',1,current_date)", [b.org, a.salbe])),
    ).rejects.toThrow(/nicht zu dieser Praxis/);
    await expect(f.asOrg(b.org, (c) => c.query("update products set supplier_id = $2 where id = $1", [b.salbe, a.supplier]))).rejects.toThrow(/nicht zu dieser Praxis/);
    // Produkt einer anderen Praxis lässt sich nicht verkaufen
    await expect(invoices.createInvoice(b.auth, { ...b.base, kind: "invoice", lines: [b.prodLine(a.salbe, 1)] })).rejects.toThrow(/Produkt nicht gefunden/);
    expect(await products.getProduct(b.auth, a.salbe)).toBeNull();
    await expect(
      f.asOrg(a.org, (c) => c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on) values ($1,$2,'receipt',1000001,current_date)", [a.org, a.salbe])),
    ).rejects.toThrow(/stock_movements_quantity_check/);
    // Vorzeichen-Regel in der DB
    await expect(
      f.asOrg(a.org, (c) => c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on) values ($1,$2,'sale',-1,current_date)", [a.org, a.salbe])),
    ).rejects.toThrow(/stock_movements_quantity_check/);
  });
});
