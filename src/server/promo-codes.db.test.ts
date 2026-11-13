/**
 * Aktionscodes gegen eine echte Datenbank: Einlösen bei Registrierung und später (Abo-Seite), nur einmal je Praxis,
 * Obergrenze auch bei parallelen Einlösungen, abgelaufene/deaktivierte Codes, laufendes Abo, DB-Sicherungen (Trigger/CHECK).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", async (orig) => {
  const m = await orig<typeof import("@/lib/audit")>();
  return { audit: vi.fn(m.audit) };
});
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import type { StripeEvent } from "@/integrations/stripe/types";
import { PROMO_INVALID } from "@/lib/promo-codes";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const day = 86_400_000;
const sfx = Math.random().toString(36).slice(2, 7).toUpperCase();
const C = (name: string) => `T${sfx}-${name}`;

(TEST_DB ? describe : describe.skip)("Aktionscodes (DB)", () => {
  const f = fixtures(TEST_DB!);
  let p: typeof import("./promo-codes");
  let db: typeof import("@/db");
  let admin: string;
  let auditCalls: () => { action: string; organizationId?: string | null; meta?: Record<string, unknown> }[];

  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? TEST_DB, max: 1 });
  const org = async (patch: { plan?: string; status?: string; trialEndsAt?: Date | null; stripeSub?: string | null; stripeCustomer?: string | null } = {}) => {
    const id = await f.org();
    await f.pool.query("update organizations set plan = $2, subscription_status = $3, trial_ends_at = $4, stripe_subscription_id = $5, stripe_customer_id = $6 where id = $1", [
      id,
      patch.plan ?? "trial",
      patch.status ?? "trialing",
      patch.trialEndsAt === undefined ? new Date(Date.now() + 30 * day) : patch.trialEndsAt,
      patch.stripeSub ?? null,
      patch.stripeCustomer ?? null,
    ]);
    return id;
  };
  const orgRow = async (id: string) => (await f.pool.query("select plan, subscription_status, trial_ends_at, seats from organizations where id = $1", [id])).rows[0];
  const code = (name: string, x: Partial<import("./promo-codes").PromoCodeInput> = {}) =>
    p.createPromoCode(admin, { code: C(name), label: `Test ${name}`, trialDays: 90, grantPlan: null, maxRedemptions: null, validUntil: null, campaignId: null, generated: true, ...x });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    p = await import("./promo-codes");
    db = await import("@/db");
    const { audit } = await import("@/lib/audit");
    auditCalls = () => vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; organizationId?: string | null; meta?: Record<string, unknown> });
    admin = await f.user();
  });
  afterAll(async () => {
    // Einlösungen darf die App-Rolle nicht löschen (scripts/migrate.ts) → Aufräumen als Eigentümer
    await owner.query("delete from promo_redemptions where code_id in (select id from promo_codes where code like $1)", [`T${sfx}-%`]);
    await owner.query("delete from promo_codes where code like $1", [`T${sfx}-%`]);
    await owner.end();
    await f.end();
    await (db.db.$client as { end: () => Promise<void> }).end();
  });

  it("Anlegen normalisiert den Code und lehnt Dubletten/ungültige Eingaben ab", async () => {
    const id = await p.createPromoCode(admin, { code: ` t${sfx.toLowerCase()}-herbst `, label: "Herbst", trialDays: 90, grantPlan: null, maxRedemptions: null, validUntil: null, campaignId: null, generated: true });
    expect((await f.pool.query("select code from promo_codes where id = $1", [id])).rows[0].code).toBe(C("HERBST"));
    await expect(code("HERBST")).rejects.toThrow(/bereits/);
    await expect(p.createPromoCode(admin, { code: "a!", label: "x", trialDays: 90, grantPlan: null, maxRedemptions: null, validUntil: null, campaignId: null })).rejects.toThrow(/Code/);
    await expect(code("NULL", { trialDays: 0 })).rejects.toThrow(/Testphase/);
    await expect(code("ALT", { validUntil: new Date(Date.now() - day) })).rejects.toThrow(/Vergangenheit/);
    expect(auditCalls().some((a) => a.action === "promo.code_created")).toBe(true);
    expect(await p.lookupPromoCode(C("herbst"))).toEqual({ code: C("HERBST"), trialDays: 90, grantPlan: null, validUntil: null, limited: false });
    // selbst gewählte Codes: mindestens 6 Zeichen und Höchstzahl ODER Ablaufdatum
    await expect(p.createPromoCode(admin, { code: C("OWN"), label: "x", trialDays: 90, grantPlan: null, maxRedemptions: null, validUntil: null, campaignId: null })).rejects.toThrow(/Höchstzahl an Einlösungen oder ein Ablaufdatum/);
    await expect(p.createPromoCode(admin, { code: "ABCDE", label: "x", trialDays: 90, grantPlan: null, maxRedemptions: 5, validUntil: null, campaignId: null })).rejects.toThrow(/mindestens 6/);
    await p.createPromoCode(admin, { code: C("OWN"), label: "x", trialDays: 90, grantPlan: null, maxRedemptions: 5, validUntil: null, campaignId: null });
    expect(await p.lookupPromoCode(C("OWN"))).toMatchObject({ limited: true, validUntil: null });
    expect(await p.lookupPromoCode(C("GIBTSNICHT"))).toBeNull();
    expect(await p.lookupPromoCode("x")).toBeNull();
  });

  it("Registrierung: Testphase = jetzt + 90 Tage statt 30 (in der Transaktion der Registrierung)", async () => {
    const o = await org();
    const now = new Date();
    const r = await db.db.transaction((tx) => p.redeemPromoCodeTx(tx, { input: C("herbst"), organizationId: o, userId: admin, via: "signup", now }));
    expect(r.trialEndsAt.getTime()).toBe(now.getTime() + 90 * day);
    const row = await orgRow(o);
    expect(row).toMatchObject({ plan: "trial", subscription_status: "trialing" });
    expect(new Date(row.trial_ends_at).getTime()).toBe(now.getTime() + 90 * day);
    expect((await f.pool.query("select via, redeemed_by from promo_redemptions where organization_id = $1", [o])).rows).toEqual([{ via: "signup", redeemed_by: admin }]);
    expect(auditCalls().find((a) => a.action === "promo.redeemed" && a.organizationId === o)?.meta).toMatchObject({ code: C("HERBST"), via: "signup", trialDays: 90 });
    // je Praxis nur einmal – auch mit einem anderen Code
    await code("ZWEITER");
    await expect(p.redeemPromoCodeForOrganization(o, admin, C("ZWEITER"))).rejects.toThrow(/bereits/);
    // Fehler in der Transaktion rollt alles zurück (z. B. ungültiger Code bei der Registrierung)
    const o2 = await org();
    await expect(db.db.transaction(async (tx) => {
      await tx.execute(sql`update organizations set name = 'geändert' where id = ${o2}`);
      await p.redeemPromoCodeTx(tx, { input: C("FALSCH"), organizationId: o2, userId: admin, via: "signup" });
    })).rejects.toThrow(PROMO_INVALID);
    expect((await f.pool.query("select name from organizations where id = $1", [o2])).rows[0].name).not.toBe("geändert");
  });

  it("später (Abo-Seite): abgelaufene Testphase → ab jetzt; laufende längere Testphase wird nicht verkürzt; Tarif-Umfang", async () => {
    await code("SPAET");
    const expired = await org({ trialEndsAt: new Date(Date.now() - 10 * day) });
    const now = new Date();
    const r = await p.redeemPromoCodeForOrganization(expired, admin, C("spaet"), now);
    expect(r.trialEndsAt.getTime()).toBe(now.getTime() + 90 * day);
    expect(await orgRow(expired)).toMatchObject({ subscription_status: "trialing" });

    const long = new Date(Date.now() + 200 * day);
    const longOrg = await org({ trialEndsAt: long });
    expect((await p.redeemPromoCodeForOrganization(longOrg, admin, C("SPAET"))).trialEndsAt.getTime()).toBe(long.getTime());

    await code("PRAXIS", { grantPlan: "praxis" });
    const free = await org({ plan: "free", status: "none", trialEndsAt: null });
    await p.redeemPromoCodeForOrganization(free, admin, C("PRAXIS"));
    expect(await orgRow(free)).toMatchObject({ plan: "praxis", subscription_status: "trialing", seats: 2 });
  });

  it("laufendes Abo und interne Praxen: kein Einlösen", async () => {
    await code("ABO");
    const paid = await org({ plan: "praxis", status: "active", trialEndsAt: null });
    await expect(p.redeemPromoCodeForOrganization(paid, admin, C("ABO"))).rejects.toThrow(/laufenden Abo/);
    // gleiche Meldung auch für einen erfundenen Code – die Praxis-Prüfung verrät nichts über Codes
    await expect(p.redeemPromoCodeForOrganization(paid, admin, C("ERFUNDEN"))).rejects.toThrow(/laufenden Abo/);
    const stripeTrial = await org({ plan: "praxis", status: "trialing", stripeSub: "sub_test" });
    await expect(p.redeemPromoCodeForOrganization(stripeTrial, admin, C("ABO"))).rejects.toThrow(/laufenden Abo/);
    const internal = await org({ plan: "internal", status: "active", trialEndsAt: null });
    await expect(p.redeemPromoCodeForOrganization(internal, admin, C("ABO"))).rejects.toThrow(/Interne/);
    // SEPA: Abo angelegt, Zahlung noch offen (Status „none“) → laufendes Abo
    const sepa = await org({ plan: "praxis", status: "none", trialEndsAt: null, stripeSub: "sub_sepa", stripeCustomer: `cus_sepa_${sfx}` });
    await expect(p.redeemPromoCodeForOrganization(sepa, admin, C("ABO"))).rejects.toThrow(/laufenden Abo/);
    // beendetes Abo: Abo-ID wird entfernt → danach Kostenlos-Wechsel möglich, Kunden-ID bleibt (neuer Checkout)
    const cus = `cus_alt_${sfx}`;
    const canceled = await org({ plan: "praxis", status: "canceled", trialEndsAt: null, stripeSub: "sub_alt", stripeCustomer: cus });
    await expect(p.redeemPromoCodeForOrganization(canceled, admin, C("ABO"))).resolves.toMatchObject({ plan: "trial" });
    expect((await f.pool.query("select stripe_subscription_id, stripe_customer_id, subscription_status from organizations where id = $1", [canceled])).rows[0]).toEqual({ stripe_subscription_id: null, stripe_customer_id: cus, subscription_status: "trialing" });
    const billing = await import("./billing");
    const { freeSwitchProblem } = await import("@/lib/plans");
    const b = await billing.loadOrgBilling(canceled);
    expect(freeSwitchProblem(b!, 0)).toBeNull();
    // Events des alten Abos ändern während der Code-Testphase nichts; ein neues aktives Abo (Checkout) schon
    const prices = { starter: "price_s", praxis: "price_p", plus: "price_x", seat: "price_seat" };
    const now = Math.floor(Date.now() / 1000) + 60;
    const old = (type: string, status: string, n: number) => ({ id: `evt_${sfx}_${n}`, type, created: now + n, data: { object: { id: "sub_alt", customer: cus, status, items: { data: [] } } } }) as unknown as StripeEvent;
    expect(await billing.processBillingEvent(old("customer.subscription.updated", "past_due", 1), { prices })).toBe("ignored");
    expect(await billing.processBillingEvent(old("customer.subscription.deleted", "canceled", 2), { prices })).toBe("ignored");
    expect(await billing.processBillingEvent(old("invoice.payment_failed", "open", 3), { prices })).toBe("ignored");
    expect(await orgRow(canceled)).toMatchObject({ plan: "trial", subscription_status: "trialing" });
    const fresh = { id: `evt_${sfx}_4`, type: "customer.subscription.created", created: now + 4, data: { object: { id: "sub_neu", customer: cus, status: "active", items: { data: [{ price: { id: "price_p" }, quantity: 1 }] } } } } as unknown as StripeEvent;
    expect(await billing.processBillingEvent(fresh, { prices })).toBe("processed");
    expect(await orgRow(canceled)).toMatchObject({ plan: "praxis", subscription_status: "active" });
    expect((await f.pool.query("select count(*)::int as n from promo_redemptions where organization_id = any($1)", [[paid, stripeTrial, internal]])).rows[0].n).toBe(0);
  });

  it("abgelaufen, deaktiviert oder aufgebraucht → immer dieselbe allgemeine Meldung", async () => {
    const o = await org();
    const id = await code("BALD", { validUntil: new Date(Date.now() + 1000) });
    await expect(p.redeemPromoCodeForOrganization(o, admin, C("BALD"), new Date(Date.now() + 2 * day))).rejects.toThrow(PROMO_INVALID);
    await f.pool.query("update promo_codes set valid_until = now() - interval '1 minute' where id = $1", [id]);
    expect(await p.lookupPromoCode(C("BALD"))).toBeNull();
    await expect(p.redeemPromoCodeForOrganization(o, admin, C("BALD"))).rejects.toThrow(PROMO_INVALID);

    const off = await code("AUS");
    await p.setPromoCodeActive(admin, off, false);
    expect(await p.lookupPromoCode(C("AUS"))).toBeNull();
    await expect(p.redeemPromoCodeForOrganization(o, admin, C("AUS"))).rejects.toThrow(PROMO_INVALID);
    expect(auditCalls().some((a) => a.action === "promo.code_deactivated")).toBe(true);
    await expect(p.redeemPromoCodeForOrganization(o, admin, "")).rejects.toThrow(PROMO_INVALID);
    expect(await f.pool.query("select 1 from promo_redemptions where organization_id = $1", [o])).toMatchObject({ rowCount: 0 });
  });

  it("Obergrenze gilt auch bei parallelen Einlösungen (Zeilensperre + Trigger)", async () => {
    await code("EINMAL", { maxRedemptions: 2 });
    const orgs = await Promise.all([org(), org(), org(), org()]);
    const results = await Promise.allSettled(orgs.map((o) => p.redeemPromoCodeForOrganization(o, admin, C("EINMAL"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toContain(PROMO_INVALID);
    expect(await p.lookupPromoCode(C("EINMAL"))).toBeNull();
    const list = await p.listPromoCodes();
    expect(list.find((c) => c.code === C("EINMAL"))).toMatchObject({ redemptions: 2, usable: false, converted: 0 });
  });

  it("DB-Sicherungen: Trigger lehnt direkte Einlösung inaktiver Codes ab, Code/Tage unveränderbar, Einlösung unveränderbar", async () => {
    const id = await code("DIREKT");
    const o = await org();
    await f.pool.query("update promo_codes set active = false where id = $1", [id]);
    await expect(f.pool.query("insert into promo_redemptions (code_id, organization_id, via, trial_ends_after) values ($1, $2, 'abo', now())", [id, o])).rejects.toThrow(/promo_code_unavailable/);
    await expect(f.pool.query("update promo_codes set trial_days = 365 where id = $1", [id])).rejects.toThrow(/unveränderbar/);
    await expect(f.pool.query("update promo_codes set code = 'ANDERS' where id = $1", [id])).rejects.toThrow(/unveränderbar/);
    await expect(f.pool.query("insert into promo_codes (code, label, trial_days) values ('ab', 'x', 90)")).rejects.toThrow(/promo_codes_code_check/);
    await f.pool.query("update promo_codes set active = true where id = $1", [id]);
    await f.pool.query("insert into promo_redemptions (code_id, organization_id, via, trial_ends_after) values ($1, $2, 'abo', now())", [id, o]);
    // App-Rolle: weder ändern noch löschen (scripts/migrate.ts); als Eigentümer greift der Trigger
    await expect(f.pool.query("update promo_redemptions set via = 'signup' where organization_id = $1", [o])).rejects.toThrow(/permission denied/);
    await expect(f.pool.query("delete from promo_redemptions where organization_id = $1", [o])).rejects.toThrow(/permission denied/);
    await expect(owner.query("update promo_redemptions set via = 'signup' where organization_id = $1", [o])).rejects.toThrow(/unveränderbar/);
    await expect(f.pool.query("insert into promo_redemptions (code_id, organization_id, via, trial_ends_after) values ($1, $2, 'abo', now())", [id, o])).rejects.toThrow(/promo_redemptions_org/);
  });

  it("Einlösungen zeigen Praxis und Umwandlung in ein bezahltes Abo", async () => {
    await code("ZAHLT");
    const o = await org();
    await p.redeemPromoCodeForOrganization(o, admin, C("ZAHLT"));
    await f.pool.query("update organizations set plan = 'praxis', subscription_status = 'active' where id = $1", [o]);
    const reds = await p.listRedemptions();
    expect(reds.find((r) => r.organizationId === o)).toMatchObject({ practiceName: "Testpraxis Fuß", via: "abo", converted: true });
    expect(await p.redemptionForOrganization(o)).toMatchObject({ code: C("ZAHLT"), trialDays: 90 });
  });

  it("Code im Kostenlos-Tarif eingelöst: nach Ablauf automatisch zurück (höchstens 20 Patient:innen), sonst Nur-Lesen", async () => {
    await code("FREI");
    const ownerUser = await f.user();
    const team = await f.user();
    const make = async () => {
      const o = await org({ plan: "free", status: "none", trialEndsAt: null });
      await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'therapist')", [o, ownerUser, team]);
      return o;
    };
    const billing = await import("./billing");
    const o = await make();
    await p.redeemPromoCodeForOrganization(o, ownerUser, C("FREI"));
    expect((await f.pool.query("select previous_plan from promo_redemptions where organization_id = $1", [o])).rows[0].previous_plan).toBe("free");
    expect(await billing.returnPromoTrialToFree(o)).toBe("not_due");
    await f.pool.query("update organizations set trial_ends_at = now() - interval '1 minute' where id = $1", [o]);
    expect(await billing.returnPromoTrialToFree(o)).toBe("switched");
    expect(await orgRow(o)).toMatchObject({ plan: "free", subscription_status: "none", seats: 1 });
    expect((await f.pool.query("select user_id, active from memberships where organization_id = $1 order by active desc", [o])).rows).toEqual([
      { user_id: ownerUser, active: true },
      { user_id: team, active: false },
    ]);
    expect((await f.pool.query("select settings->'promoReturnFree' as x from organizations where id = $1", [o])).rows[0].x).toBeNull();
    expect(await billing.returnPromoTrialToFree(o)).toBe("not_due");

    // mehr als 20 Patient:innen: bleibt nur lesbar, Merker wird entfernt
    const big = await make();
    await p.redeemPromoCodeForOrganization(big, ownerUser, C("FREI"));
    for (let i = 0; i < 21; i++) await f.patient(big, { lastName: `P${i}` });
    await f.pool.query("update organizations set trial_ends_at = now() - interval '1 minute' where id = $1", [big]);
    expect(await billing.returnPromoTrialToFree(big)).toBe("kept");
    expect(await orgRow(big)).toMatchObject({ plan: "trial", subscription_status: "trialing" });
    expect((await f.pool.query("select settings->'promoReturnFree' as x from organizations where id = $1", [big])).rows[0].x).toBeNull();

    // aus der Testphase eingelöst: kein Merker, keine Rückkehr
    const t = await org();
    await p.redeemPromoCodeForOrganization(t, ownerUser, C("FREI"));
    await f.pool.query("update organizations set trial_ends_at = now() - interval '1 minute' where id = $1", [t]);
    expect(await billing.returnPromoTrialToFree(t)).toBe("not_due");
  });
});
