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
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), requestMeta: async () => ({ ip: "203.0.113.7", userAgent: null }) }));

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
  let platform: typeof import("./platform");
  let promo: typeof import("./promo-codes");
  let sent: MailMessage[];
  let mailMode: "ok" | "unconfigured" | "crash";
  /** Adressen, an die der Versand scheitert (SMTP lehnt ab) */
  let rejectTo: Set<string>;
  const mail = (): MailPort => {
    if (mailMode === "unconfigured") throw new MailNotConfiguredError();
    if (mailMode === "crash") throw new Error("SMTP-Verbindung abgebrochen");
    return {
      kind: "smtp",
      isMock: false,
      source: "platform",
      send: async (m) => {
        if (rejectTo.has(m.to)) throw new Error("550 Postfach unbekannt");
        sent.push(m);
        return { messageId: `m-${sent.length}` };
      },
    } as MailPort;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    mod = await import("./readonly-expiry");
    billing = await import("./billing");
    purge = await import("./purge-organization");
    platform = await import("./platform");
    promo = await import("./promo-codes");
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
    rejectTo = new Set();
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
    expect(sent[0].subject).toMatch(/Ankündigung: Löschung deiner Praxis am \d\d\.\d\d\.\d{4}/);
    // einheitlich mit AGB § 9 Nr. 2 (Recht E-2), Verweis AGB § 3 Nr. 5 (E-1), TSE-Export beim Anbieter (E-7), Kassenabmeldung (Buchhaltung E2)
    // Recht R-4: „endet grundsätzlich 12 Monate nach …; wir löschen deine Praxis am … endgültig (spätestens 14 Tage danach)“
    expect(sent[0].text).toMatch(/Der Nur-Lesen-Modus endet grundsätzlich 12 Monate nach Ende der Testphase \(AGB § 3 Nr\. 5, § 9 Nr\. 2\); wir löschen deine Praxis am \d\d\.\d\d\.\d{4} endgültig \(spätestens 14 Tage danach\)/);
    expect(sent[0].text).toContain("(AGB § 3 Nr. 5, § 9 Nr. 2)");
    expect(sent[0].text).toContain("und den TSE-Export bei deinem TSE-Anbieter; nach der Löschung lassen sie sich über PodoHero nicht mehr erzeugen.");
    // Recht R-2: Ankündigung mit „– falls noch nicht geschehen“
    expect(sent[0].text).toContain("teile die Außerbetriebnahme – falls noch nicht geschehen – innerhalb eines Monats danach deinem Finanzamt mit (§ 146a Abs. 4 AO, z. B. über „Mein ELSTER“)");
    expect(sent[0].text).toContain("Du kannst die Löschung auch sofort beantragen (Einstellungen → Daten & Kündigung).");
    expect(sent[0].text).not.toMatch(/ab dem|frühestens am/);
    // Testphase: eigener Satz, kostenloser Tarif als Ausweg, Aufbewahrungs-Hinweis (Buchhaltung)
    expect(sent[0].text).toMatch(/deine Testphase für die Praxis „.+“ in PodoHero endete am \d\d\.\d\d\.\d{4}\./);
    expect(sent[0].text).toMatch(/12 Monate nach Ende der Testphase/);
    expect(sent[0].text).toMatch(/kostenlosen Tarif \(bis 20 Patient:innen/);
    expect(sent[0].text).toContain("Den Export brauchst du, um deine Aufbewahrungspflichten zu erfüllen.");
    expect(sent[0].text).toContain("ggf. mehrere Zeiträume (max. 3 Jahre je Export)");
    expect(sent[0].text).not.toMatch(/ist am .* geendet/);
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
    expect(sent.map((m) => m.subject)).toEqual([expect.stringMatching(/^Ankündigung/), expect.stringMatching(/^Erinnerung: Wir löschen deine Praxis am \d\d\.\d\d\.\d{4}/)]);
    expect(sent[1].text).toMatch(/löschen wir deine Praxis „.+“ in PodoHero am \d\d\.\d\d\.\d{4} endgültig \(spätestens 14 Tage danach\)\./);
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

  it("ohne Plattform-SMTP: KEIN Löschantrag; erst nach Betreiber-Vermerk, Termin ≥ Zugang + 30 Tage", async () => {
    mailMode = "unconfigured";
    const now = new Date();
    const p = await practice({ deleteInDays: 10, now });
    const r = await run([p.org], now);
    expect(r).toMatchObject({ notices: 1, requests: 0, mailNotSent: 1 });
    expect((await row(p.org)).settings.readonlyExpiry.noticeMail).toBe("not_configured");
    expect((await row(p.org)).deletion_requested_at).toBeNull();
    expect(await inbox(p.org)).toHaveLength(1);
    // spätere Läufe (auch Wochen danach) stellen ohne Zugang keinen Antrag (der erneute Versuch scheitert ebenfalls)
    const later = new Date(now.getTime() + 60 * DAY);
    expect(await run([p.org], later)).toMatchObject({ requests: 0, mailNotSent: 1 });
    expect((await row(p.org)).deletion_requested_at).toBeNull();
    expect(await inbox(p.org)).toHaveLength(1);
    // Vermerk: Datum in der Zukunft / ohne Nachweis abgelehnt
    const admin = await f.user();
    const day = (d: Date) => d.toISOString().slice(0, 10);
    await expect(mod.recordManualNotice(admin, p.org, { receivedOn: day(new Date(later.getTime() + 3 * DAY)), via: "letter", note: "Brief an Inhaberin" }, later)).rejects.toThrow(/Zukunft/);
    await expect(mod.recordManualNotice(admin, p.org, { receivedOn: day(later), via: "letter", note: "" }, later)).rejects.toThrow(/Nachweis/);
    const v = await mod.recordManualNotice(admin, p.org, { receivedOn: day(later), via: "letter", note: "Einschreiben an Praxisanschrift, Kopie im Ordner" }, later);
    expect(v.deletionAt.getTime()).toBeGreaterThanOrEqual(later.getTime() + 30 * DAY);
    const st = (await row(p.org)).settings.readonlyExpiry;
    expect(st).toMatchObject({ manualNoticeVia: "letter", manualNoticeBy: admin, noticeMail: "not_configured" });
    expect(Date.parse(st.deletionAt)).toBe(v.deletionAt.getTime());
    expect(await audits(p.org, "platform.readonly_notice_manual")).toEqual([{ meta: expect.objectContaining({ via: "letter", mail: "not_configured" }) }]);
    // AppSec I-2: Vermerk mit IP des Plattform-Admins im Audit
    const ip = await f.asOrg(p.org, async (c) => (await c.query("select ip from audit_log where organization_id=$1 and action='platform.readonly_notice_manual'", [p.org])).rows);
    expect(ip).toEqual([{ ip: "203.0.113.7" }]);
    // jetzt Antrag; der Löschlauf löscht frühestens 30 Tage nach Zugang
    expect(await run([p.org], later)).toMatchObject({ requests: 1, mailNotSent: 0 });
    expect(new Date((await row(p.org)).deletion_requested_at).getTime() + 30 * DAY).toBeGreaterThanOrEqual(Date.parse(st.manualNoticeAt) + 30 * DAY);
  });

  it("Vermerk mit zurückliegendem Zugang: Antrag erst 30 Tage vor (Zugang + 30 Tage), nicht vorher", async () => {
    mailMode = "unconfigured";
    const now = new Date();
    const p = await practice({ deleteInDays: -20, now });
    await run([p.org], now);
    const admin = await f.user();
    // Zugang 40 Tage nach der (gescheiterten) Ankündigung
    const later = new Date(now.getTime() + 40 * DAY);
    const v = await mod.recordManualNotice(admin, p.org, { receivedOn: later.toISOString().slice(0, 10), via: "email", note: "aus eigenem Postfach, Lesebestätigung" }, later);
    expect(v.deletionAt.getTime()).toBe(later.getTime() + 30 * DAY);
    expect(await run([p.org], later)).toMatchObject({ requests: 1 });
  });

  it("Versandfehler und abgebrochener Lauf gelten als „nicht versendet“ (kein Antrag, Pflichtaktion)", async () => {
    mailMode = "crash";
    const now = new Date();
    const a = await practice({ deleteInDays: 5, now });
    expect(await run([a.org], now)).toMatchObject({ notices: 1, requests: 0, failed: 0, mailNotSent: 1 });
    expect((await row(a.org)).settings.readonlyExpiry.noticeMail).toBe("failed");
    // Lauf nach dem Beanspruchen abgebrochen (Status blieb „unknown“)
    const b = await practice({ deleteInDays: 5, now });
    await owner.query(
      "update organizations set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('readonlyExpiry', jsonb_build_object('noticeSentAt', $2::text, 'deletionAt', $3::text, 'noticeMail', 'unknown')) where id=$1",
      [b.org, new Date(now.getTime() - 40 * DAY).toISOString(), new Date(now.getTime() - 10 * DAY).toISOString()],
    );
    // erneuter Versuch (Lauf abgebrochen, Status „unknown“): jetzt zugestellt → neuer Termin = jetzt + 30 Tage, Antrag sofort
    // (der Löschlauf löscht 30 Tage nach dem Antrag = 30 Tage nach Zugang)
    mailMode = "ok";
    expect(await run([b.org], now)).toMatchObject({ notices: 1, requests: 1, mailNotSent: 0 });
    const ob = await row(b.org);
    expect(ob.settings.readonlyExpiry).toMatchObject({ noticeSentAt: now.toISOString(), noticeMail: "sent" });
    expect(Date.parse(ob.settings.readonlyExpiry.deletionAt)).toBe(now.getTime() + 30 * DAY);
    expect(new Date(ob.deletion_requested_at).getTime()).toBe(now.getTime());
    expect(sent.map((m) => m.to)).toEqual([b.email]);
    expect(await audits(b.org, "org.readonly_expiry_notice")).toEqual([{ meta: expect.objectContaining({ retry: true, previousMail: "unknown", mail: "sent" }) }]);
  });

  it("nicht zugestellte Ankündigung wird höchstens einmal je 24 h erneut versucht, mit Termin ≥ Versuch + 30 Tage", async () => {
    mailMode = "crash";
    const t0 = new Date();
    const p = await practice({ deleteInDays: 40, now: t0 });
    expect(await run([p.org], t0)).toMatchObject({ notices: 1, requests: 0, mailNotSent: 1 });
    expect((await row(p.org)).settings.readonlyExpiry.noticeMail).toBe("failed");
    // nach 6 Stunden (nächster Cron): noch kein neuer Versuch
    mailMode = "ok";
    expect(await run([p.org], new Date(t0.getTime() + 6 * 3600_000))).toMatchObject({ notices: 0, mailNotSent: 1 });
    expect(sent).toEqual([]);
    // nach 25 Stunden: erneuter Versuch, jetzt zugestellt; Termin bleibt der späteste (≥ Versuch + 30 Tage)
    const t1 = new Date(t0.getTime() + 25 * 3600_000);
    expect(await run([p.org], t1)).toMatchObject({ notices: 1, requests: 0, mailNotSent: 0 });
    const st = (await row(p.org)).settings.readonlyExpiry;
    expect(st).toMatchObject({ noticeSentAt: t1.toISOString(), noticeMail: "sent" });
    expect(Date.parse(st.deletionAt)).toBe(Math.max(p.deletionAt.getTime(), t1.getTime() + 30 * DAY));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(Date.parse(st.deletionAt))));
    // Posteingang nur einmal (Erstankündigung); danach keine weiteren Versuche
    expect(await inbox(p.org)).toHaveLength(1);
    expect(await run([p.org], new Date(t1.getTime() + 2 * DAY))).toMatchObject({ notices: 0 });
    expect(sent).toHaveLength(1);
    // mit Betreiber-Vermerk kein erneuter Versuch
    mailMode = "unconfigured";
    const q = await practice({ deleteInDays: 40, now: t0 });
    await run([q.org], t0);
    const admin = await f.user();
    await mod.recordManualNotice(admin, q.org, { receivedOn: t0.toISOString().slice(0, 10), via: "letter", note: "Brief an die Praxisanschrift" }, t0);
    const before = (await row(q.org)).settings.readonlyExpiry.noticeSentAt;
    mailMode = "ok";
    expect(await run([q.org], new Date(t0.getTime() + 3 * DAY))).toMatchObject({ notices: 0 });
    expect((await row(q.org)).settings.readonlyExpiry.noticeSentAt).toBe(before);
  });

  it("Code CR-2: Wiederholungen ohne Steuerberatung, höchstens 3 Versuche, ohne Versand keine Audit-Zeile je Versuch", async () => {
    const t0 = new Date();
    const H = 3600_000;
    // a) Inhaber:in lehnt ab, Steuerberatung erhält die Ankündigung beim ersten Versuch – Wiederholungen nur an die Inhaber:in
    const p = await practice({ deleteInDays: 40, now: t0 });
    const acc = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant')", [p.org, acc]);
    const accEmail = (await f.pool.query("select email from users where id=$1", [acc])).rows[0].email as string;
    rejectTo.add(p.email);
    for (const h of [0, 25, 50]) expect(await run([p.org], new Date(t0.getTime() + h * H))).toMatchObject({ notices: 1, requests: 0 });
    expect(sent.map((m) => m.to)).toEqual([accEmail]);
    let st = (await row(p.org)).settings.readonlyExpiry;
    expect(st).toMatchObject({ noticeAttempts: 3, noticeMail: "failed", accountantNotified: true });
    // vierter Versuch entfällt – nur noch Pflichtaktion beim Betreiber
    rejectTo.delete(p.email);
    expect(await run([p.org], new Date(t0.getTime() + 75 * H))).toMatchObject({ notices: 0, mailNotSent: 1 });
    expect(sent).toHaveLength(1);
    expect((await row(p.org)).settings.readonlyExpiry.noticeAttempts).toBe(3);
    const meta = (await audits(p.org, "org.readonly_expiry_notice")).map((r) => r.meta);
    expect(meta).toHaveLength(3);
    expect(meta.map((m) => m.attempt ?? 1)).toEqual([1, 2, 3]);
    // b) ohne Plattform-SMTP: Audit-Zeile nur beim Erstversuch, Versuche ebenfalls begrenzt
    mailMode = "unconfigured";
    const q = await practice({ deleteInDays: 40, now: t0 });
    for (const h of [0, 25, 50, 75, 100]) await run([q.org], new Date(t0.getTime() + h * H));
    st = (await row(q.org)).settings.readonlyExpiry;
    expect(st).toMatchObject({ noticeAttempts: 3, noticeMail: "not_configured" });
    expect(st.accountantNotified).toBeUndefined();
    expect(await audits(q.org, "org.readonly_expiry_notice")).toEqual([{ meta: expect.objectContaining({ mail: "not_configured" }) }]);
    // c) zuvor nichts versendet (kein Plattform-SMTP): die Steuerberatung erhält den ersten tatsächlich versendeten Versuch
    const r = await practice({ deleteInDays: 40, now: t0 });
    const acc2 = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant')", [r.org, acc2]);
    await run([r.org], t0);
    mailMode = "ok";
    await run([r.org], new Date(t0.getTime() + 25 * H));
    expect(sent.slice(1).map((m) => m.to).sort()).toEqual([r.email, (await f.pool.query("select email from users where id=$1", [acc2])).rows[0].email].sort());
    // d) Mailserver lehnt alles ab (auch die Steuerberatung): sie gilt nicht als benachrichtigt, der nächste Versuch schreibt sie erneut an
    const s = await practice({ deleteInDays: 40, now: t0 });
    const acc3 = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant')", [s.org, acc3]);
    const acc3Email = (await f.pool.query("select email from users where id=$1", [acc3])).rows[0].email as string;
    rejectTo.add(s.email);
    rejectTo.add(acc3Email);
    await run([s.org], t0);
    expect((await row(s.org)).settings.readonlyExpiry).toMatchObject({ noticeMail: "failed", noticeAttempts: 1 });
    expect((await row(s.org)).settings.readonlyExpiry.accountantNotified).toBeUndefined();
    rejectTo.delete(s.email);
    rejectTo.delete(acc3Email);
    const before = sent.length;
    await run([s.org], new Date(t0.getTime() + 25 * H));
    expect(sent.slice(before).map((m) => m.to).sort()).toEqual([s.email, acc3Email].sort());
    expect((await row(s.org)).settings.readonlyExpiry).toMatchObject({ noticeMail: "sent", accountantNotified: true });
  });

  it("Code CR-1: begonnener Löschlauf (purgeStartedAt) – Tarifbuchung setzt die automatische Löschung nicht zurück, Betreiber-Hinweis", async () => {
    const now = new Date();
    const p = await practice({ deleteInDays: 5, now });
    await run([p.org], now);
    expect((await row(p.org)).deletion_requested_at).not.toBeNull();
    await owner.query("update organizations set settings = settings || jsonb_build_object('purgeStartedAt', now()::text) where id=$1", [p.org]);
    const { db } = await import("@/db");
    expect(await mod.stopAutoDeletion(db, p.org, { trigger: "billing:checkout.session.completed" })).toBe(false);
    // Cron: kein Audit je Lauf (alle 6 h), nur Protokoll
    expect(await mod.stopAutoDeletion(db, p.org, { trigger: "cron" })).toBe(false);
    const o = await row(p.org);
    expect(o.deletion_requested_at).not.toBeNull();
    expect(o.settings).toMatchObject({ deletionReason: "auto_readonly_expiry", readonlyExpiry: expect.objectContaining({ noticeMail: "sent" }) });
    expect(await audits(p.org, "org.readonly_expiry_stopped")).toEqual([]);
    expect(await audits(p.org, "org.readonly_expiry_stop_blocked")).toEqual([{ meta: { trigger: "billing:checkout.session.completed", reason: "purge_started" } }]);
    const { purgeStartedProblem } = await import("@/lib/org-deletion");
    expect(purgeStartedProblem(o.settings)).toMatch(/Löschlauf begonnen/);
    // ohne Marke wie bisher
    await owner.query("update organizations set settings = settings - 'purgeStartedAt' where id=$1", [p.org]);
    expect(await mod.stopAutoDeletion(db, p.org, { trigger: "test" })).toBe(true);
    expect((await row(p.org)).deletion_requested_at).toBeNull();
  });

  it("Recht B-1: nur an die Steuerberatung zugestellt gilt NICHT als Zugang – kein Antrag, Pflichtaktion", async () => {
    const now = new Date();
    const p = await practice({ deleteInDays: 5, now });
    const acc = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant')", [p.org, acc]);
    const accEmail = (await f.pool.query("select email from users where id=$1", [acc])).rows[0].email as string;
    rejectTo.add(p.email);
    expect(await run([p.org], now)).toMatchObject({ notices: 1, requests: 0, mailNotSent: 1 });
    expect(sent.map((m) => m.to)).toEqual([accEmail]);
    expect((await row(p.org)).settings.readonlyExpiry.noticeMail).toBe("failed");
    expect((await row(p.org)).deletion_requested_at).toBeNull();
    // ohne Inhaber:in (nur Steuerberatung): ebenfalls nicht zugestellt
    const q = await practice({ deleteInDays: 5, now });
    await f.pool.query("update memberships set role='accountant' where organization_id=$1", [q.org]);
    await run([q.org], now);
    expect((await row(q.org)).settings.readonlyExpiry.noticeMail).toBe("no_recipient");
    expect((await row(q.org)).deletion_requested_at).toBeNull();
    // Inhaber:in angenommen, Steuerberatung abgelehnt: zugestellt
    const r = await practice({ deleteInDays: 5, now });
    const acc2 = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant')", [r.org, acc2]);
    rejectTo.add((await f.pool.query("select email from users where id=$1", [acc2])).rows[0].email);
    expect(await run([r.org], now)).toMatchObject({ notices: 1, requests: 1 });
    expect((await row(r.org)).settings.readonlyExpiry.noticeMail).toBe("sent");
  });

  it("Empfänger: Inhaber:innen und Steuerberatung (accountant), nicht andere Rollen", async () => {
    const now = new Date();
    const p = await practice({ deleteInDays: 40, now });
    const acc = await f.user();
    const recep = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'accountant'), ($1,$3,'reception')", [p.org, acc, recep]);
    const email = async (u: string) => (await f.pool.query("select email from users where id=$1", [u])).rows[0].email as string;
    await run([p.org], now);
    expect(sent.map((m) => m.to).sort()).toEqual([p.email, await email(acc)].sort());
    expect(sent[0].text).toMatch(/dein Vertrag für die Praxis „.+“ in PodoHero endete am/);
  });

  it("Stopp über Plattform-Konsole (Test verlängern) und Aktionscode", async () => {
    const now = new Date();
    const a = await practice({ deleteInDays: 5, now, kind: "trial" });
    const b = await practice({ deleteInDays: 5, now, kind: "trial" });
    await run([a.org, b.org], now);
    expect((await row(a.org)).deletion_requested_at).not.toBeNull();
    const admin = await f.user();
    await platform.extendTrial(admin, a.org, 14);
    let o = await row(a.org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.readonlyExpiry).toBeUndefined();
    expect(await audits(a.org, "org.readonly_expiry_stopped")).toEqual([{ meta: { trigger: "platform.trial_extended" } }]);
    // Aktionscode (Abo-Seite) startet eine neue Testphase
    const code = `TRO${sfx().toUpperCase()}`;
    await promo.createPromoCode(admin, { code, label: "Test Nur-Lesen", trialDays: 30, grantPlan: null, maxRedemptions: 1, validUntil: new Date(Date.now() + 10 * DAY), campaignId: null });
    try {
      await promo.redeemPromoCodeForOrganization(b.org, b.user, code);
      o = await row(b.org);
      expect(o.deletion_requested_at).toBeNull();
      expect(o.settings.readonlyExpiry).toBeUndefined();
      expect(await audits(b.org, "org.readonly_expiry_stopped")).toEqual([{ meta: { trigger: "promo.redeemed" } }]);
      expect(await run([b.org], now)).toMatchObject({ notices: 0, requests: 0 });
    } finally {
      await owner.query("delete from promo_redemptions where code_id in (select id from promo_codes where code = $1)", [code]);
      await owner.query("delete from promo_codes where code = $1", [code]);
    }
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
    // angekündigter Termin erreicht (Antrag vor 31 Tagen)
    await owner.query(
      "update organizations set deletion_requested_at = now() - interval '31 days', settings = jsonb_set(jsonb_set(settings, '{readonlyExpiry,deletionAt}', to_jsonb((now() - interval '1 day')::text)), '{readonlyExpiry,noticeSentAt}', to_jsonb((now() - interval '45 days')::text)) where id=$1",
      [p.org],
    );
    // Tarif gebucht, ohne dass Cron/Webhook den Antrag schon entfernt hat (z. B. Plattform-Konsole direkt in der DB)
    await owner.query("update organizations set subscription_status='active', current_period_end = now() + interval '30 days' where id=$1", [p.org]);
    const c = await owner.connect();
    try {
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_obsolete" });
      // wieder beendet → Löschung zulässig (Probelauf)
      await owner.query("update organizations set subscription_status='canceled', current_period_end = $2 where id=$1", [p.org, p.end]);
      const dry = await purge.purgeOrganization(c, p.org, { execute: false, billing: null });
      expect(dry.executed).toBe(false);
      // Probelauf-Liste zeigt den Zustellstatus
      const due = (await purge.findDueOrganizations(c)).find((x) => x.id === p.org);
      expect(due?.autoNotice).toMatchObject({ noticeMail: "sent", manualNoticeAt: null });
      // angekündigter Termin noch nicht erreicht → kein Löschen
      await owner.query("update organizations set settings = jsonb_set(settings, '{readonlyExpiry,deletionAt}', to_jsonb((now() + interval '3 days')::text)) where id=$1", [p.org]);
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_too_early" });
      await owner.query("update organizations set settings = jsonb_set(settings, '{readonlyExpiry,deletionAt}', to_jsonb((now() - interval '1 day')::text)) where id=$1", [p.org]);
      // Ankündigung nicht zugestellt (ohne Vermerk) → kein Löschen; mit Vermerk vor > 30 Tagen → zulässig
      await owner.query("update organizations set settings = jsonb_set(settings, '{readonlyExpiry,noticeMail}', '\"failed\"') where id=$1", [p.org]);
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_notice_not_delivered" });
      await owner.query("update organizations set settings = jsonb_set(settings, '{readonlyExpiry,manualNoticeAt}', to_jsonb((now() - interval '5 days')::text)) where id=$1", [p.org]);
      await expect(purge.purgeOrganization(c, p.org, { execute: false, billing: null })).rejects.toMatchObject({ kind: "auto_deletion_too_early" });
      await owner.query("update organizations set settings = jsonb_set(settings, '{readonlyExpiry,manualNoticeAt}', to_jsonb((now() - interval '31 days')::text)) where id=$1", [p.org]);
      expect((await purge.purgeOrganization(c, p.org, { execute: false, billing: null })).executed).toBe(false);
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
