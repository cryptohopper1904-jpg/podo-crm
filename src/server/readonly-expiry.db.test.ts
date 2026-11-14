/**
 * Ende des Nur-Lesen-Modus (AGB § 9 Nr. 2): Fristen, Ankündigung und Erinnerung genau einmal, automatischer Löschantrag
 * (nie vor der Ankündigung), Abbruch bei Tarifbuchung, Löschlauf-Prüfung und Mandantentrennung. Echte DB, E-Mail-Versand
 * gefälscht, erfundene Daten.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MailNotConfiguredError, type MailMessage, type MailPort } from "@/integrations/mail/mail";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const DAY = 86_400_000;
const ownerUrlFrom = (url: string) => url.replace(/\/\/[^@]+@/, "//podo_owner:podo_owner@");
const sfx = () => Math.random().toString(36).slice(2, 10);

(TEST_DB ? describe : describe.skip)("Ende des Nur-Lesen-Modus (DB)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 2 });
  let mod: typeof import("./readonly-expiry");
  let billing: typeof import("./billing");
  let purge: typeof import("./purge-organization");
  let sent: MailMessage[];
  let mailMode: "ok" | "unconfigured";
  const mail = (): MailPort => {
    if (mailMode === "unconfigured") throw new MailNotConfiguredError();
    return { kind: "smtp", isMock: false, source: "platform", send: async (m) => (sent.push(m), { messageId: `m-${sent.length}` }) } as MailPort;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./readonly-expiry");
    billing = await import("./billing");
    purge = await import("./purge-organization");
  });
  afterAll(async () => {
    await f.end();
    await owner.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });
  beforeEach(() => {
    sent = [];
    mailMode = "ok";
  });

  /** Praxis mit Inhaber:in; Vertragsende so gewählt, dass der späteste Löschtermin `deleteInDays` Tage ab `now` liegt */
  async function practice(opts: { deleteInDays: number; kind?: "trial" | "canceled"; now?: Date }) {
    const now = opts.now ?? new Date();
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    // Löschtermin = Vertragsende + 12 Monate → Vertragsende = Termin − 12 Monate
    const deletionAt = new Date(now.getTime() + opts.deleteInDays * DAY);
    const end = new Date(deletionAt);
    end.setUTCFullYear(end.getUTCFullYear() - 1);
    if (opts.kind === "trial") {
      await f.pool.query("update organizations set plan='trial', subscription_status='trialing', trial_ends_at=$2 where id=$1", [org, end]);
    } else {
      await f.pool.query("update organizations set plan='praxis', subscription_status='canceled', current_period_end=$2, stripe_customer_id=$3 where id=$1", [org, end, `cus_${sfx()}`]);
    }
    const email = (await f.pool.query("select email from users where id=$1", [user])).rows[0].email as string;
    return { org, user, email, deletionAt, end };
  }
  const row = async (org: string) => (await f.pool.query("select deletion_requested_at, settings from organizations where id=$1", [org])).rows[0];
  const inbox = async (org: string) =>
    f.asOrg(org, async (c) => (await c.query("select subject, body, thread_key from messages where organization_id=$1 order by received_at, subject", [org])).rows);
  const audits = async (org: string, action: string) => f.asOrg(org, async (c) => (await c.query("select meta from audit_log where organization_id=$1 and action=$2", [org, action])).rows);
  const run = (ids: string[], now: Date) => mod.runReadonlyExpiry({ now, mail, organizationIds: ids });

  it("Testphase: Ankündigung genau einmal (auch bei parallelen Läufen), Antrag erst ab 30 Tagen vor dem Termin, Erinnerung genau einmal", async () => {
    const t0 = new Date();
    const p = await practice({ deleteInDays: 60, kind: "trial", now: t0 });
    // 60 Tage vorher: noch nichts
    expect(await run([p.org], t0)).toMatchObject({ checked: 1, notices: 0, requests: 0 });
    expect(sent).toEqual([]);
    // 44 Tage vorher: Ankündigung – zwei parallele Läufe senden trotzdem nur einmal
    const t1 = new Date(t0.getTime() + 16 * DAY);
    const [a, b] = await Promise.all([run([p.org], t1), run([p.org], t1)]);
    expect(a.notices + b.notices).toBe(1);
    expect(await run([p.org], t1)).toMatchObject({ notices: 0, requests: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(p.email);
    expect(sent[0].subject).toMatch(/Ankündigung: Löschung deiner Praxis ab dem \d\d\.\d\d\.\d{4}/);
    expect(sent[0].text).toMatch(/12 Monate nach Vertragsende/);
    expect(sent[0].text).toMatch(/Export/);
    expect((await inbox(p.org)).map((m) => m.thread_key)).toEqual(["podohero-loeschung"]);
    let o = await row(p.org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.readonlyExpiry).toMatchObject({ noticeSentAt: t1.toISOString(), noticeMail: "sent" });
    expect(Date.parse(o.settings.readonlyExpiry.deletionAt)).toBe(p.deletionAt.getTime());
    // 30 Tage vorher: automatischer Löschantrag; der Löschlauf löscht erst 30 Tage danach = Termin
    const t2 = new Date(t0.getTime() + 30 * DAY);
    expect(await run([p.org], t2)).toMatchObject({ notices: 0, requests: 1 });
    o = await row(p.org);
    expect(new Date(o.deletion_requested_at).getTime()).toBe(t2.getTime());
    expect(o.settings.deletionReason).toBe("auto_readonly_expiry");
    expect(await audits(p.org, "org.deletion_requested")).toEqual([{ meta: expect.objectContaining({ reason: "auto_readonly_expiry" }) }]);
    // Ankündigung lag mindestens 30 Tage vor dem frühestmöglichen Löschtermin
    expect(new Date(o.deletion_requested_at).getTime() + 30 * DAY - Date.parse(o.settings.readonlyExpiry.noticeSentAt)).toBeGreaterThanOrEqual(30 * DAY);
    // 7 Tage vor dem Löschtermin: Erinnerung, genau einmal
    const t3 = new Date(t2.getTime() + 23 * DAY);
    expect(await run([p.org], t3)).toMatchObject({ reminders: 1 });
    expect(await run([p.org], new Date(t3.getTime() + DAY))).toMatchObject({ reminders: 0 });
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^Ankündigung/), expect.stringMatching(/^Erinnerung: Deine Praxis wird ab dem/)]);
    expect((await inbox(p.org)).length).toBe(2);
  });

  it("Altfall (Frist schon überschritten): Ankündigung und Antrag im selben Lauf – Löschung frühestens 30 Tage später", async () => {
    const now = new Date();
    const p = await practice({ deleteInDays: -20, now });
    expect(await run([p.org], now)).toMatchObject({ notices: 1, requests: 1 });
    const o = await row(p.org);
    expect(new Date(o.deletion_requested_at).getTime()).toBe(now.getTime());
    expect(Date.parse(o.settings.readonlyExpiry.deletionAt)).toBe(now.getTime() + 30 * DAY);
    expect(sent[0].subject).toContain(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(now.getTime() + 30 * DAY)));
  });

  it("ohne Plattform-SMTP: Posteingang und Status „not_configured“ (Konsole), Antrag folgt trotzdem", async () => {
    mailMode = "unconfigured";
    const now = new Date();
    const p = await practice({ deleteInDays: 10, now });
    const r = await run([p.org], now);
    expect(r).toMatchObject({ notices: 1, requests: 1, mailNotSent: 1 });
    expect((await row(p.org)).settings.readonlyExpiry.noticeMail).toBe("not_configured");
    expect(await inbox(p.org)).toHaveLength(1);
  });

  it("Tarifbuchung stoppt: Checkout (Webhook) und Kostenlos-Tarif entfernen den automatischen Antrag; eigener Antrag bleibt", async () => {
    const now = new Date();
    const a = await practice({ deleteInDays: 5, now });
    const b = await practice({ deleteInDays: 5, now });
    await run([a.org, b.org], now);
    expect((await row(a.org)).deletion_requested_at).not.toBeNull();
    // A bucht einen Tarif (Stripe-Checkout)
    const ev = { id: `evt_${sfx()}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { mode: "subscription", client_reference_id: a.org, subscription: `sub_${sfx()}`, payment_status: "paid", metadata: { plan: "praxis", seats: "1" } } } };
    expect(await billing.processBillingEvent(ev, { prices: {} })).toBe("processed");
    let o = await row(a.org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.deletionReason).toBeUndefined();
    expect(o.settings.readonlyExpiry).toBeUndefined();
    expect(await audits(a.org, "org.readonly_expiry_stopped")).toEqual([{ meta: { trigger: "billing:checkout.session.completed" } }]);
    expect(await run([a.org], now)).toMatchObject({ requests: 0, notices: 0 });
    // B wechselt in den Kostenlos-Tarif
    const r = await billing.switchToFreePlan(b.org, b.user);
    expect(r).toMatchObject({ ok: true });
    o = await row(b.org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.readonlyExpiry).toBeUndefined();
    // selbst gestellter Antrag wird von stopAutoDeletion nicht angetastet
    const c = await practice({ deleteInDays: 100, now });
    await f.pool.query("update organizations set deletion_requested_at = now() where id=$1", [c.org]);
    const { db } = await import("@/db");
    expect(await mod.stopAutoDeletion(db, c.org, { trigger: "test" })).toBe(false);
    expect((await row(c.org)).deletion_requested_at).not.toBeNull();
    expect(await run([c.org], now)).toMatchObject({ notices: 0, requests: 0, reminders: 0 });
  });

  it("Löschlauf: automatischer Antrag nur, solange kein Tarif gebucht ist", async () => {
    const now = new Date();
    const p = await practice({ deleteInDays: 5, now });
    await run([p.org], now);
    await owner.query("update organizations set deletion_requested_at = now() - interval '31 days' where id=$1", [p.org]);
    // Tarif gebucht, ohne dass Cron/Webhook den Antrag schon entfernt hat (z. B. Plattform-Konsole direkt in der DB)
    await owner.query("update organizations set subscription_status='active', current_period_end = now() + interval '30 days' where id=$1", [p.org]);
    const c = await owner.connect();
    try {
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_obsolete" });
      // wieder beendet → Löschung zulässig (Probelauf)
      await owner.query("update organizations set subscription_status='canceled', current_period_end = $2 where id=$1", [p.org, p.end]);
      const dry = await purge.purgeOrganization(c, p.org, { execute: false, billing: null });
      expect(dry.executed).toBe(false);
      // ohne Ankündigung keine automatische Löschung
      await owner.query("update organizations set settings = settings - 'readonlyExpiry' where id=$1", [p.org]);
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_not_announced" });
    } finally {
      c.release();
    }
  });

  it("Mandantentrennung: nur die betroffene Praxis wird angekündigt, beantragt und benachrichtigt", async () => {
    const now = new Date();
    const due = await practice({ deleteInDays: 5, now });
    const active = await practice({ deleteInDays: 5, now });
    await f.pool.query("update organizations set subscription_status='active', current_period_end = now() + interval '20 days' where id=$1", [active.org]);
    const fresh = await practice({ deleteInDays: 200, now });
    const r = await run([due.org, active.org, fresh.org], now);
    // die aktive Praxis ist gar kein Kandidat (laufendes Abo)
    expect(r).toMatchObject({ checked: 2, notices: 1, requests: 1 });
    expect(sent.map((m) => m.to)).toEqual([due.email]);
    expect(await inbox(active.org)).toEqual([]);
    expect(await inbox(fresh.org)).toEqual([]);
    expect((await row(active.org)).deletion_requested_at).toBeNull();
    expect((await row(fresh.org)).deletion_requested_at).toBeNull();
    expect((await row(fresh.org)).settings.readonlyExpiry).toBeUndefined();
    // Posteingang-Hinweis der betroffenen Praxis ist für eine andere Praxis per RLS unsichtbar
    const leaked = await f.asOrg(active.org, async (c) => (await c.query("select 1 from messages where organization_id=$1", [due.org])).rows);
    expect(leaked).toEqual([]);
    // Hinweis in der App für die betroffene Praxis, nicht für die aktive
    expect(await mod.readonlyDeletionNotice(due.org, now)).toMatchObject({ auto: true });
    expect(await mod.readonlyDeletionNotice(active.org, now)).toBeNull();
  });
});
