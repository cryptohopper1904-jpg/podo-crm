/** Mahnung per E-Mail mit „echtem“ (gestubbtem) Versand: kein Doppelversand, Rollback bei Fehler, Frist ab Versandtag. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mail = vi.hoisted(() => ({ calls: 0, fail: false, failedLogs: 0 }));
vi.mock("./mail", async () => {
  const { MailSendError } = await import("@/integrations/mail/mail");
  return {
    // wie das Original: Versandweg vorab laden, `send` ohne DB-Zugriff, Protokoll danach
    prepareMail: async () => ({
      isMock: false,
      async send() {
        mail.calls++;
        await new Promise((r) => setTimeout(r, 50));
        if (mail.fail) throw new MailSendError("Server lehnt ab", "EENVELOPE");
        return { messageId: `ext-${mail.calls}` };
      },
      failed: async (e: Error) => {
        mail.failedLogs++;
        return e;
      },
      succeeded: async () => undefined,
    }),
  };
});
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Mahnung per E-Mail (DB, Versand gestubbt)", () => {
  const f = fixtures(TEST_DB!);
  let dunning: typeof import("./dunning");
  let org: string, user: string, patient: string;
  const auth = () => ({ organization: { id: org, name: "T", smallBusiness: false }, user: { id: user, name: "Test" }, can: () => true }) as never;

  async function overdueInvoice() {
    return f.asOrg(org, async (c) => {
      const id = (await c.query("insert into invoices (organization_id, patient_id, status, kind) values ($1,$2,'draft','invoice') returning id", [org, patient])).rows[0].id as string;
      await c.query("insert into invoice_lines (organization_id, invoice_id, description, unit_price_cents, total_cents, vat_rate, position) values ($1,$2,'Behandlung',6500,6500,0,1)", [org, id]);
      await c.query("update invoices set status='issued', number=$2, issued_at=current_date-40, due_at=current_date-20, total_cents=6500, net_cents=6500 where id=$1", [id, `S${Math.random().toString(36).slice(2, 10)}`]);
      return id;
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    // Pool mit EINER Verbindung: holt der Versand innerhalb der Transaktion eine zweite, läuft er in den Pool-Timeout
    process.env.DB_POOL_MAX = "1";
    dunning = await import("./dunning");
    org = await f.org({ settings: { dunning: { payDays: 12 } } });
    user = await f.user();
    patient = await f.patient(org, { email: "erika@example.org" });
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("zweimal gleichzeitig senden: genau ein Versand und ein Vermerk; Frist ab Versandtag", async () => {
    const inv = await overdueInvoice();
    const id = (await dunning.createDunnings(auth(), [inv])).created[0].dunningId;
    mail.calls = 0;
    const both = await Promise.allSettled([dunning.sendDunningEmail(auth(), id), dunning.sendDunningEmail(auth(), id)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.find((r) => r.status === "rejected")!.reason.message).toMatch(/bereits als versendet/);
    expect(mail.calls).toBe(1);
    const row = await f.asOrg(org, async (c) => (await c.query("select sent_via, sent_to, sent_at, pay_by::text, (current_date + 12)::text as expected from invoice_dunnings where id = $1", [id])).rows[0]);
    expect(row).toMatchObject({ sent_via: "email", sent_to: "erika@example.org" });
    expect(row.pay_by).toBe(row.expected);
    const msgs = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from messages where organization_id = $1", [org])).rows[0].n);
    expect(msgs).toBe(1);
  });

  it("Versandfehler: nichts vermerkt, erneuter Versand möglich", async () => {
    const inv = await overdueInvoice();
    const id = (await dunning.createDunnings(auth(), [inv])).created[0].dunningId;
    mail.fail = true;
    mail.failedLogs = 0;
    await expect(dunning.sendDunningEmail(auth(), id)).rejects.toThrow(/E-Mail-Versand fehlgeschlagen: Server lehnt ab/);
    expect(mail.failedLogs).toBe(1); // genau ein Fehlerprotokoll
    const syncErrors = await f.asOrg(org, async (c) => (await c.query("select count(*)::int as n from sync_log where organization_id = $1 and ok = false", [org])).rows[0].n);
    expect(syncErrors).toBe(0); // dunning.ts schreibt keinen zusätzlichen Eintrag (der kommt nur aus mail.failed)
    const row = await f.asOrg(org, async (c) => (await c.query("select sent_via from invoice_dunnings where id = $1", [id])).rows[0]);
    expect(row.sent_via).toBeNull();
    mail.fail = false;
    await expect(dunning.sendDunningEmail(auth(), id)).resolves.toMatchObject({ mock: false });
  });
});
