/**
 * Auswertung & Statistik (DB): Aggregate in SQL, Berliner Ortszeit inkl. Sommerzeit, Median-Vorlauf,
 * Mandantentrennung und keine Doppelzählung von Quittungen/Anzahlungen (erfundene Daten).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { berlinWeekdayHour, median, resolvePeriod } from "@/lib/stats";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Statistik (DB)", () => {
  const f = fixtures(TEST_DB!);
  let stats: typeof import("./stats");
  let finance: typeof import("./finance");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    stats = await import("./stats");
    finance = await import("./finance");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authOf = (org: string, user: string) => ({ organization: { id: org, name: "T", slug: "t", smallBusiness: false }, user: { id: user, name: "Test" }, support: null, can: () => true }) as never;
  const march = resolvePeriod({ zeitraum: "frei", von: "2026-03-01", bis: "2026-03-31" }, "2026-11-13");
  const year = resolvePeriod({ zeitraum: "frei", von: "2026-01-01", bis: "2026-12-31" }, "2026-11-13");

  type Appt = { startsAt: string; createdAt: string; status?: string; source?: string; patient?: string | null; therapist?: string | null };
  const appt = (org: string, a: Appt) =>
    f.asOrg(org, (c) =>
      c.query(
        "insert into appointments (organization_id, patient_id, therapist_id, starts_at, ends_at, status, source, created_at) values ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '45 minutes',$5,$6,$7)",
        [org, a.patient ?? null, a.therapist ?? null, a.startsAt, a.status ?? "planned", a.source ?? "manual", a.createdAt],
      ),
    );

  it("Termine: Belegung je Wochentag × Stunde in Berliner Ortszeit (Sommerzeit), Quoten, Vorlauf-Median, neue Patient:innen", async () => {
    const org = await f.org();
    const other = await f.org();
    const user = await f.user();
    const therapist = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, therapist]).catch(() => undefined);
    const p1 = await f.patient(org, { lastName: "Alt" });
    const p2 = await f.patient(org, { lastName: "Neu" });
    const p3 = await f.patient(org, { lastName: "Doku" });

    // P1: schon 2025 da → wiederkehrend
    await appt(org, { startsAt: "2025-06-02 09:00+02", createdAt: "2025-05-01 09:00+02", status: "done", patient: p1 });
    // P3: Behandlung 2025 dokumentiert, aber kein Termin → trotzdem wiederkehrend
    await f.asOrg(org, (c) =>
      c.query("insert into treatment_records (organization_id, patient_id, author_id, treated_at, hash) values ($1,$2,$3,'2025-02-01 10:00+01','h')", [org, p3, user]),
    );

    const rows: (Appt & { lead: number | null })[] = [
      // Mo 23.03. 09:30 MEZ, online, 7 Tage Vorlauf
      { startsAt: "2026-03-23 09:30+01", createdAt: "2026-03-16 09:30+01", status: "done", source: "online", patient: p1, therapist, lead: 168 },
      // Mo 23.03. 09:45, nachgetragen (Anlage nach Beginn) → kein Vorlauf
      { startsAt: "2026-03-23 09:45+01", createdAt: "2026-03-23 12:00+01", status: "done", patient: p2, lead: null },
      // abgesagt → nur in „insgesamt“/Absagequote
      { startsAt: "2026-03-23 09:15+01", createdAt: "2026-03-01 09:00+01", status: "cancelled", source: "online", patient: p2, lead: null },
      // So 29.03. 01:30 UTC = 03:30 MESZ (Tag der Umstellung)
      { startsAt: "2026-03-29 01:30+00", createdAt: "2026-03-28 01:30+00", source: "phone", patient: p2, therapist, lead: 24 },
      // Di 24.03. 10:00, Kalender-Abo-Import → zählt, aber ohne Vorlauf; nicht erschienen
      { startsAt: "2026-03-24 10:00+01", createdAt: "2026-03-01 10:00+01", status: "no_show", source: "extern", patient: p3, lead: null },
      // Do 26.03. 14:00 – vier Termine mit 10/20/40/50 h Vorlauf → Median 30 h
      ...[10, 20, 40, 50].map((h) => ({
        startsAt: "2026-03-26 14:00+01",
        createdAt: new Date(new Date("2026-03-26T13:00:00Z").getTime() - h * 3_600_000).toISOString(),
        source: "portal",
        lead: h,
      })),
    ];
    for (const r of rows) await appt(org, r);
    // Termin im Zeitraum, aber außerhalb (April) und in einer anderen Praxis → nicht mitzählen
    await appt(org, { startsAt: "2026-04-01 00:30+02", createdAt: "2026-03-01 10:00+01", patient: p1 });
    await appt(other, { startsAt: "2026-03-23 09:30+01", createdAt: "2026-03-01 10:00+01", source: "online" });

    const s = await stats.appointmentStats(authOf(org, user), march);
    expect(s.total).toBe(rows.length);
    expect(s.cancelled).toBe(1);
    expect(s.noShow).toBe(1);
    expect(s.done).toBe(2);
    expect(s.booked).toBe(rows.length - 1);
    expect(s.online).toBe(1 + 4); // online + Portal (ohne die Absage)

    // Bucketing stimmt mit der Berliner Ortszeit (JS, Intl) überein – auch am Umstellungstag
    const expected = new Map<string, number>();
    for (const r of rows.filter((x) => x.status !== "cancelled")) {
      const b = berlinWeekdayHour(new Date(r.startsAt.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")));
      expected.set(`${b.isodow}-${b.hour}`, (expected.get(`${b.isodow}-${b.hour}`) ?? 0) + 1);
    }
    expect(new Map(s.slots.map((x) => [`${x.isodow}-${x.hour}`, x.value]))).toEqual(expected);
    expect(s.slots.find((x) => x.isodow === 7)?.hour).toBe(3);

    // Median-Vorlauf: SQL (percentile_cont) = JS-Median
    const thu = s.slots.find((x) => x.isodow === 4 && x.hour === 14)!;
    expect(thu.leadCount).toBe(4);
    expect(thu.lead).toBeCloseTo(median([10, 20, 40, 50])!, 6);
    const mon = s.slots.find((x) => x.isodow === 1 && x.hour === 9)!;
    expect(mon.value).toBe(2);
    expect(mon.leadCount).toBe(1);
    expect(mon.lead).toBeCloseTo(168, 6);
    const leads = rows.filter((r) => r.status !== "cancelled" && r.lead !== null).map((r) => r.lead!);
    expect(s.leadCount).toBe(leads.length);
    expect(s.leadMedian).toBeCloseTo(median(leads)!, 6);
    expect(s.weekdayCounts).toEqual([2, 1, 0, 4, 0, 0, 1]);
    expect(s.weekdayLead[3]).toBeCloseTo(30, 6);
    expect(s.topDates[0]).toEqual({ date: "2026-03-26", count: 4 });

    // Patient:innen: P1 und P3 wiederkehrend, P2 neu (der Termin ohne Person zählt nicht)
    expect(s.patients).toEqual({ total: 3, new: 1, returning: 2 });

    // Filter Behandler:in
    const t = await stats.appointmentStats(authOf(org, user), march, therapist);
    expect(t.total).toBe(2);
    expect(t.patients).toEqual({ total: 2, new: 1, returning: 1 });

    // andere Praxis sieht nur ihren einen Termin (Mandantentrennung)
    const o = await stats.appointmentStats(authOf(other, user), march);
    expect(o.total).toBe(1);
    expect(o.patients.total).toBe(0);
  });

  it("Leistungen/Produkte/Umsatz: angerechnete Quittungen und Anzahlungen nur einmal, konsistent mit financeOverview, mandantengetrennt", async () => {
    const org = await f.org();
    const other = await f.org();
    const user = await f.user();
    const patient = await f.patient(org);
    let seq = 0;
    const ids = await f.asOrg(org, async (c) => {
      const svc = (await c.query("insert into services (organization_id, code, name, price_cents) values ($1,'PK','Podologische Komplexbehandlung',5000) returning id", [org])).rows[0].id as string;
      const prod = (await c.query("insert into products (organization_id, name, price_cents, track_stock, min_stock) values ($1,'Fußcreme Urea 10 %',1500,true,5) returning id", [org])).rows[0].id as string;
      const low = (await c.query("insert into products (organization_id, name, price_cents, track_stock, min_stock) values ($1,'Hornhautsalbe',900,true,5) returning id", [org])).rows[0].id as string;
      return { svc, prod, low };
    });

    type Line = { total: number; qty?: number; service?: string | null; product?: string | null; inTreatment?: boolean; kind?: "service" | "product" };
    const invoice = (o: string, kind: string, status: string, issuedAt: string, lines: Line[], paid = 0) =>
      f.asOrg(o, async (c) => {
        const id = (await c.query("insert into invoices (organization_id, patient_id, kind, status) values ($1,$2,$3,'draft') returning id", [o, o === org ? patient : null, kind])).rows[0].id as string;
        let pos = 0;
        for (const l of lines)
          await c.query(
            "insert into invoice_lines (organization_id, invoice_id, description, quantity, unit_price_cents, total_cents, service_id, product_id, line_kind, in_treatment, treatment_position, position) values ($1,$2,'Position',$3,$4,$4,$5,$6,$7,$8,$9,$10)",
            [o, id, l.qty ?? 1, l.total, l.service ?? null, l.product ?? null, l.kind ?? (l.product ? "product" : "service"), l.inTreatment ?? false, l.inTreatment ? 1 : null, ++pos],
          );
        const total = lines.reduce((s, l) => s + l.total, 0);
        await c.query("update invoices set status=$2, number=$3, issued_at=$4, due_at=$4, total_cents=$5, net_cents=$5, paid_cents=$6 where id=$1", [id, status, `S${++seq}-${Math.random().toString(36).slice(2, 8)}`, issuedAt, total, paid]);
        return id;
      });
    const pay = (o: string, invoiceId: string, cents: number, at: string) =>
      f.asOrg(o, (c) => c.query("insert into payments (organization_id, invoice_id, method, amount_cents, paid_at, created_by) values ($1,$2,'cash',$3,$4,$5)", [o, invoiceId, cents, at, user]));

    // Quittung 50 € bar, später auf die Sammelrechnung angerechnet (dort steht die Leistung noch einmal)
    const receipt = await invoice(org, "receipt", "paid", "2026-03-10", [{ total: 5000, service: ids.svc }], 5000);
    await pay(org, receipt, 5000, "2026-03-10 10:00+01");
    const collective = await invoice(org, "collective", "partially_paid", "2026-03-31", [{ total: 5000, service: ids.svc }, { total: 5000, service: ids.svc }], 5000);
    await f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id=$2 where id=$1", [receipt, collective]));
    await pay(org, collective, 5000, "2026-03-31 18:00+02");
    // Anzahlung 20 € → auf Rechnung (60 €) angerechnet, Rest 40 € bezahlt
    const deposit = await invoice(org, "deposit", "paid", "2026-03-05", [{ total: 2000 }], 2000);
    await pay(org, deposit, 2000, "2026-03-05 09:00+01");
    const inv = await invoice(org, "invoice", "partially_paid", "2026-03-12", [{ total: 6000, service: ids.svc }], 2000);
    await f.asOrg(org, (c) => c.query("update invoices set collective_invoice_id=$2 where id=$1", [deposit, inv]));
    await pay(org, inv, 4000, "2026-03-20 09:00+01");
    // Produkte: 2 verkauft (30 €), 1 in der Behandlung angewendet (15 €)
    const sale = await invoice(org, "receipt", "paid", "2026-03-14", [{ total: 3000, qty: 2, product: ids.prod }, { total: 1500, product: ids.prod, inTreatment: true }], 4500);
    await pay(org, sale, 4500, "2026-03-14 11:00+01");
    // stornierte Rechnung und Entwurf zählen nicht
    await invoice(org, "invoice", "cancelled", "2026-03-15", [{ total: 9900, service: ids.svc }]);
    await f.asOrg(org, (c) => c.query("insert into invoices (organization_id, patient_id, kind, status) values ($1,$2,'invoice','draft')", [org, patient]));
    // Lager: +10 Eingang, −2 Verkauf (im Zeitraum); Hornhautsalbe 3 Stück (unter Mindestbestand)
    await f.asOrg(org, async (c) => {
      await c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on) values ($1,$2,'receipt',10,'2026-01-02')", [org, ids.prod]);
      await c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on, invoice_id) values ($1,$2,'sale',-2,'2026-03-14',$3)", [org, ids.prod, sale]);
      await c.query("insert into stock_movements (organization_id, product_id, kind, quantity, occurred_on) values ($1,$2,'receipt',3,'2026-01-02')", [org, ids.low]);
    });
    // andere Praxis: Umsatz und Leistung, die nicht auftauchen dürfen
    const foreign = await invoice(other, "invoice", "paid", "2026-03-10", [{ total: 77700 }], 77700);
    await pay(other, foreign, 77700, "2026-03-10 10:00+01");

    const s = await stats.salesStats(authOf(org, user), year);
    const pk = s.services.find((x) => x.name === "Podologische Komplexbehandlung")!;
    expect(pk.quantity).toBe(3); // Sammelrechnung 2 + Rechnung 1 (Quittung nicht doppelt, Storno nicht)
    expect(pk.totalCents).toBe(16_000);
    // Anzahlungs-Position steht nicht in der Liste (Anzahlungen sind kein eigener Umsatz neben der Rechnung)
    expect(s.services.reduce((sum, x) => sum + x.totalCents, 0)).toBe(16_000);

    expect(s.products).toEqual([{ name: "Fußcreme Urea 10 %", soldQty: 2, soldCents: 3000, usedQty: 1, usedCents: 1500 }]);
    const cream = s.stock.find((x) => x.name === "Fußcreme Urea 10 %")!;
    expect(cream).toMatchObject({ stock: 8, outflow: 2, reorder: false });
    expect(cream.coverageDays).toBe(Math.floor(8 / (2 / 365)));
    expect(s.stock[0]).toMatchObject({ name: "Hornhautsalbe", stock: 3, reorder: true });

    // Umsatz = Zahlungseingänge (keine Doppelzählung durch Anrechnung): 50 + 50 + 20 + 40 + 45 €
    expect(s.revenueTotal).toBe(20_500);
    const fo = await finance.financeOverview(authOf(org, user), 2026);
    expect(s.revenueTotal).toBe(fo.revenueYear);
    expect(s.revenueMonths.reduce((a, b) => a + b, 0)).toBe(fo.revenueYear);
    expect(s.revenueMonths[2]).toBe(fo.revenueMonths[2]);
    // Leistungs-Umsatz deckungsgleich mit „Umsatz nach Leistung“ der Finanzen
    expect(fo.byService.find((x) => x.name === "Podologische Komplexbehandlung")?.totalCents).toBe(16_000);
    // Wochentag (Berlin): Di 10.03. Quittung + Di 31.03. Sammelrechnung (18 Uhr MESZ) → Index 1; Fr 20.03.; Do 05.03.; Sa 14.03.
    expect(s.revenueWeekdays).toEqual([0, 10_000, 0, 2000, 4000, 4500, 0]);

    const o = await stats.salesStats(authOf(other, user), year);
    expect(o.revenueTotal).toBe(77_700);
    expect(o.services.map((x) => x.name)).toEqual(["Freitext / sonstige"]);
    expect(o.stock).toEqual([]);
  });
});
