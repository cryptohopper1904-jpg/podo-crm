/**
 * Gesamt-Review H4/H7: Webhook-Ereignisse dauerhaft speichern, mit Backoff wiederholen, nach Absturz übernehmen,
 * Rohdaten nach Verarbeitung löschen, Aufbewahrung 30 Tage, RLS je Praxis.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Webhook-Outbox (DB)", () => {
  const f = fixtures(TEST_DB!);
  let wh: typeof import("./webhooks");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    wh = await import("./webhooks");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const row = async (org: string, id: string) => (await f.asOrg(org, (c) => c.query("select * from webhook_events where id = $1", [id]))).rows[0];
  const ok = async () => undefined;
  const boom = async () => {
    throw new Error("Anbieter nicht erreichbar");
  };

  it("speichert vor der Verarbeitung; Erfolg löscht die Rohdaten; Duplikat wird erkannt", async () => {
    const org = await f.org();
    const s = await wh.storeWebhookEvent("sms", org, "ext-1", { text: "Hallo" }, "h1");
    expect(s).toMatchObject({ retry: false });
    expect(await row(org, s!.id)).toMatchObject({ status: "pending", attempts: 0, payload_hash: "h1" });
    expect(await wh.processWebhookEvent(org, s!.id, { dispatch: ok })).toBe("done");
    const r = await row(org, s!.id);
    expect(r).toMatchObject({ status: "done", payload: null, attempts: 1 });
    expect(r.processed_at).not.toBeNull();
    expect(await wh.storeWebhookEvent("sms", org, "ext-1", { text: "Hallo" }, "h1")).toBeNull();
    // bereits erledigt → keine zweite Verarbeitung
    expect(await wh.processWebhookEvent(org, s!.id, { dispatch: ok })).toBe("skipped");
  });

  it("Fehler → Wiederholung mit Backoff per Cron, nach max. Versuchen aufgegeben + Posteingang", async () => {
    const org = await f.org();
    const s = (await wh.storeWebhookEvent("sumup", org, "ext-2", { id: "x" }, "h2"))!;
    expect(await wh.processWebhookEvent(org, s.id, { dispatch: boom })).toBe("failed");
    let r = await row(org, s.id);
    expect(r.status).toBe("failed");
    expect(r.payload).not.toBeNull();
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    // vor dem nächsten Versuch: Cron tut nichts
    expect((await wh.retryDueWebhooks({ dispatch: boom, organizationIds: [org] })).failed).toBe(0);
    let t = Date.now();
    for (let i = 2; i <= wh.WEBHOOK_MAX_ATTEMPTS; i++) {
      t += wh.webhookBackoffMs(i - 1) + 1000;
      await wh.retryDueWebhooks({ now: new Date(t), dispatch: boom, organizationIds: [org] });
    }
    r = await row(org, s.id);
    expect(r).toMatchObject({ status: "dead", attempts: wh.WEBHOOK_MAX_ATTEMPTS });
    const inbox = await f.asOrg(org, (c) => c.query("select subject from messages where thread_key = $1", [`webhook-dead:${s.id}`]));
    expect(inbox.rows[0].subject).toMatch(/sumup.*nicht verarbeitet/);
    // erneute Zustellung des Anbieters belebt das Ereignis wieder
    expect(await wh.storeWebhookEvent("sumup", org, "ext-2", { id: "x" }, "h2")).toMatchObject({ retry: true });
    expect(await wh.processWebhookEvent(org, s.id, { dispatch: ok })).toBe("done");
  });

  it("Absturz während der Verarbeitung (Lease abgelaufen) und nie verarbeitete Ereignisse übernimmt der Cron", async () => {
    const org = await f.org();
    const crashed = (await wh.storeWebhookEvent("whatsapp", org, "ext-3", { m: 1 }, "h3"))!;
    const lost = (await wh.storeWebhookEvent("whatsapp", org, "ext-4", { m: 2 }, "h4"))!;
    await f.asOrg(org, (c) => c.query("update webhook_events set status = 'processing', attempts = 1, lease_until = now() - interval '1 minute' where id = $1", [crashed.id]));
    await f.asOrg(org, (c) => c.query("update webhook_events set received_at = now() - interval '10 minutes' where id = $1", [lost.id]));
    const out = await wh.retryDueWebhooks({ dispatch: ok, organizationIds: [org] });
    expect(out.processed).toBeGreaterThanOrEqual(2);
    expect((await row(org, crashed.id)).status).toBe("done");
    expect((await row(org, lost.id)).status).toBe("done");
  });

  it("Aufbewahrung: erledigte Ereignisse nach 30 Tagen gelöscht; RLS trennt die Praxen", async () => {
    const org = await f.org();
    const other = await f.org();
    const s = (await wh.storeWebhookEvent("sms", org, "ext-5", { text: "alt" }, "h5"))!;
    await wh.processWebhookEvent(org, s.id, { dispatch: ok });
    expect((await f.asOrg(other, (c) => c.query("select 1 from webhook_events where id = $1", [s.id]))).rowCount).toBe(0);
    expect((await f.pool.query("select 1 from webhook_events where id = $1", [s.id])).rowCount).toBe(0);
    await f.asOrg(org, (c) => c.query("update webhook_events set received_at = now() - interval '31 days' where id = $1", [s.id]));
    const out = await wh.retryDueWebhooks({ dispatch: ok, organizationIds: [org] });
    expect(out.purged).toBeGreaterThanOrEqual(1);
    expect(await row(org, s.id)).toBeUndefined();
  });

  it("Status für die Praxis und Backlog für den Health-Check", async () => {
    const org = await f.org();
    const s = (await wh.storeWebhookEvent("sms", org, "ext-6", { text: "x" }, "h6"))!;
    await wh.processWebhookEvent(org, s.id, { dispatch: boom });
    const st = await wh.webhookStatus(org);
    expect(st.counts.failed).toBe(1);
    expect(st.problems[0]).toMatchObject({ status: "failed", error: "Anbieter nicht erreichbar" });
    await f.asOrg(org, (c) => c.query("update webhook_events set received_at = now() - interval '2 hours' where id = $1", [s.id]));
    expect((await wh.webhookBacklog(3600_000, [org])).open).toBeGreaterThanOrEqual(1);
  });
});
