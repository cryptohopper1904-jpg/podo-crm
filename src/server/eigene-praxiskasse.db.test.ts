/**
 * Eigene Praxiskasse: Kennzeichnung je Zahlung (payments.register, Migration 0063), Auswertung der Kennzeichnung statt
 * der aktuellen Einstellung, Umschalt-Sperre, keine zweite Kasse, Bon-Nr. der Praxiskasse, SumUp-Hinweis, Kassenvermerke.
 * Echte DB, erfundene Daten.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Eigene Praxiskasse (DB)", () => {
  const f = fixtures(TEST_DB!);
  let kasse: typeof import("./kasse");
  let invoices: typeof import("./invoices");
  let webhooks: typeof import("./webhooks");
  let receipts: typeof import("./payment-receipts");
  let withOrg: typeof import("@/db").withOrg;
  let today: string;
  const REASON = "Testkasse Modell X, TSE-Seriennummer 0000-TEST";

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.TSE_PROVIDER;
    kasse = await import("./kasse");
    invoices = await import("./invoices");
    webhooks = await import("./webhooks");
    receipts = await import("./payment-receipts");
    withOrg = (await import("@/db")).withOrg;
    today = (await import("@/lib/format")).berlinDateIso();
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const setup = async () => {
    const org = await f.org();
    const user = await f.user(org);
    const auth = { organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Anna Test" }, can: () => true } as never;
    const patient = await f.patient(org);
    const invoice = () => f.invoice(org, patient, 100_000);
    const q = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => f.asOrg(org, async (c) => (await c.query(text, params)).rows as T[]);
    const pays = (invoiceId: string) =>
      q<{ id: string; method: string; register: string; external_ref: string | null; cash_closing_id: string | null }>(
        "select id, method, register, external_ref, cash_closing_id from payments where invoice_id = $1 order by paid_at, id",
        [invoiceId],
      );
    return { org, user, auth, patient, invoice, q, pays };
  };
  const den = (cents: number) => ({ "1": cents });

  it("Kennzeichnung je Zahlung: Server setzt register='external' für Bar/Karte/Gutschein; Spalte danach unveränderlich", async () => {
    const { auth, invoice, q, pays, org } = await setup();
    const inv = await invoice();
    // vorher: PodoHero-Kasse
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 1000 }]);
    await kasse.closeDay(auth, { businessDate: today, denominations: den(1000), openingCents: 0 });
    await kasse.setExternalRegister(auth, true, REASON);
    await invoices.addPayments(auth, inv, [
      { method: "cash", amountCents: 2000 },
      { method: "card", amountCents: 3000 },
      { method: "transfer", amountCents: 500 },
    ]);
    const rows = await pays(inv);
    expect(rows[0]).toMatchObject({ method: "cash", register: "podohero" });
    expect(rows.slice(1).map((r) => [r.method, r.register]).sort()).toEqual([
      ["card", "external"],
      ["cash", "external"],
      // Überweisung ist kein Kassenvorgang – bleibt wie bisher
      ["transfer", "podohero"],
    ]);
    const extCash = rows.find((r) => r.method === "cash" && r.register === "external")!;
    // keine PodoHero-TSE-Signatur für die Vermerke
    const sigs = await q<{ n: number }>("select count(*)::int as n from fiscal_transactions where payment_id = any($1)", [rows.filter((r) => r.register === "external").map((r) => r.id)]);
    expect(sigs[0].n).toBe(0);
    // CHECK auf erlaubte Werte (Unveränderlichkeit: siehe Test „Bon-Nr.“ – hier ist der Tag bereits abgeschlossen)
    await expect(q("insert into payments (organization_id, invoice_id, method, amount_cents, register) values ($1,$2,'cash',1,'irgendwas')", [org, inv])).rejects.toThrow(/payments_register_check/);
    // DB-Trigger (Guard 0060/0063): Vermerk nie einem PodoHero-Abschluss zuordnen
    const closingId = rows[0].cash_closing_id;
    expect(closingId).toBeTruthy();
    await expect(q("update payments set cash_closing_id = $2 where id = $1", [extCash.id, closingId])).rejects.toThrow(/Praxiskasse kommen in keinen/);
    // Client kann register nicht setzen (Feld unbekannt → ignoriert, Server entscheidet)
    await kasse.setExternalRegister(auth, false, REASON);
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 100, register: "external" } as never]);
    const last = (await pays(inv)).at(-1)!;
    expect(last.register).toBe("podohero");
  });

  it("Regression: einschalten → Barzahlung → ausschalten → closeDay: Zahlung nicht im Z-Bon, kein „Beleg fehlt“", async () => {
    const { auth, invoice, pays, org } = await setup();
    const inv = await invoice();
    await kasse.setExternalRegister(auth, true, REASON);
    const r = await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 2500 }]);
    expect(r.receipts).toEqual([]);
    await kasse.setExternalRegister(auth, false, REASON);
    const ov = await kasse.kasseOverview(auth);
    expect(ov.calc.cashPaymentsCents).toBe(0);
    const z = await kasse.closeDay(auth, { businessDate: today, denominations: den(0), openingCents: 0 });
    expect(z.paymentCount).toBe(0);
    expect(z.cashPaymentsCents).toBe(0);
    const [p] = await pays(inv);
    expect(p.register).toBe("external");
    expect(p.cash_closing_id).toBeNull();
    // Kennzeichnung entscheidet, nicht die (jetzt ausgeschaltete) Einstellung
    expect(await withOrg(org, (tx) => receipts.paymentsMissingReceipt(tx, org, inv))).toEqual([]);
    await expect(withOrg(org, (tx) => receipts.recordPaymentReceipts(tx, org, inv, [p.id], null, { belated: true }))).resolves.toEqual([]);
  });

  it("Regression umgekehrt: PodoHero-Zahlung vor dem Einschalten bleibt mit fehlendem Beleg sichtbar", async () => {
    const { auth, invoice, q, org, user } = await setup();
    const inv = await invoice();
    // PodoHero-Barzahlung ohne Zahlungsbeleg (z. B. Anlegen des Belegs gescheitert)
    const [{ id }] = await q<{ id: string }>("insert into payments (organization_id, invoice_id, method, amount_cents, created_by) values ($1,$2,'cash',1500,$3) returning id", [org, inv, user]);
    await q("update invoices set paid_cents = 1500, status = 'partially_paid' where id = $1", [inv]);
    await kasse.closeDay(auth, { businessDate: today, denominations: den(1500), openingCents: 0 });
    await kasse.setExternalRegister(auth, true, REASON);
    const missing = await withOrg(org, (tx) => receipts.paymentsMissingReceipt(tx, org, inv));
    expect(missing.map((m) => m.id)).toEqual([id]);
    // und lässt sich nachträglich belegen (Nummernkreis ZB), obwohl die Praxis jetzt die eigene Kasse nutzt
    const made = await withOrg(org, (tx) => receipts.recordPaymentReceipts(tx, org, inv, [id], null, { belated: true }));
    expect(made).toHaveLength(1);
  });

  it("Umschalt-Sperre: nur ohne offene PodoHero-Kassenzahlungen/-bewegungen; Audit mit from/to/offenePosten/Grund", async () => {
    const { auth, invoice, q, org } = await setup();
    const inv = await invoice();
    await invoices.addPayments(auth, inv, [{ method: "card", amountCents: 1200 }]);
    await expect(kasse.setExternalRegister(auth, true, REASON)).rejects.toThrow("Bitte zuerst den Tagesabschluss machen.");
    await kasse.closeDay(auth, { businessDate: today, denominations: den(0), openingCents: 0 });
    // Grund ist Pflicht (3–200 Zeichen, keine Formel)
    await expect(kasse.setExternalRegister(auth, true, "x")).rejects.toThrow(kasse.KasseError);
    await expect(kasse.setExternalRegister(auth, true, "=SUMME(A1)")).rejects.toThrow(kasse.KasseError);
    await expect(kasse.setExternalRegister(auth, true, "x".repeat(201))).rejects.toThrow(kasse.KasseError);
    // offene Einlage (Kassenbuch) sperrt ebenfalls – eigene Praxis, damit der Tag dort noch offen ist
    const other = await setup();
    await kasse.addCashMovement(other.auth, { kind: "private_deposit", amountCents: 5000, reason: "Wechselgeld" } as never);
    await expect(kasse.setExternalRegister(other.auth, true, REASON)).rejects.toThrow("Bitte zuerst den Tagesabschluss machen.");
    await kasse.setExternalRegister(auth, true, REASON);
    const log = await q<{ meta: Record<string, unknown> }>("select meta from audit_log where organization_id = $1 and action = 'kasse.external_register'", [org]);
    expect(log).toHaveLength(1);
    expect(log[0].meta).toMatchObject({ from: "podohero", to: "external", offenePosten: 0, reason: REASON });
    // externer Modus: keine zweite Kasse – Einlagen/Entnahmen und Tagesabschluss gesperrt (Server)
    await expect(kasse.addCashMovement(auth, { kind: "private_deposit", amountCents: 100, reason: "Wechselgeld" } as never)).rejects.toThrow(/Praxiskasse/);
    await expect(kasse.closeDay(auth, { businessDate: today, denominations: den(0) })).rejects.toThrow(/Praxiskasse/);
    // zurück: ohne offene PodoHero-Posten möglich, protokolliert
    await kasse.setExternalRegister(auth, false, REASON);
    const log2 = await q<{ meta: Record<string, unknown> }>("select meta from audit_log where organization_id = $1 and action = 'kasse.external_register' order by id", [org]);
    expect(log2.at(-1)!.meta).toMatchObject({ from: "external", to: "podohero", offenePosten: 0 });
    // gleicher Zustand: keine Änderung, kein weiterer Eintrag
    await kasse.setExternalRegister(auth, false, REASON);
    expect(await q("select 1 from audit_log where organization_id = $1 and action = 'kasse.external_register'", [org])).toHaveLength(2);
  });

  it("Umschalt-Sperre unter Parallelität: Zahlung und Umschalten serialisiert – nie eine offene PodoHero-Zahlung im externen Modus", async () => {
    const { auth, invoice, q, org } = await setup();
    const inv = await invoice();
    const results = await Promise.allSettled([
      invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 700 }]),
      kasse.setExternalRegister(auth, true, REASON),
    ]);
    const external = (await q<{ s: boolean }>("select coalesce((settings->>'externalCashRegister')::boolean, false) as s from organizations where id = $1", [org]))[0].s;
    const open = await q("select 1 from payments where organization_id = $1 and register = 'podohero' and cash_closing_id is null", [org]);
    // entweder Umschalten zuerst (Zahlung ist Vermerk) oder Zahlung zuerst (Umschalten abgelehnt)
    if (external) expect(open).toHaveLength(0);
    else expect(results[1].status).toBe("rejected");
  });

  it("Bon-Nr. der Praxiskasse: Präfix praxiskasse: vergibt der Server; Eingaben geprüft", async () => {
    const { auth, invoice, pays, q } = await setup();
    const inv = await invoice();
    // ohne eigene Praxiskasse keine Bon-Nr.
    await expect(invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 100, registerReceiptNo: "4711" }])).rejects.toThrow(/Bon-Nr/);
    await kasse.setExternalRegister(auth, true, REASON);
    // Client darf das Präfix nicht selbst senden (wie tse:/sumup:/excel:)
    await expect(invoices.addPayments(auth, inv, [{ method: "transfer", amountCents: 100, externalRef: " Praxiskasse:4711" }])).rejects.toThrow(/praxiskasse:/);
    await expect(invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 100, registerReceiptNo: "47 11" }])).rejects.toThrow();
    await expect(invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 100, registerReceiptNo: "1".repeat(41) }])).rejects.toThrow();
    // Bon-Nr. nur bei Kassenvorgängen
    await expect(invoices.addPayments(auth, inv, [{ method: "transfer", amountCents: 100, registerReceiptNo: "4711" }])).rejects.toThrow(/Bon-Nr/);
    await invoices.addPayments(auth, inv, [
      { method: "cash", amountCents: 1000, registerReceiptNo: "Z-17/0815" },
      { method: "card", amountCents: 500 },
    ]);
    const rows = await pays(inv);
    expect(rows.map((r) => [r.method, r.register, r.external_ref]).sort()).toEqual([
      ["card", "external", null],
      ["cash", "external", "praxiskasse:Z-17/0815"],
    ]);
    // DB-Trigger: register nicht änderbar (weder hin noch zurück); external_ref bleibt änderbar wie bisher
    await expect(q("update payments set register = 'podohero' where id = $1", [rows[0].id])).rejects.toThrow(/Kassensystem einer Zahlung ist unveränderlich/);
    await kasse.setExternalRegister(auth, false, REASON);
    await invoices.addPayments(auth, inv, [{ method: "transfer", amountCents: 100 }]);
    const transfer = (await pays(inv)).find((r) => r.method === "transfer")!;
    expect(transfer.register).toBe("podohero");
    await expect(q("update payments set register = 'external' where id = $1", [transfer.id])).rejects.toThrow(/Kassensystem einer Zahlung ist unveränderlich/);
  });

  it("SumUp im externen Modus: register='external', external_ref bleibt sumup:…, Posteingang-Meldung je Eingang", async () => {
    const { auth, invoice, pays, q, org } = await setup();
    const inv = await invoice();
    await kasse.setExternalRegister(auth, true, REASON);
    const ref = `sumup:t-ext-${inv}`;
    const r = await webhooks.recordProviderPayment(org, { invoiceId: inv, externalRef: ref, amountCents: 4200, method: "card" });
    expect(r.status).toBe("gebucht");
    const [p] = await pays(inv);
    expect([p.register, p.external_ref]).toEqual(["external", ref]);
    expect(await q("select 1 from fiscal_transactions where payment_id = $1", [p.id])).toHaveLength(0);
    expect(await q("select 1 from payment_receipts where payment_id = $1", [p.id])).toHaveLength(0);
    const msgs = await q<{ subject: string; body: string }>("select subject, body from messages where organization_id = $1 and thread_key like 'praxiskasse:%'", [org]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].subject).toMatch(/Kartenzahlung .*bitte in der Praxiskasse erfassen/);
    expect(msgs[0].body).toContain("42,00");
    // erneute Zustellung: nicht doppelt gebucht, keine zweite Meldung
    expect((await webhooks.recordProviderPayment(org, { invoiceId: inv, externalRef: ref, amountCents: 4200, method: "card" })).status).toBe("bereits gebucht");
    expect(await q("select 1 from messages where organization_id = $1 and thread_key like 'praxiskasse:%'", [org])).toHaveLength(1);
  });

  it("Kassenvermerke: Liste mit Tagessumme je Zahlart und CSV (nur register='external')", async () => {
    const { auth, invoice, org } = await setup();
    const inv = await invoice();
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 999 }]);
    await kasse.closeDay(auth, { businessDate: today, denominations: den(999), openingCents: 0 });
    await kasse.setExternalRegister(auth, true, REASON);
    await invoices.addPayments(auth, inv, [
      { method: "cash", amountCents: 1000, registerReceiptNo: "B-1" },
      { method: "cash", amountCents: 250 },
      { method: "card", amountCents: 3000, registerReceiptNo: "B-2" },
      { method: "transfer", amountCents: 100 },
    ]);
    const list = await kasse.externalRegisterEntries(auth, today, today);
    expect(list.entries.map((e) => [e.method, e.amountCents, e.bonNr]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      ["cash", 250, null],
      ["cash", 1000, "B-1"],
      ["card", 3000, "B-2"],
    ]);
    expect(list.days).toEqual([{ date: today, byMethod: { cash: 1250, card: 3000 }, totalCents: 4250 }]);
    const csv = await kasse.externalRegisterCsv(auth, today, today);
    expect(csv.filename).toMatch(/^kassenvermerke-.*\.csv$/);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Datum;Uhrzeit;Rechnungsnummer;Zahlart;Betrag;Bon-Nr. Praxiskasse");
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.endsWith(";Bar;10,00;B-1"))).toBe(true);
    // andere Praxis sieht nichts (RLS/withOrg)
    const other = await setup();
    expect((await kasse.externalRegisterEntries(other.auth, today, today)).entries).toEqual([]);
    void org;
  });

  it("Support-Zugang darf die eigene Praxiskasse nicht umschalten (AppSec H1)", async () => {
    const { org, user } = await setup();
    const support = { organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Support" }, can: () => true, support: { grantId: "x" } } as never;
    await expect(kasse.setExternalRegister(support, true, REASON)).rejects.toThrow(/Support/);
    const s = await f.asOrg(org, async (c) => (await c.query("select settings from organizations where id = $1", [org])).rows[0].settings);
    expect(s?.externalCashRegister).toBeUndefined();
  });

  it("CSV: negative Beträge als Zahl (kein Apostroph), Freitext weiter neutralisiert; Bon-Nr. nicht mit „-“ am Anfang", async () => {
    const { auth, invoice, org, user, q } = await setup();
    const inv = await invoice();
    await kasse.setExternalRegister(auth, true, REASON);
    await expect(invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 100, registerReceiptNo: "-12" }])).rejects.toThrow(/Bon-Nr/);
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 3000, registerReceiptNo: "B-7" }]);
    // Erstattung (negativ) als Vermerk auf einer Altrechnung, deren Nummer mit einem Formelzeichen beginnt
    const legacy = await f.asOrg(org, async (c) => {
      const id = (await c.query("insert into invoices (organization_id, status, source) values ($1,'draft','excel-import') returning id", [org])).rows[0].id as string;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Altbestand',1250,1250,0,1)", [org, id]);
      await c.query("update invoices set status='paid', number='=1+2', issued_at=current_date, total_cents=1250, net_cents=1250, paid_cents=1250 where id=$1", [id]);
      return id;
    });
    await q("insert into payments (organization_id, invoice_id, method, amount_cents, register, created_by) values ($1,$2,'cash',-1250,'external',$3)", [org, legacy, user]);
    const csv = await kasse.externalRegisterCsv(auth, today, today);
    const lines = csv.text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines.some((l) => l.endsWith(";'=1+2;Bar;-12,50;"))).toBe(true);
    expect(lines.some((l) => l.endsWith(";Bar;30,00;B-7"))).toBe(true);
    expect(csv.text).not.toContain("'-12,50");
  });

  it("CSV: mehr als 5000 Vermerke → Fehler „Zeitraum verkleinern“ statt still abzuschneiden (AppSec H2)", async () => {
    const { auth, invoice, org, user, q } = await setup();
    const inv = await invoice();
    await q("insert into payments (organization_id, invoice_id, method, amount_cents, register, created_by) select $1, $2, 'cash', 1, 'external', $3 from generate_series(1, 5001)", [org, inv, user]);
    await expect(kasse.externalRegisterCsv(auth, today, today)).rejects.toThrow(/Zeitraum verkleinern/);
    expect((await kasse.externalRegisterEntries(auth, today, today)).truncated).toBe(true);
  });

  it("Erstattung Fall A: Zahlung in der Praxiskasse, zurückgeschaltet → Erstattung folgt der Einstellung (PodoHero, signiert)", async () => {
    const { auth, invoice, q } = await setup();
    const inv = await invoice();
    await kasse.setExternalRegister(auth, true, REASON);
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 2000 }]);
    await kasse.setExternalRegister(auth, false, REASON);
    const credit = await invoices.cancelInvoice(auth, inv, "Doppelt erstellt");
    await invoices.addPayments(auth, credit.id, [{ method: "cash", amountCents: -2000 }]);
    const [refund] = await q<{ id: string; register: string; amount_cents: number }>("select id, register, amount_cents from payments where invoice_id = $1", [credit.id]);
    expect(refund).toMatchObject({ register: "podohero", amount_cents: -2000 });
    expect(await q("select 1 from fiscal_transactions where payment_id = $1", [refund.id])).toHaveLength(1);
    expect((await kasse.kasseOverview(auth)).calc.cashPaymentsCents).toBe(-2000);
  });

  it("Erstattung Fall B: Zahlung über die PodoHero-Kasse, umgeschaltet → Erstattung ist Vermerk (extern, ohne Signatur/Beleg)", async () => {
    const { auth, invoice, q } = await setup();
    const inv = await invoice();
    await invoices.addPayments(auth, inv, [{ method: "cash", amountCents: 2000 }]);
    await kasse.closeDay(auth, { businessDate: today, denominations: den(2000), openingCents: 0 });
    await kasse.setExternalRegister(auth, true, REASON);
    const credit = await invoices.cancelInvoice(auth, inv, "Doppelt erstellt");
    const r = await invoices.addPayments(auth, credit.id, [{ method: "cash", amountCents: -2000, registerReceiptNo: "S-1" }]);
    expect(r.receipts).toEqual([]);
    const [refund] = await q<{ id: string; register: string; external_ref: string }>("select id, register, external_ref from payments where invoice_id = $1", [credit.id]);
    expect(refund).toMatchObject({ register: "external", external_ref: "praxiskasse:S-1" });
    expect(await q("select 1 from fiscal_transactions where payment_id = $1", [refund.id])).toHaveLength(0);
  });

  it("Gutschein-Einlösung im externen Modus: Vermerk, Restguthaben korrekt, kein Zahlungsbeleg", async () => {
    const { auth, invoice, q, org } = await setup();
    const inv = await invoice();
    const code = `G-EXT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await q("insert into vouchers (organization_id, code, issued_at, valid_until, amount_cents) values ($1,$2,current_date, current_date + 365, 5000)", [org, code]);
    await kasse.setExternalRegister(auth, true, REASON);
    const r = await invoices.addPayments(auth, inv, [{ method: "voucher", amountCents: 3000, voucherCode: code }]);
    expect(r.receipts).toEqual([]);
    const [p] = await q<{ id: string; register: string }>("select id, register from payments where invoice_id = $1", [inv]);
    expect(p.register).toBe("external");
    expect(await q("select 1 from payment_receipts where payment_id = $1", [p.id])).toHaveLength(0);
    expect(await q("select 1 from fiscal_transactions where payment_id = $1", [p.id])).toHaveLength(0);
    // Restguthaben 20 €: 25 € abgelehnt, 20 € möglich
    await expect(invoices.addPayments(auth, inv, [{ method: "voucher", amountCents: 2500, voucherCode: code }])).rejects.toThrow(/Restguthaben/);
    await invoices.addPayments(auth, inv, [{ method: "voucher", amountCents: 2000, voucherCode: code }]);
  });
});
