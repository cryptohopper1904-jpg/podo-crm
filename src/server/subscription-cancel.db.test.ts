/**
 * Löschantrag = Kündigung (AGB § 8 Nr. 3): Stripe-Abo zum Periodenende kündigen, bei Rücknahme nur die eigene Kündigung
 * aufheben, Fehler sichtbar machen, „Abo kündigen“ auf der Abo-Seite, Webhook-Konsistenz und Löschlauf mit aktivem Abo.
 * Stripe ist durch eine Fälschung im Speicher ersetzt – keine echten Aufrufe. Erfundene Daten.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingPort, OpenBillingItems, SubscriptionInfo } from "@/integrations/stripe/types";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const authState = vi.hoisted(() => ({ org: "", user: "", role: "owner", support: false, perms: [] as string[], opts: [] as unknown[] }));
vi.mock("@/lib/auth/session", () => ({
  requireAuth: async (perm?: string, opts?: unknown) => {
    if (perm) authState.perms.push(perm);
    authState.opts.push(opts);
    return {
      organization: { id: authState.org, name: "Testpraxis Fuß", state: "BE" },
      user: { id: authState.user, email: "inhaber@example.org" },
      role: authState.role,
      support: authState.support ? { grantId: "g" } : null,
      can: () => true,
    };
  },
  requestMeta: async () => ({ ip: null }),
  revokeUserSessions: async () => undefined,
}));

/** Stripe-Fälschung: Abos im Speicher, Aufrufprotokoll, gezielte Fehler */
class FakeStripe {
  readonly isMock = false;
  subs = new Map<string, SubscriptionInfo>();
  calls: string[] = [];
  deletedCustomers: string[] = [];
  fail = false;
  /** nur Rücknahmen (set …:false) schlagen fehl */
  failResume = false;
  open: OpenBillingItems = { openInvoices: 0, openInvoiceCents: 0, pendingItems: 0, pendingItemCents: 0, truncated: false };
  private clock = 1_800_000_000;
  add(id: string, s: Partial<SubscriptionInfo> = {}) {
    const start = new Date(Date.now() - 10 * 86_400_000);
    this.subs.set(id, {
      id,
      status: "active",
      cancelAtPeriodEnd: false,
      cancelReason: null,
      customerId: null,
      currentPeriodStart: start,
      currentPeriodEnd: new Date(start.getTime() + 30 * 86_400_000),
      canceledAt: null,
      interval: "month",
      intervalCount: 1,
      ...s,
    });
  }
  private check(op: string) {
    this.calls.push(op);
    if (this.fail) throw Object.assign(new Error("Stripe: /subscriptions fehlgeschlagen (HTTP 500): kaputt"), { name: "BillingHttpError" });
  }
  async getSubscription(id: string) {
    this.check(`get:${id}`);
    const s = this.subs.get(id);
    return s ? { ...s } : null;
  }
  async setCancelAtPeriodEnd(id: string, cancel: boolean, reason: string | null) {
    this.check(`set:${id}:${cancel}:${reason ?? ""}`);
    if (!cancel && this.failResume) throw Object.assign(new Error("Stripe: Rücknahme fehlgeschlagen (HTTP 502)"), { name: "BillingHttpError" });
    const s = this.subs.get(id)!;
    // wie Stripe: canceled_at = Zeitpunkt der (letzten) Kündigungsanfrage
    Object.assign(s, { cancelAtPeriodEnd: cancel, cancelReason: reason, canceledAt: cancel ? ++this.clock : null });
    return { ...s };
  }
  /** Kündigung im Kundenportal: Metadaten bleiben, canceled_at ändert sich */
  portalCancel(id: string) {
    Object.assign(this.subs.get(id)!, { cancelAtPeriodEnd: true, canceledAt: ++this.clock });
  }
  async listSubscriptions(customerId: string) {
    this.check(`list:${customerId}`);
    return [...this.subs.values()].filter((s) => s.customerId === customerId).map((s) => ({ ...s }));
  }
  async openBillingItems(customerId: string) {
    this.check(`open:${customerId}`);
    return { ...this.open };
  }
  async cancelSubscriptionNow(id: string) {
    this.check(`cancel_now:${id}`);
    const s = this.subs.get(id);
    if (!s) return null;
    Object.assign(s, { status: "canceled", cancelAtPeriodEnd: false });
    return { ...s };
  }
  async deleteCustomer(id: string) {
    this.check(`delete_customer:${id}`);
    this.deletedCustomers.push(id);
  }
  async createCheckoutSession(): Promise<{ id: string; url: string }> {
    throw new Error("nicht benutzt");
  }
  async createPortalSession(): Promise<{ url: string }> {
    throw new Error("nicht benutzt");
  }
  verifyWebhook(): never {
    throw new Error("nicht benutzt");
  }
}
const fake = vi.hoisted(() => ({ port: null as unknown }));
vi.mock("@/integrations/stripe", async (orig) => ({ ...(await orig<typeof import("@/integrations/stripe")>()), getBillingPort: () => fake.port }));

