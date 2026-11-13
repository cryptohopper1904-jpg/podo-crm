/** Mahnwesen gegen eine echte DB (RLS aktiv, App-Rolle, erfundene Daten). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Mahnwesen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let dunning: typeof import("./dunning");
  let orgA: string, orgB: string, user: string, patient: string;
  const authFor = (org: string, can: (p: string) => boolean = () => true) =>
    ({ organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can }) as never;

  /** Ausgestellte Rechnung, Zahlungsziel vor `overdueDays` Tagen */
  async function overdue(org: string, overdueDays: number, patch: { kind?: string; status?: string; paidCents?: number; patientId?: string | null } = {}) {
    const pid = patch.patientId === undefined ? (org === orgA ? patient : null) : patch.patientId;
    return f.asOrg(org, async (c) => {
      const id = (await c.query("insert into invoices (organization_id, patient_id, status, kind) values ($1,$2,'draft',$3) returning id", [org, pid, patch.kind ?? "invoice"])).rows[0].id as string;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Podologische Behandlung',6500,6500,0,1)", [org, id]);
      await c.query(
        "update invoices set status = $2, number = $3, issued_at = current_date - $4::int - 14, due_at = current_date - $4::int, total_cents = 6500, net_cents = 6500, paid_cents = $5 where id = $1",
        [id, patch.status ?? "issued", `M${Math.random().toString(36).slice(2, 10)}`, overdueDays, patch.paidCents ?? 0],
      );
      return id;
    });
  }
  const dunningsOf = (org: string, invoiceId: string) =>
    f.asOrg(org, async (c) => (await c.query("select * from invoice_dunnings where invoice_id = $1 order by created_at", [invoiceId])).rows);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    dunning = await import("./dunning");
    orgA = await f.org({ settings: { dunning: { payDays: 10, stages: { dunning1: { days: 14, feeCents: 250 } } } } });
    orgB = await f.org();
    user = await f.user();
    patient = await f.patient(orgA, { lastName: "Muster", firstName: "Erika", email: "erika@example.org" });
    await f.asOrg(orgA, (c) => c.query("update patients set salutation = 'Frau' where id = $1", [patient]));
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Übersicht: nur überfällige, offene Rechnungen – keine Quittungen, Anzahlungen, bezahlten oder stornierten", async () => {
    const due = await overdue(orgA, 10);
    const notYet = await overdue(orgA, 3);
    const receipt = await overdue(orgA, 30, { kind: "receipt" });
    const deposit = await overdue(orgA, 30, { kind: "deposit" });
    const paid = await overdue(orgA, 30, { status: "paid", paidCents: 6500 });
    const cancelled = await overdue(orgA, 30, { status: "cancelled" });
    const { rows } = await dunning.dunningOverview(authFor(orgA));
    const ids = rows.map((r) => r.invoiceId);
    expect(ids).toEqual(expect.arrayContaining([due, notYet]));
    for (const x of [receipt, deposit, paid, cancelled]) expect(ids).not.toContain(x);
    expect(rows.find((r) => r.invoiceId === due)!.state).toMatchObject({ state: "due", next: "reminder", daysOverdue: 10 });
    expect(rows.find((r) => r.invoiceId === notYet)!.state).toMatchObject({ state: "waiting", next: "reminder" });

    const r = await dunning.createDunnings(authFor(orgA), [due, notYet, receipt, paid]);
    expect(r.created.map((c) => [c.invoiceId, c.stage])).toEqual([[due, "reminder"]]);
    expect(r.skipped.map((s) => s.invoiceId).sort()).toEqual([notYet, receipt, paid].sort());
    expect(r.skipped.find((s) => s.invoiceId === receipt)!.reason).toMatch(/Nur offene Rechnungen/);

    // DB-Schutz zusätzlich zur App-Prüfung: keine Mahnung zu Quittung oder bezahlter Rechnung
    for (const inv of [receipt, paid]) {
      await expect(
        f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'reminder',current_date,current_date+10,6500,'x','{}')", [orgA, inv])),
      ).rejects.toThrow(/nicht gemahnt|Nur offene Rechnungen/);
    }
  });

  it("Zahlungserinnerung: Text, Beträge, unveränderbar; zweite Stufe erst nach Frist", async () => {
    const inv = await overdue(orgA, 8, { status: "partially_paid", paidCents: 2000 });
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(r.created).toHaveLength(1);
    const [d] = await dunningsOf(orgA, inv);
    expect(d).toMatchObject({ stage: "reminder", open_cents: 4500, fee_cents: 0, fees_total_cents: 0, created_by: user, sent_via: null });
    expect(d.body).toMatch(/^Sehr geehrte Frau Muster,/);
    expect(d.body).toContain("45,00");

    expect(d.body).toContain("{frist}"); // Frist wird beim Erzeugen aus pay_by eingesetzt

    // noch nicht versendet → keine weitere Stufe (App und Übersicht)
    const unsent = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(unsent.skipped[0].reason).toMatch(/Zahlungserinnerung ist noch nicht versendet/);
    const ov = await dunning.dunningOverview(authFor(orgA));
    expect(ov.rows.find((x) => x.invoiceId === inv)!.state).toMatchObject({ state: "unsent", last: "reminder" });

    // unveränderbar, nicht löschbar; nur der Versandvermerk
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set body = 'anders' where id = $1", [d.id]))).rejects.toThrow(/unveränderbar/);
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set fee_cents = 100 where id = $1", [d.id]))).rejects.toThrow();
    await expect(f.asOrg(orgA, (c) => c.query("delete from invoice_dunnings where id = $1", [d.id]))).rejects.toThrow(/nicht gelöscht/);
    // Versandvermerk vollständig oder gar nicht; Frist nur zusammen mit dem Versand und nur nach hinten
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set sent_to = 'x@example.org' where id = $1", [d.id]))).rejects.toThrow(/sent_check/);
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set sent_via = 'post' where id = $1", [d.id]))).rejects.toThrow(/sent_check/);
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set pay_by = pay_by + 5 where id = $1", [d.id]))).rejects.toThrow(/nur beim Versand/);
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set sent_via = 'post', sent_at = now(), pay_by = pay_by - 1 where id = $1", [d.id]))).rejects.toThrow(/nach hinten/);
    // zweimal gleichzeitig „per Post“: nur einer gewinnt
    const both = await Promise.allSettled([dunning.markDunningPosted(authFor(orgA), d.id), dunning.markDunningPosted(authFor(orgA), d.id)]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await dunningsOf(orgA, inv))[0].sent_via).toBe("post");

    // versendet, aber Frist läuft noch → 1. Mahnung noch nicht fällig
    const again = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(again.created).toHaveLength(0);
    expect(again.skipped[0].reason).toMatch(/1\. Mahnung ist erst ab/);

    // Audit
    const audits = await f.asOrg(orgA, (c) => c.query("select action from audit_log where organization_id = $1 and entity_id = $2 order by id", [orgA, inv]));
    expect(audits.rows.map((a) => a.action)).toEqual(["invoice.dunning_create", "invoice.dunning_mark_posted"]);

    // PDF nur im eigenen Mandanten
    const pdf = await dunning.dunningPdfForOrg(orgA, d.id);
    expect(Buffer.from(pdf!.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf!.filename).toMatch(/^Zahlungserinnerung_/);
    expect(await dunning.dunningPdfForOrg(orgB, d.id)).toBeNull();
  });

  it("1. Mahnung mit Gebühr nach Frist, Reihenfolge per DB erzwungen, Rechnung bleibt unverändert", async () => {
    const inv = await overdue(orgA, 40);
    // Vorstufe ohne Versandvermerk → DB lehnt die nächste Stufe ab
    const unsentInv = await overdue(orgA, 40);
    await f.asOrg(orgA, (c) =>
      c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'reminder',current_date-20,current_date-10,6500,'alt','{}')", [orgA, unsentInv]),
    );
    await expect(
      f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'dunning1',current_date,current_date+10,6500,'x','{}')", [orgA, unsentInv])),
    ).rejects.toThrow(/noch nicht versendet/);
    // Mahnstufe überspringen geht auch direkt in der DB nicht
    await expect(
      f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'dunning1',current_date,current_date+10,6500,'x','{}')", [orgA, inv])),
    ).rejects.toThrow(/der Reihe nach/);
    // Gebühr für die Zahlungserinnerung ist ausgeschlossen
    await expect(
      f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, fee_cents, fees_total_cents, body, letterhead) values ($1,$2,'reminder',current_date,current_date+10,6500,100,100,'x','{}')", [orgA, inv])),
    ).rejects.toThrow(/amounts_check/);
    // Zahlungserinnerung vor 20 Tagen (Altbestand)
    await f.asOrg(orgA, (c) =>
      c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead, sent_via, sent_at) values ($1,$2,'reminder',current_date-20,current_date-10,6500,'alt','{}','post',now() - interval '20 days')", [orgA, inv]),
    );
    const before = await f.asOrg(orgA, async (c) => (await c.query("select total_cents, net_cents, vat_cents, paid_cents, status from invoices where id = $1", [inv])).rows[0]);
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(r.created.map((c) => c.stage)).toEqual(["dunning1"]);
    const rows = await dunningsOf(orgA, inv);
    // Mahngebühren vorerst 0 € (kein Buchungsweg), auch wenn die Einstellung noch 2,50 € enthält
    expect(rows[1]).toMatchObject({ stage: "dunning1", open_cents: 6500, fee_cents: 0, fees_total_cents: 0 });
    expect(rows[1].body).toContain("Gesamtbetrag von 65,00");
    const after = await f.asOrg(orgA, async (c) => (await c.query("select total_cents, net_cents, vat_cents, paid_cents, status from invoices where id = $1", [inv])).rows[0]);
    expect(after).toEqual(before);
    // eindeutig je Stufe
    await expect(
      f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'reminder',current_date,current_date+10,6500,'x','{}')", [orgA, inv])),
    ).rejects.toThrow(/invoice_dunnings_invoice_stage/);
  });

  it("nächste Stufe erst nach Ablauf der Frist des vorigen Schreibens (App und DB)", async () => {
    const inv = await overdue(orgA, 60);
    await f.asOrg(orgA, (c) =>
      c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead, sent_via, sent_at) values ($1,$2,'reminder',current_date-20,current_date,6500,'alt','{}','post',now() - interval '20 days')", [orgA, inv]),
    );
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(r.created).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/1\. Mahnung ist erst ab/);
    await expect(
      f.asOrg(orgA, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'dunning1',current_date,current_date+10,6500,'x','{}')", [orgA, inv])),
    ).rejects.toThrow(/Zahlungsfrist des vorigen Schreibens läuft noch/);
  });

  it("Versandvermerk nur einmal; Briefkopf eingefroren", async () => {
    const inv = await overdue(orgA, 30);
    const id = (await dunning.createDunnings(authFor(orgA), [inv])).created[0].dunningId;
    const [d] = await dunningsOf(orgA, inv);
    expect(d.letterhead.organization).toMatchObject({ name: "Testpraxis Fuß", phone: "030 1234567" });
    expect(d.letterhead.patient).toMatchObject({ lastName: "Muster", salutation: "Frau" });
    await expect(f.asOrg(orgA, (c) => c.query(`update invoice_dunnings set letterhead = '{}' where id = $1`, [id]))).rejects.toThrow(/unveränderbar/);
    await dunning.markDunningPosted(authFor(orgA), id);
    await expect(dunning.markDunningPosted(authFor(orgA), id)).rejects.toThrow(/bereits als versendet/);
    await expect(dunning.sendDunningEmail(authFor(orgA), id)).rejects.toThrow(/bereits als versendet/);
    await expect(f.asOrg(orgA, (c) => c.query("update invoice_dunnings set sent_via = 'email', sent_to = 'x@example.org' where id = $1", [id]))).rejects.toThrow(/bereits gesetzt/);
    // spätere Änderung der Praxisdaten ändert den Nachdruck nicht (Briefkopf aus dem Schnappschuss)
    await f.asOrg(orgA, (c) => c.query("update organizations set phone = '099 999' where id = $1", [orgA]));
    const again = await dunningsOf(orgA, inv);
    expect(again[0].letterhead.organization.phone).toBe("030 1234567");
    await f.asOrg(orgA, (c) => c.query("update organizations set phone = '030 1234567' where id = $1", [orgA]));
  });

  it("bezahlte Rechnung: keine weitere Stufe, kein Versand mehr", async () => {
    const inv = await overdue(orgA, 30);
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    const id = r.created[0].dunningId;
    await f.asOrg(orgA, (c) => c.query("update invoices set status = 'paid', paid_cents = 6500 where id = $1", [inv]));
    const later = await dunning.createDunnings(authFor(orgA), [inv]);
    expect(later.created).toHaveLength(0);
    expect(later.skipped[0].reason).toMatch(/Nur offene Rechnungen/);
    await expect(dunning.sendDunningEmail(authFor(orgA), id)).rejects.toThrow(/inzwischen bezahlt/);
    const { rows } = await dunning.dunningOverview(authFor(orgA));
    expect(rows.map((x) => x.invoiceId)).not.toContain(inv);
  });

  it("Mandantentrennung (RLS) und Rechte", async () => {
    const inv = await overdue(orgA, 30);
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    const id = r.created[0].dunningId;
    const seenByB = await f.asOrg(orgB, async (c) => (await c.query("select 1 from invoice_dunnings where id = $1", [id])).rowCount);
    expect(seenByB).toBe(0);
    const seenByNone = (await f.pool.query("select 1 from invoice_dunnings where id = $1", [id])).rowCount;
    expect(seenByNone).toBe(0);
    // fremde Rechnung kann nicht gemahnt werden – weder per App noch direkt
    const viaApp = await dunning.createDunnings(authFor(orgB), [inv]);
    expect(viaApp.created).toHaveLength(0);
    expect(viaApp.skipped[0].reason).toMatch(/nicht gefunden/);
    await expect(
      f.asOrg(orgB, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'dunning1',current_date,current_date+10,6500,'x','{}')", [orgB, inv])),
    ).rejects.toThrow(/nicht gefunden/);
    await expect(
      f.asOrg(orgB, (c) => c.query("insert into invoice_dunnings (organization_id, invoice_id, stage, letter_date, pay_by, open_cents, body, letterhead) values ($1,$2,'dunning1',current_date,current_date+10,6500,'x','{}')", [orgA, inv])),
    ).rejects.toThrow();
    await expect(dunning.markDunningPosted(authFor(orgB), id)).rejects.toThrow(/nicht gefunden/);
    expect(await dunning.invoiceDunningList(authFor(orgB), inv)).toEqual([]);
    expect((await dunning.invoiceDunningList(authFor(orgA), inv)).map((d) => d.id)).toEqual([id]);

    const readOnly = authFor(orgA, (p) => p === "invoices.read");
    await expect(dunning.createDunnings(readOnly, [inv])).rejects.toThrow();
    await expect(dunning.markDunningPosted(readOnly, id)).rejects.toThrow();
    await expect(dunning.sendDunningEmail(readOnly, id)).rejects.toThrow();
    await expect(dunning.dunningOverview(authFor(orgA, () => false))).rejects.toThrow();
  });

  it("vorbereiteter Versand: genau ein send", async () => {
    const { prepareMail } = await import("./mail");
    const m = await prepareMail(orgA, { purpose: "test" });
    await m.send({ to: "erika@example.org", subject: "Test", text: "Hallo" });
    await expect(m.send({ to: "erika@example.org", subject: "Test", text: "Hallo" })).rejects.toThrow(/nur einmal/);
  });

  it("E-Mail-Versand im Testmodus setzt KEINEN Versandvermerk", async () => {
    const inv = await overdue(orgA, 30);
    const r = await dunning.createDunnings(authFor(orgA), [inv]);
    const id = r.created[0].dunningId;
    const before = (await dunningsOf(orgA, inv))[0];
    const sent = await dunning.sendDunningEmail(authFor(orgA), id);
    expect(sent).toMatchObject({ to: "erika@example.org", mock: true });
    const [d] = await dunningsOf(orgA, inv);
    expect(d).toMatchObject({ sent_via: null, sent_at: null, sent_to: null });
    expect(d.pay_by).toEqual(before.pay_by);
    const msgs = await f.asOrg(orgA, (c) => c.query("select body from messages where organization_id = $1 and to_address = 'erika@example.org' and subject like 'Zahlungserinnerung%' order by received_at desc limit 1", [orgA]));
    expect(msgs.rows[0].body).not.toContain("{frist}"); // Frist eingesetzt
  });

  it("Einstellungen: Gebühren vorerst 0 € (Zahlungserinnerung immer)", async () => {
    const parsed = dunning.dunningSettingsInput.safeParse({
      payDays: 7,
      stages: { reminder: { days: 5, feeCents: 0, text: "x".repeat(30) }, dunning1: { days: 10, feeCents: 150, text: "x".repeat(30) }, dunning2: { days: 10, feeCents: 0, text: "x".repeat(30) } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0].message).toMatch(/Mahngebühren folgen, sobald die Verbuchung eingebaut ist/);
    const s = await dunning.saveDunningSettings(authFor(orgB), {
      payDays: 7,
      stages: {
        reminder: { days: 5, feeCents: 300, text: "{anrede}, bitte zahlen Sie {offener_betrag}." },
        dunning1: { days: 10, feeCents: 150, text: "{anrede}, bitte zahlen Sie {gesamtbetrag}." },
        dunning2: { days: 10, feeCents: 150, text: "{anrede}, letzte Mahnung über {gesamtbetrag}." },
      },
    });
    expect(s.stages.reminder.feeCents).toBe(0);
    const row = (await f.pool.query("select settings from organizations where id = $1", [orgB])).rows[0].settings;
    expect(row.dunning.stages.reminder.feeCents).toBe(0);
    expect(row.dunning.stages.dunning1.feeCents).toBe(0);
    expect(row.dunning.payDays).toBe(7);
  });
});
