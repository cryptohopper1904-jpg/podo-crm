/**
 * Cron /api/cron/reminders: Reihenfolge der Läufe und eigene Fehlerpfade (ein Fehler stoppt die anderen nicht).
 * Alle Läufe gemockt – geprüft wird nur die Verdrahtung der Route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const calls: string[] = [];
const fail = new Set<string>();
const run = (name: string, result: unknown) => async () => {
  calls.push(name);
  if (fail.has(name)) throw new Error(`Testfehler: ${name}`);
  return result;
};

vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/server/webhooks", () => ({ retryDueWebhooks: run("webhooks", { retried: 0 }) }));
vi.mock("@/server/promo-codes", () => ({ runPromoTrialReturns: run("promo", { returned: 0 }) }));
vi.mock("@/server/reminders", () => ({ runReminders: run("reminders", { sent: 2 }) }));
vi.mock("@/server/archive-catchup", () => ({ catchUpArchives: run("archives", { archived: 1 }) }));
vi.mock("@/server/calendar-status", () => ({ runPendingWaitlistOffers: run("waitlist", { checked: 1, offered: 1, failed: 0 }) }));

const SECRET = "0123456789abcdef-test";
const req = () => new NextRequest("http://localhost/api/cron/reminders", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } });

describe("Cron-Route Erinnerungen", () => {
  beforeEach(() => {
    calls.length = 0;
    fail.clear();
    process.env.CRON_SECRET = SECRET;
  });

  it("Reihenfolge webhooks → promo → Erinnerungen → Archiv → Warteliste; Antwort mit allen Zählern", async () => {
    const { POST } = await import("./route");
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(calls).toEqual(["webhooks", "promo", "reminders", "archives", "waitlist"]);
    expect(await res.json()).toMatchObject({ ok: true, sent: 2, webhooks: { retried: 0 }, promoReturns: { returned: 0 }, archives: { archived: 1 }, waitlistOffers: { checked: 1, offered: 1 } });
  });

  it("Erinnerungen scheitern → Archiv und Warteliste laufen trotzdem, Antwort 500", async () => {
    fail.add("reminders");
    const { POST } = await import("./route");
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(calls).toEqual(["webhooks", "promo", "reminders", "archives", "waitlist"]);
    expect(await res.json()).toMatchObject({ archives: { archived: 1 }, waitlistOffers: { checked: 1 } });
  });

  it("Archiv bzw. Warteliste scheitern → übrige Läufe unberührt", async () => {
    fail.add("archives");
    fail.add("webhooks");
    const { POST } = await import("./route");
    const res = await POST(req());
    expect(calls).toEqual(["webhooks", "promo", "reminders", "archives", "waitlist"]);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ sent: 2, archives: null, waitlistOffers: { checked: 1 } });
    fail.clear();
    fail.add("waitlist");
    calls.length = 0;
    const ok = await POST(req());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, archives: { archived: 1 }, waitlistOffers: null });
  });

  it("ohne gültiges Token läuft nichts", async () => {
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/api/cron/reminders", { method: "POST", headers: { authorization: "Bearer falsch" } }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
