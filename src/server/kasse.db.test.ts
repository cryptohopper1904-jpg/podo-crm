/** Kasse (Z-Bon): lückenlose Nummern auch parallel, Hash-Kette, Sperre abgeschlossener Tage, DSFinV-K (erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import JSZip from "jszip";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Kasse (DB)", () => {
  const f = fixtures(TEST_DB!);
  let kasse: typeof import("./kasse");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    delete process.env.TSE_PROVIDER;
    kasse = await import("./kasse");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const setup = async () => {
    const org = await f.org();
    const user = await f.user();
    const auth = { organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Anna Test" }, can: () => true } as never;
    const patient = await f.patient(org);
    const invoice = await f.invoice(org, patient, 100_000);
    const payment = (method: string, cents: number, paidAt: string) =>
      f.asOrg(org, async (c) => (await c.query("insert into payments (organization_id, invoice_id, method, amount_cents, paid_at, created_by) values ($1,$2,$3,$4,$5,$6) returning id", [org, invoice, method, cents, paidAt, user])).rows[0].id as string);
    const closings = () => f.asOrg(org, async (c) => (await c.query("select * from cash_closings where organization_id = $1 order by number", [org])).rows);
    return { org, user, auth, invoice, payment, closings };
  };
  const den = (cents: number) => ({ "1": cents });

  it("Z-Nummern bleiben unter Parallelität lückenlos, Hash-Kette ist gültig", async () => {
    const { auth, payment, org } = await setup();
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];
    for (const d of days) await payment("cash", 1000, `${d} 10:00+02`);
    const results = await Promise.allSettled(days.map((d) => kasse.closeDay(auth, { businessDate: d, denominations: den(0), openingCents: 0, differenceReason: "Test" })));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof kasse.closeDay>>> => r.status === "fulfilled").map((r) => r.value);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.map((r) => r.number).sort((a, b) => a - b)).toEqual(ok.map((_, i) => i + 1));
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(kasse.KasseError);

    // derselbe Tag parallel: genau ein Abschluss
    const same = await Promise.allSettled([1, 2, 3].map(() => kasse.closeDay(auth, { businessDate: "2026-10-20", denominations: den(0), differenceReason: "Test" })));
    expect(same.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const { cashClosings } = await import("@/db/schema");
    const { withOrg } = await import("@/db");
    const { asc, eq } = await import("drizzle-orm");
    const rows = await withOrg(org, (tx) => tx.select().from(cashClosings).where(eq(cashClosings.organizationId, org)).orderBy(asc(cashClosings.number)));
    expect(rows.map((r) => r.number)).toEqual(rows.map((_, i) => i + 1));
    expect(kasse.verifyClosingRows(rows)).toBe(-1);
    // Belegnummern lückenlos über alle Abschlüsse
    for (let i = 1; i < rows.length; i++) expect(rows[i].firstBonNr).toBe(rows[i - 1].lastBonNr + 1);
    // Manipulation (im Speicher) wird erkannt
    const tampered = rows.map((r, i) => (i === 0 ? { ...r, countedCashCents: r.countedCashCents + 1 } : r));
    expect(kasse.verifyClosingRows(tampered)).toBe(0);
    // alle Zahlungen sind genau einem Abschluss zugeordnet
    const open = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from payments where organization_id = $1 and cash_closing_id is null", [org])).rows[0].n);
    expect(open).toBe(0);
  });

  it("DB erzwingt Nummernfolge, Hash-Kette und Unveränderbarkeit der Abschlüsse", async () => {
    const { auth, org, closings } = await setup();
    const z1 = await kasse.closeDay(auth, { businessDate: "2026-09-01", denominations: den(2500), openingCents: 2500 });
    expect(z1.number).toBe(1);
    expect(z1.differenceCents).toBe(0);
    const [row] = await closings();
    const insert = (number: number, prevHash: string | null, date: string) =>
      f.asOrg(org, (c) =>
        c.query(
          `insert into cash_closings (organization_id, number, business_date, closed_at, opening_cents, cash_payments_cents, movements_cents, expected_cash_cents,
             counted_cash_cents, difference_cents, denominations, totals, payment_count, movement_count, first_bon_nr, last_bon_nr, items_digest, tse, prev_hash, hash)
           values ($1,$2,$3,now(),0,0,0,0,0,0,'{}','{}',0,0,1,0,'x','{"mode":"none"}',$4,'h')`,
          [org, number, date, prevHash],
        ),
      );
    await expect(insert(3, row.hash, "2026-09-02")).rejects.toThrow(/lückenlos/);
    await expect(insert(2, "falsch", "2026-09-02")).rejects.toThrow(/Hash-Kette/);
    await expect(insert(2, row.hash, "2026-08-31")).rejects.toThrow(/Buchungstag/);
    await expect(f.asOrg(org, (c) => c.query("update cash_closings set counted_cash_cents = 0 where organization_id = $1", [org]))).rejects.toThrow(/unveränderbar/);
    await expect(f.asOrg(org, (c) => c.query("delete from cash_closings where organization_id = $1", [org]))).rejects.toThrow(/unveränderbar/);
    // Differenz ohne Begründung wird abgelehnt
    await expect(kasse.closeDay(auth, { businessDate: "2026-09-02", denominations: den(100) })).rejects.toThrow(/Begründung/);
    // Zukunft nicht erlaubt
    await expect(kasse.closeDay(auth, { businessDate: "2999-01-01", denominations: den(0) })).rejects.toThrow(/Zukunft/);
  });

  it("Zahlungen eines abgeschlossenen Tages sind gesperrt; Nachzügler gehen in den nächsten Abschluss", async () => {
    const { auth, org, payment } = await setup();
    const p1 = await payment("cash", 6500, "2026-08-10 09:00+02");
    const pOpen = await payment("card", 2000, "2026-08-12 09:00+02");
    const z = await kasse.closeDay(auth, { businessDate: "2026-08-10", denominations: den(16500), openingCents: 10000 });
    expect(z.cashPaymentsCents).toBe(6500);
    expect(z.paymentCount).toBe(1);
    const q = (sqlText: string, params: unknown[]) => f.asOrg(org, (c) => c.query(sqlText, params));

    await expect(q("update payments set amount_cents = 1 where id = $1", [p1])).rejects.toThrow(/unveränderbar/);
    await expect(q("update payments set cash_closing_id = null where id = $1", [p1])).rejects.toThrow(/unveränderbar/);
    await expect(q("delete from payments where id = $1", [p1])).rejects.toThrow(/gelöscht/);
    // nicht abgeschlossener Tag: änderbar, aber nicht in einen abgeschlossenen Tag verschiebbar
    await q("update payments set external_ref = 'x' where id = $1", [pOpen]);
    await expect(q("update payments set paid_at = '2026-08-10 12:00+02' where id = $1", [pOpen])).rejects.toThrow(/unveränderbar/);
    // neue Zahlung mit Abschluss-Zuordnung ist verboten
    await expect(q("insert into payments (organization_id, invoice_id, method, amount_cents, cash_closing_id) select organization_id, invoice_id, 'cash', 1, $2 from payments where id = $1", [p1, z.id])).rejects.toThrow(/keinem Kassenabschluss/);

    // Nachzügler (z. B. verspäteter Webhook) am abgeschlossenen Tag: anlegen ok, aber sofort gesperrt
    const late = await payment("card", 3000, "2026-08-10 17:59+02");
    await expect(q("update payments set amount_cents = 1 where id = $1", [late])).rejects.toThrow(/unveränderbar/);
    await expect(q("delete from payments where id = $1", [late])).rejects.toThrow(/gelöscht/);

    // Serverseitige Prüfung
    const { withOrg } = await import("@/db");
    await expect(withOrg(org, (tx) => kasse.assertPaymentsEditable(tx, org, [late]))).rejects.toThrow(/abgeschlossenen Kassentags/);
    await withOrg(org, (tx) => kasse.assertPaymentsEditable(tx, org, [pOpen]));

    // Kassenbuch
    const mv = await kasse.addCashMovement(auth, { kind: "payout", amountCents: 480, reason: "Porto" });
    expect(mv.amountCents).toBe(-480);
    await expect(q("update cash_movements set reason = 'x' where id = $1", [mv.id])).rejects.toThrow(/unveränderbar/);
    await expect(q("delete from cash_movements where id = $1", [mv.id])).rejects.toThrow(/nicht gelöscht/);
    await expect(q("insert into cash_movements (organization_id, kind, amount_cents, reason) values ($1, 'payout', 100, 'falsches Vorzeichen')", [org])).rejects.toThrow();

    // Kassenbuch-Eintrag entstand „jetzt“ → Abschluss für heute
    const { berlinDateIso } = await import("@/lib/format");
    const z2 = await kasse.closeDay(auth, { businessDate: berlinDateIso(), denominations: den(16020) });
    expect(z2.number).toBe(2);
    expect(z2.openingCents).toBe(16500);
    expect(z2.paymentCount).toBe(2); // pOpen + Nachzügler
    expect(z2.movementCount).toBe(1);
    expect(z2.expectedCashCents).toBe(16500 - 480);
    expect(z2.totals.byMethod).toEqual({ card: 5000 });
    await expect(q("update payments set external_ref = 'y' where id = $1", [pOpen])).rejects.toThrow(/unveränderbar/);

    // Ansicht: Kette + Zuordnung geprüft
    const view = await kasse.getClosing(auth, z2.id);
    expect(view!.chainOk).toBe(true);
    expect(view!.digestOk).toBe(true);
    const pdf = await kasse.zBonPdfForOrg(org, z2.id);
    expect(Buffer.from(pdf!.bytes).subarray(0, 5).toString()).toBe("%PDF-");

    // DSFinV-K: Summen passen zum Abschluss
    const exp = await kasse.buildDsfinvkExport(auth, "2026-08-01", berlinDateIso());
    expect(exp.closings).toBe(2);
    const zip = await JSZip.loadAsync(exp.bytes);
    const tx = (await zip.file("transactions.csv")!.async("string")).trim().split("\r\n");
    // Z1: Anfangsbestand + Bar; Z2: 2× Karte + Auszahlung + Differenz (0 → keine)
    expect(tx).toHaveLength(1 + 2 + 3);
    const cash = (await zip.file("cash_per_currency.csv")!.async("string")).trim().split("\r\n").slice(1).map((l) => l.split(";").pop());
    expect(cash).toEqual(["165,00", "-4,80"]);
  });

  it("Mandantentrennung: fremde Abschlüsse sind unsichtbar", async () => {
    const a = await setup();
    const b = await setup();
    const z = await kasse.closeDay(a.auth, { businessDate: "2026-07-01", denominations: den(0) });
    expect(await kasse.getClosing(b.auth, z.id)).toBeNull();
    const n = await f.asOrg(b.org, async (c) => (await c.query("select count(*)::int as n from cash_closings where id = $1", [z.id])).rows[0].n);
    expect(n).toBe(0);
  });
});