import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const ownerUrlFrom = (url: string) => url.replace(/\/\/[^@]+@/, "//podo_owner:podo_owner@");
const sfx = () => Math.random().toString(36).slice(2, 10);

(TEST_DB ? describe : describe.skip)("Löschantrag kündigt das Abo (DB, Stripe gefälscht)", () => {
  const f = fixtures(TEST_DB!);
  const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL ?? ownerUrlFrom(TEST_DB ?? ""), max: 2 });
  let stripe: FakeStripe;
  let daten: typeof import("@/app/(app)/einstellungen/daten/actions");
  let abo: typeof import("@/app/(app)/einstellungen/abo/actions");
  let billing: typeof import("./billing");
  let purge: typeof import("./purge-organization");
  let lib: typeof import("@/lib/subscription-cancel");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    daten = await import("@/app/(app)/einstellungen/daten/actions");
    abo = await import("@/app/(app)/einstellungen/abo/actions");
    billing = await import("./billing");
    purge = await import("./purge-organization");
    lib = await import("@/lib/subscription-cancel");
  });
  afterAll(async () => {
    await f.end();
    await owner.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });
  beforeEach(() => {
    stripe = new FakeStripe();
    fake.port = stripe as unknown as BillingPort;
    authState.role = "owner";
    authState.support = false;
    authState.perms = [];
    authState.opts = [];
  });

  /** Praxis mit laufendem Stripe-Abo (Tarif Praxis) und Inhaber:in */
  async function setup(opts: { sub?: Partial<SubscriptionInfo> | null; status?: string } = {}) {
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    const subId = `sub_${sfx()}`;
    const cusId = `cus_${sfx()}`;
    if (opts.sub !== null) {
      await f.pool.query(
        "update organizations set plan='praxis', subscription_status=$2, stripe_subscription_id=$3, stripe_customer_id=$4, current_period_end=now() + interval '20 days' where id=$1",
        [org, opts.status ?? "active", subId, cusId],
      );
      stripe.add(subId, { customerId: cusId, ...opts.sub });
    }
    authState.org = org;
    authState.user = user;
    return { org, user, subId, cusId };
  }
  const orgRow = async (org: string) =>
    (await f.pool.query("select deletion_requested_at, settings, subscription_status, current_period_end from organizations where id=$1", [org])).rows[0];
  const audits = async (org: string, action: string) =>
    f.asOrg(org, async (c) => (await c.query("select meta, user_id from audit_log where organization_id=$1 and action=$2", [org, action])).rows);
  const request = () => daten.requestDeletionAction(undefined, fd({ acknowledge: "on", confirmName: "Testpraxis Fuß" }));
  const withdraw = () => daten.cancelDeletionAction(undefined, fd({}));

  it("Löschantrag setzt cancel_at_period_end=true mit Herkunft; Rücknahme setzt es zurück", async () => {
    const { org, user, subId } = await setup();
    const r = await request();
    expect(r?.ok).toMatch(/Kündigung und Löschung beantragt\. Dein Abo endet zum \d\d\.\d\d\.\d{4}; danach wird nichts mehr abgebucht\./);
    expect(r?.warning).toBeUndefined();
    expect(stripe.subs.get(subId)).toMatchObject({ cancelAtPeriodEnd: true, cancelReason: "deletion_request" });
    let o = await orgRow(org);
    expect(o.deletion_requested_at).not.toBeNull();
    expect(o.settings).toMatchObject({ billingCancelAtPeriodEnd: true, billingCancelReason: "deletion_request" });
    expect(await audits(org, "billing.cancel_at_period_end")).toEqual([expect.objectContaining({ user_id: user, meta: expect.objectContaining({ trigger: "deletion_request" }) })]);
    expect(lib.deletionBillingProblem({ ...o, plan: "praxis", subscriptionStatus: "active", stripeSubscriptionId: subId, deletionRequestedAt: o.deletion_requested_at })).toBeNull();
    const confirm = await f.asOrg(org, async (c) => (await c.query("select subject, body from messages where organization_id=$1", [org])).rows);
    expect(confirm).toEqual([{ subject: "Kündigung bestätigt", body: expect.stringMatching(/^Mit deinem Löschantrag ist dein PodoHero-Abo zum \d\d\.\d\d\.\d{4} gekündigt \(Vertragsende\)/) }]);

    const w = await withdraw();
    expect(w?.ok).toMatch(/Auch die Kündigung ist zurückgenommen – dein Abo läuft weiter\./);
    expect(stripe.subs.get(subId)).toMatchObject({ cancelAtPeriodEnd: false, cancelReason: null });
    expect(stripe.calls.filter((c) => c.startsWith("set:"))).toEqual([`set:${subId}:true:deletion_request`, `set:${subId}:false:`]);
    o = await orgRow(org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.billingCancelAtPeriodEnd).toBe(false);
    expect(o.settings.billingCancelReason).toBeUndefined();
    expect(await audits(org, "billing.cancel_withdrawn")).toHaveLength(1);
  });

  it("separat im Kundenportal ausgesprochene Kündigung bleibt bei der Rücknahme bestehen", async () => {
    const { org, subId } = await setup({ sub: { cancelAtPeriodEnd: true } });
    const r = await request();
    expect(r?.ok).toMatch(/Dein Abo endet zum/);
    expect(stripe.calls.some((c) => c.startsWith("set:"))).toBe(false); // nichts überschrieben, keine Herkunft gesetzt
    expect((await orgRow(org)).settings).toMatchObject({ billingCancelAtPeriodEnd: true });
    expect((await orgRow(org)).settings.billingCancelReason).toBeUndefined();
    const w = await withdraw();
    expect(w?.warning).toMatch(/Dein Abo bleibt gekündigt .* weil die Kündigung separat ausgesprochen wurde/);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(true);
    expect(stripe.calls.some((c) => c.startsWith("set:"))).toBe(false);
  });

  it("Portal: erst fortgesetzt, dann erneut gekündigt (Webhooks) → gilt nicht mehr als Löschantrag", async () => {
    const { org, subId, cusId } = await setup();
    await request();
    const ev = (cancel: boolean, created: number) =>
      billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.updated", created, data: { object: { id: subId, customer: cusId, status: "active", cancel_at_period_end: cancel, metadata: { organizationId: org, cancel_reason: "deletion_request" } } } },
        { prices: {} },
      );
    const now = Math.floor(Date.now() / 1000);
    // eigenes Event (Kündigung) bestätigt den Zustand, Herkunft bleibt
    expect(await ev(true, now + 1)).toBe("processed");
    expect((await orgRow(org)).settings).toMatchObject({ billingCancelAtPeriodEnd: true, billingCancelReason: "deletion_request" });
    // veraltetes Event von vor dem Antrag ändert nichts
    expect(await ev(false, now - 3600)).toBe("ignored");
    expect((await orgRow(org)).settings.billingCancelReason).toBe("deletion_request");
    // Portal: fortsetzen, dann erneut kündigen (Stripe-Metadaten bleiben veraltet „deletion_request“)
    stripe.subs.get(subId)!.cancelAtPeriodEnd = false;
    expect(await ev(false, now + 2)).toBe("processed");
    expect((await orgRow(org)).settings.billingCancelReason).toBeUndefined();
    stripe.subs.get(subId)!.cancelAtPeriodEnd = true;
    expect(await ev(true, now + 3)).toBe("processed");
    expect((await orgRow(org)).settings).toMatchObject({ billingCancelAtPeriodEnd: true });
    const w = await withdraw();
    expect(w?.warning).toMatch(/bleibt gekündigt/);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(true);
    // Abo endet: Merker entfallen
    expect(
      await billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.deleted", created: now + 4, data: { object: { id: subId, customer: cusId, status: "canceled", metadata: { organizationId: org } } } },
        { prices: {} },
      ),
    ).toBe("processed");
    const o = await orgRow(org);
    expect(o.subscription_status).toBe("canceled");
    expect(o.settings.billingCancelAtPeriodEnd).toBe(false);
  });

  it("Stripe-Fehler: Antrag trotzdem gespeichert, Meldung, Audit, Posteingang, Betreiber-Hinweis", async () => {
    const { org, user, subId } = await setup();
    stripe.fail = true;
    const r = await request();
    expect(r?.ok).toBe("Kündigung und Löschung beantragt.");
    expect(r?.warning).toBe("Abo konnte nicht automatisch gekündigt werden – bitte unter Abo kündigen oder Support kontaktieren.");
    const o = await orgRow(org);
    expect(o.deletion_requested_at).not.toBeNull();
    expect(o.settings.billingCancelAtPeriodEnd).toBeUndefined();
    expect(o.settings.billingCancelError).toMatchObject({ trigger: "deletion_request" });
    const failed = await audits(org, "billing.cancel_failed");
    expect(failed).toEqual([{ user_id: user, meta: { trigger: "deletion_request", error: "BillingHttpError" } }]);
    expect(JSON.stringify(failed)).not.toContain("kaputt"); // keine Stripe-Antworttexte im Audit
    const inbox = await f.asOrg(org, async (c) => (await c.query("select subject, body, status, channel, direction from messages where organization_id=$1", [org])).rows);
    expect(inbox).toEqual([expect.objectContaining({ subject: "Abo nicht automatisch gekündigt", status: "new", channel: "none", direction: "inbound" })]);
    expect(lib.deletionBillingProblem({ plan: "praxis", subscriptionStatus: "active", stripeSubscriptionId: subId, deletionRequestedAt: o.deletion_requested_at, settings: o.settings })).toMatch(/fehlgeschlagen/);

    // Rücknahme: keine Kündigung von uns → nichts zu tun, Fehlermerker entfällt
    stripe.fail = false;
    const w = await withdraw();
    expect(w?.ok).toBe("Die Löschung wurde zurückgenommen. Deine Praxis bleibt bestehen.");
    expect(w?.warning).toBeUndefined();
    expect((await orgRow(org)).settings.billingCancelError).toBeUndefined();
    expect(stripe.calls.some((c) => c.startsWith("set:"))).toBe(false);
  });

  it("ohne Stripe-Zugang (Mock-Port) wird ein echtes Abo nie als gekündigt gemeldet", async () => {
    const { org } = await setup();
    const { StripeMock } = await import("@/integrations/stripe/mock");
    fake.port = new StripeMock();
    const r = await request();
    expect(r?.warning).toMatch(/Abo konnte nicht automatisch gekündigt werden/);
    expect((await audits(org, "billing.cancel_failed"))[0].meta.error).toBe("BillingNotConfiguredError");
  });

  it("ohne Abo (Testphase): Löschantrag ohne Stripe-Aufruf", async () => {
    await setup({ sub: null });
    const r = await request();
    expect(r).toEqual({ ok: "Kündigung und Löschung beantragt." });
    expect(stripe.calls).toEqual([]);
  });

  it("Abo-Seite: kündigen und zurücknehmen nur durch Inhaber:in, mit Bestätigung", async () => {
    const { org, subId } = await setup();
    authState.role = "admin";
    expect(await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" }))).toEqual({ error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann das Abo kündigen." });
    expect(await abo.resumeSubscriptionAction()).toEqual({ error: "Nur die Praxisinhaberin bzw. der Praxisinhaber kann die Kündigung zurücknehmen." });
    authState.role = "owner";
    authState.support = true;
    expect((await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" })))?.error).toMatch(/Nur die Praxisinhaberin/);
    authState.support = false;
    expect(await abo.cancelSubscriptionAction(undefined, fd({}))).toEqual({ error: "Bitte bestätige die Kündigung." });
    expect(stripe.calls).toEqual([]);
    expect(authState.perms.every((p) => p === "settings.manage")).toBe(true);

    const c = await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" }));
    expect(c?.ok).toMatch(/^Dein Abo ist zum \d\d\.\d\d\.\d{4} gekündigt\./);
    expect(stripe.subs.get(subId)).toMatchObject({ cancelAtPeriodEnd: true, cancelReason: "owner" });
    expect((await orgRow(org)).settings).toMatchObject({ billingCancelAtPeriodEnd: true, billingCancelReason: "owner" });
    expect((await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" })))?.ok).toMatch(/bereits zum/);

    // Löschantrag danach: Kündigung stammt vom Abo-Weg → Rücknahme des Löschantrags lässt sie bestehen
    await request();
    expect((await abo.resumeSubscriptionAction())?.error).toMatch(/Es läuft ein Löschantrag/);
    expect((await withdraw())?.warning).toMatch(/bleibt gekündigt/);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(true);

    expect(await abo.resumeSubscriptionAction()).toEqual({ ok: "Die Kündigung ist zurückgenommen – dein Abo läuft weiter." });
    expect(stripe.subs.get(subId)).toMatchObject({ cancelAtPeriodEnd: false, cancelReason: null });
    expect((await orgRow(org)).settings.billingCancelAtPeriodEnd).toBe(false);
    expect(await abo.resumeSubscriptionAction()).toEqual({ ok: "Dein Abo ist nicht gekündigt." });

    stripe.fail = true;
    expect((await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" })))?.error).toMatch(/konnte gerade nicht gekündigt werden/);
    // kein Fehler-Hinweis im Posteingang beim Abo-Weg (Nutzer:in sieht die Meldung direkt); Kündigungen werden bestätigt
    const inbox = await f.asOrg(org, async (cl) => (await cl.query("select subject, body from messages where organization_id=$1", [org])).rows);
    expect(inbox.map((m) => m.subject)).toEqual(["Kündigung bestätigt"]);
    // Bestätigung mit konkretem Vertragsende und 12-Monats-Hinweis (Buchhaltung)
    expect(inbox[0].body).toMatch(/^Dein PodoHero-Abo ist zum \d\d\.\d\d\.\d{4} gekündigt \(Vertragsende\)/);
    expect(inbox[0].body).toContain("höchstens 12 Monate lesbar – exportiere rechtzeitig");
  });

  it("Löschantrag im Nur-Lesen-Modus (Testphase abgelaufen): erlaubt (allowReadOnly), ohne Stripe-Aufruf", async () => {
    const { org } = await setup({ sub: null });
    await f.pool.query("update organizations set plan='trial', subscription_status='trialing', trial_ends_at = now() - interval '40 days' where id=$1", [org]);
    expect(await request()).toEqual({ ok: "Kündigung und Löschung beantragt." });
    expect(authState.opts).toContainEqual(expect.objectContaining({ allowReadOnly: true }));
    expect((await orgRow(org)).deletion_requested_at).not.toBeNull();
    expect((await orgRow(org)).settings?.deletionReason).toBeUndefined();
    expect(stripe.calls).toEqual([]);
    // Rücknahme ebenfalls im Nur-Lesen-Modus möglich
    expect((await withdraw())?.ok).toMatch(/Die Löschung wurde zurückgenommen/);
  });

  it("automatischer Löschantrag (Ende Nur-Lesen-Modus) lässt sich nicht zurücknehmen – nur mit Tarif", async () => {
    const { org } = await setup({ sub: null });
    await f.pool.query(
      "update organizations set plan='trial', subscription_status='trialing', trial_ends_at = now() - interval '13 months', deletion_requested_at = now() - interval '2 days', settings = coalesce(settings, '{}'::jsonb) || '{\"deletionReason\":\"auto_readonly_expiry\"}'::jsonb where id=$1",
      [org],
    );
    const w = await withdraw();
    expect(w?.error).toMatch(/erfolgt automatisch, weil der Nur-Lesen-Modus nach 12 Monaten endet/);
    expect((await orgRow(org)).deletion_requested_at).not.toBeNull();
    expect(stripe.calls).toEqual([]);
  });

  it("fremdes Abo (anderer Stripe-Kunde) wird weder gekündigt noch fortgesetzt (AppSec L-4)", async () => {
    const { org, subId } = await setup();
    stripe.subs.get(subId)!.customerId = `cus_fremd${sfx()}`;
    const r = await request();
    expect(r?.warning).toBeTruthy();
    expect(stripe.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
    expect(await audits(org, "billing.cancel_failed")).toEqual([expect.objectContaining({ meta: expect.objectContaining({ error: "SubscriptionCustomerMismatch" }) })]);
    // Rücknahme über die Abo-Seite: fremdes, gekündigtes Abo bleibt unangetastet
    await withdraw();
    stripe.subs.get(subId)!.cancelAtPeriodEnd = true;
    await f.pool.query("update organizations set settings = coalesce(settings, '{}'::jsonb) || '{\"billingCancelAtPeriodEnd\":true}'::jsonb where id=$1", [org]);
    await abo.resumeSubscriptionAction();
    expect(stripe.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(true);
  });

  it("Abo-Seite: ohne laufendes Abo nichts zu kündigen", async () => {
    await setup({ sub: null });
    expect(await abo.cancelSubscriptionAction(undefined, fd({ confirm: "on" }))).toEqual({ error: "Es gibt kein laufendes Abo, das gekündigt werden kann." });
    expect(stripe.calls).toEqual([]);
  });

  it("mehrere Abos desselben Kunden: Antrag kündigt alle, Rücknahme nimmt alle eigenen Kündigungen zurück", async () => {
    const { org, subId, cusId } = await setup();
    const second = `sub_${sfx()}`;
    stripe.add(second, { customerId: cusId });
    const ended = `sub_${sfx()}`;
    stripe.add(ended, { customerId: cusId, status: "canceled" });
    expect((await request())?.ok).toMatch(/Dein Abo endet zum/);
    expect(stripe.subs.get(subId)).toMatchObject({ cancelAtPeriodEnd: true, cancelReason: "deletion_request" });
    expect(stripe.subs.get(second)).toMatchObject({ cancelAtPeriodEnd: true, cancelReason: "deletion_request" });
    expect(stripe.calls).not.toContain(`set:${ended}:true:deletion_request`);
    const marks = (await orgRow(org)).settings.billingCancelMarks as { id: string; at: number }[];
    expect(marks.map((m) => m.id).sort()).toEqual([subId, second].sort());
    expect(marks.every((m) => typeof m.at === "number")).toBe(true);
    const w = await withdraw();
    expect(w?.ok).toMatch(/Auch die Kündigung ist zurückgenommen/);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(false);
    expect(stripe.subs.get(second)?.cancelAtPeriodEnd).toBe(false);
    expect((await orgRow(org)).settings.billingCancelMarks).toBeUndefined();
  });

  it("Rücknahme nur, wenn canceled_at unverändert ist (Portal: fortgesetzt und erneut gekündigt, ohne Webhook)", async () => {
    const { subId } = await setup();
    await request();
    // Portal: erneut gekündigt – Stripe lässt metadata.cancel_reason stehen, canceled_at ist neu
    stripe.portalCancel(subId);
    const w = await withdraw();
    expect(w?.warning).toMatch(/bleibt gekündigt/);
    expect(stripe.subs.get(subId)?.cancelAtPeriodEnd).toBe(true);
    expect(stripe.calls.filter((c) => c.startsWith(`set:${subId}:false`))).toEqual([]);
  });

  it("Status kommt aus dem frisch gelesenen Abo (deckt billingLastEventAt ab)", async () => {
    const { org } = await setup({ sub: { status: "past_due" } });
    await request();
    const o = await orgRow(org);
    expect(o.subscription_status).toBe("past_due");
    expect(typeof o.settings.billingLastEventAt).toBe("number");
  });

  it("fehlgeschlagene Rücknahme: Hinweis, Posteingang, Betreiber-Hinweis", async () => {
    const { org, subId } = await setup();
    await request();
    stripe.failResume = true;
    const w = await withdraw();
    expect(w?.warning).toMatch(/konnte nicht automatisch zurückgenommen werden/);
    const o = await orgRow(org);
    expect(o.deletion_requested_at).toBeNull();
    expect(o.settings.billingCancelError).toMatchObject({ trigger: "resume" });
    const inbox = await f.asOrg(org, async (c) => (await c.query("select subject from messages where organization_id=$1", [org])).rows);
    expect(inbox.map((m) => m.subject).sort()).toEqual(["Kündigung bestätigt", "Kündigung nicht automatisch zurückgenommen"]);
    expect(await audits(org, "billing.resume_failed")).toHaveLength(1);
    expect(lib.resumeBillingProblem({ plan: "praxis", subscriptionStatus: "active", stripeSubscriptionId: subId, settings: o.settings })).toMatch(/Rücknahme der Kündigung fehlgeschlagen/);
    expect(lib.deletionBillingProblem({ plan: "praxis", subscriptionStatus: "active", stripeSubscriptionId: subId, deletionRequestedAt: null, settings: o.settings })).toBeNull();
  });

  it("Rücknahme nach Ende des Abos: eigene Meldung (Nur-Lesen bis zur Wahl eines Tarifs)", async () => {
    const { org, subId } = await setup();
    await request();
    // Abo inzwischen beendet (Webhook), Ende des bezahlten Zeitraums + 14 Tage Kulanz vorbei
    stripe.subs.get(subId)!.status = "canceled";
    await f.pool.query("update organizations set subscription_status='canceled', current_period_end = now() - interval '20 days' where id=$1", [org]);
    const w = await withdraw();
    expect(w).toEqual({
      ok: "Die Löschung wurde zurückgenommen. Deine Praxis bleibt bestehen.",
      warning: "Dein Abo ist bereits beendet. Die Praxis bleibt im Nur-Lesen-Modus, bis du wieder einen Tarif wählst (Einstellungen → Abo).",
    });
  });

  it("Webhook: Event eines weiteren Abos überschreibt die Zuordnung nicht; nach Ende des alten wird ein neues aktives übernommen", async () => {
    const { org, subId, cusId } = await setup();
    const other = `sub_${sfx()}`;
    const now = Math.floor(Date.now() / 1000);
    const ev = (id: string, status: string, created: number) =>
      billing.processBillingEvent(
        { id: `evt_${sfx()}`, type: "customer.subscription.updated", created, data: { object: { id, customer: cusId, status, cancel_at_period_end: false, metadata: { organizationId: org } } } },
        { prices: {} },
      );
    expect(await ev(other, "canceled", now + 1)).toBe("ignored");
    expect(await ev(other, "active", now + 2)).toBe("ignored"); // Praxis-Abo läuft noch
    let o = (await f.pool.query("select stripe_subscription_id, subscription_status from organizations where id=$1", [org])).rows[0];
    expect(o).toEqual({ stripe_subscription_id: subId, subscription_status: "active" });
    await f.pool.query("update organizations set subscription_status='canceled' where id=$1", [org]);
    expect(await ev(other, "active", now + 3)).toBe("processed");
    o = (await f.pool.query("select stripe_subscription_id, subscription_status from organizations where id=$1", [org])).rows[0];
    expect(o).toEqual({ stripe_subscription_id: other, subscription_status: "active" });
  });

  // Löschlauf sperrt Tabellen nur mit NOWAIT und versucht es bei belegten Tabellen erneut (parallele DB-Tests) – mehr Zeit
  describe("Löschlauf", { timeout: 30_000 }, () => {
    async function dueOrg(sub: Partial<SubscriptionInfo> | null) {
      const { org, subId, cusId } = await setup({ sub });
      await owner.query("update organizations set deletion_requested_at = now() - interval '31 days' where id=$1", [org]);
      return { org, subId, cusId };
    }
    const exists = async (org: string) => (await owner.query("select 1 from organizations where id=$1", [org])).rowCount === 1;

    it("beendet ein noch laufendes Abo sofort (ohne Erstattung) und löscht den Stripe-Kunden; Probelauf ändert nichts", async () => {
      // Periode begann vor dem Antrag (vor 31 Tagen) und läuft z. B. bei 31-Tage-Monaten noch kurz
      const { org, subId, cusId } = await dueOrg({ cancelAtPeriodEnd: true, cancelReason: "deletion_request", currentPeriodStart: new Date(Date.now() - 32 * 86_400_000) });
      const c = await owner.connect();
      try {
        const dry = await purge.purgeOrganization(c, org, { execute: false, billing: stripe as unknown as BillingPort });
        expect(dry.stripe).toMatchObject({ subscription: "would_cancel", customer: "would_delete", refundCheck: false, subscriptionId: subId, customerId: cusId });
        expect(stripe.calls).toEqual([`get:${subId}`, `list:${cusId}`, `open:${cusId}`]);
        const lines: string[] = [];
        const r = await purge.purgeOrganization(c, org, { execute: true, billing: stripe as unknown as BillingPort, log: (l) => lines.push(l) });
        expect(r.executed).toBe(true);
        expect(r.stripe).toMatchObject({ subscription: "canceled_now", customer: "deleted", refundCheck: false });
        expect(stripe.calls).toContain(`cancel_now:${subId}`);
        expect(stripe.deletedCustomers).toEqual([cusId]);
        expect(lines.some((l) => l.includes("stripe.subscription_canceled") && l.includes(subId))).toBe(true);
      } finally {
        c.release();
      }
      expect(await exists(org)).toBe(false);
    });

    it("neue Periode nach dem Antrag → Erstattung prüfen; bereits beendetes Abo wird nicht erneut beendet", async () => {
      const a = await dueOrg({ currentPeriodStart: new Date(Date.now() - 2 * 86_400_000) });
      const b = await dueOrg({ status: "canceled", currentPeriodStart: new Date(Date.now() - 40 * 86_400_000) });
      const c = await owner.connect();
      try {
        expect((await purge.purgeOrganization(c, a.org, { execute: true, billing: stripe as unknown as BillingPort })).stripe).toMatchObject({ subscription: "canceled_now", refundCheck: true });
        expect((await purge.purgeOrganization(c, b.org, { execute: true, billing: stripe as unknown as BillingPort })).stripe).toMatchObject({ subscription: "ended", customer: "deleted", refundCheck: false });
        expect(stripe.calls).not.toContain(`cancel_now:${b.subId}`);
      } finally {
        c.release();
      }
    });

    it("Jahresabo → Erstattung prüfen; offene Rechnungen/Positionen im Probelauf; Protokoll mit IDs und refundCheck", async () => {
      const { org, subId, cusId } = await dueOrg({ interval: "year", currentPeriodStart: new Date(Date.now() - 60 * 86_400_000) });
      stripe.open = { openInvoices: 1, openInvoiceCents: 9900, pendingItems: 2, pendingItemCents: 1500, truncated: false };
      const c = await owner.connect();
      try {
        const dry = await purge.purgeOrganization(c, org, { execute: false, billing: stripe as unknown as BillingPort });
        expect(dry.stripe).toMatchObject({ refundCheck: true, subscriptionStatus: "active", openItems: { openInvoices: 1, pendingItems: 2 } });
        await purge.purgeOrganization(c, org, { execute: true, billing: stripe as unknown as BillingPort });
      } finally {
        c.release();
      }
      const oc = await owner.connect();
      let purged: { meta: Record<string, unknown> }[];
      try {
        await oc.query("begin");
        await oc.query("alter table audit_log no force row level security");
        purged = (await oc.query("select meta from audit_log where organization_id is null and action='platform.org_purged' and entity_id=$1", [org])).rows;
      } finally {
        await oc.query("rollback");
        oc.release();
      }
      expect(purged).toHaveLength(1);
      expect(purged[0].meta).toMatchObject({
        reason: "request",
        stripe: { refundCheck: true, subscriptionId: subId, customerId: cusId, subscription: "canceled_now", customer: "deleted", openInvoices: 1, pendingItems: 2 },
      });
    });

    it("weiteres laufendes Abo des Kunden wird vor dem Löschen ebenfalls beendet", async () => {
      const { org, cusId } = await dueOrg({});
      const second = `sub_${sfx()}`;
      stripe.add(second, { customerId: cusId });
      const c = await owner.connect();
      try {
        await purge.purgeOrganization(c, org, { execute: true, billing: stripe as unknown as BillingPort });
      } finally {
        c.release();
      }
      expect(stripe.subs.get(second)?.status).toBe("canceled");
    });

    it("automatische Löschung, aber bei Stripe läuft noch ein Abo → Abbruch, nichts gekündigt", async () => {
      const { org, subId, cusId } = await dueOrg({});
      // lokal: Abo beendet, Vertragsende vor 13 Monaten, Ankündigung zugestellt, angekündigter Termin erreicht
      await owner.query(
        `update organizations set subscription_status='canceled', current_period_end = now() - interval '13 months',
           settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('deletionReason', 'auto_readonly_expiry',
             'readonlyExpiry', jsonb_build_object('noticeSentAt', (now() - interval '45 days')::text, 'noticeMail', 'sent', 'deletionAt', (now() - interval '1 day')::text))
         where id=$1`,
        [org],
      );
      const c = await owner.connect();
      try {
        await expect(purge.purgeOrganization(c, org, { execute: false, billing: stripe as unknown as BillingPort })).rejects.toMatchObject({ kind: "auto_deletion_live_subscription" });
        await expect(purge.purgeOrganization(c, org, { execute: true, billing: stripe as unknown as BillingPort })).rejects.toMatchObject({ kind: "auto_deletion_live_subscription" });
      } finally {
        c.release();
      }
      expect(stripe.calls.some((x) => x.startsWith("cancel_now:") || x.startsWith("delete_customer:"))).toBe(false);
      expect(stripe.subs.get(subId)?.status).toBe("active");
      expect(stripe.deletedCustomers).not.toContain(cusId);
      expect(await exists(org)).toBe(true);
      // ohne laufendes Abo bei Stripe: Probelauf zulässig
      stripe.subs.get(subId)!.status = "canceled";
      const c2 = await owner.connect();
      try {
        expect((await purge.purgeOrganization(c2, org, { execute: false, billing: stripe as unknown as BillingPort })).stripe).toMatchObject({ subscription: "ended" });
      } finally {
        c2.release();
      }
    });

    it("Stripe nicht erreichbar oder nicht konfiguriert → Abbruch, Praxis bleibt, Protokoll", async () => {
      const { org, subId } = await dueOrg({});
      const c = await owner.connect();
      try {
        stripe.fail = true;
        await expect(purge.purgeOrganization(c, org, { execute: true, billing: stripe as unknown as BillingPort })).rejects.toThrow(/HTTP 500/);
        await expect(purge.purgeOrganization(c, org, { execute: true })).rejects.toThrow(/kein Stripe-Zugang/);
        const { StripeMock } = await import("@/integrations/stripe/mock");
        await expect(purge.purgeOrganization(c, org, { execute: true, billing: new StripeMock() })).rejects.toThrow(/kein Stripe-Zugang/);
        // Probelauf ohne Zugang: meldet „ungeprüft“, bricht nicht ab
        expect((await purge.purgeOrganization(c, org, { execute: false })).stripe).toMatchObject({ subscription: "unchecked", customer: "unchecked", refundCheck: false });
      } finally {
        c.release();
      }
      expect(await exists(org)).toBe(true);
      expect(stripe.subs.get(subId)?.status).toBe("active");
      // Plattform-Protokoll (Zeilen ohne Praxis sind per RLS unsichtbar → kurz als Eigentümer ohne FORCE lesen, dann zurückrollen)
      const oc = await owner.connect();
      let aborted: { meta: { reason: string } }[];
      try {
        await oc.query("begin");
        await oc.query("alter table audit_log no force row level security");
        aborted = (await oc.query("select meta from audit_log where organization_id is null and action='platform.org_purge_aborted' and entity_id=$1", [org])).rows;
      } finally {
        await oc.query("rollback");
        oc.release();
      }
      expect(aborted).toHaveLength(3);
      // nur die Art des Fehlers, keine Antworttexte von Stripe und keine Praxisangaben (AppSec)
      expect(aborted.map((a) => a.meta.reason).sort()).toEqual(["BillingHttpError", "stripe_not_configured", "stripe_not_configured"]);
      expect(JSON.stringify(aborted)).not.toMatch(/kaputt|Praxis|STRIPE_SECRET_KEY/);
    });
  });
});
