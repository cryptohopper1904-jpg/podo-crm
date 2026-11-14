/**
 * Cron /api/cron/nur-lesen: Schalter READONLY_EXPIRY_ENABLED (Standard aus → nichts passiert), Token-Prüfung.
 * Der Lauf selbst ist gemockt (DB-Tests: src/server/readonly-expiry.db.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const runs = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/server/readonly-expiry", () => ({
  runReadonlyExpiry: async () => {
    runs.n++;
    return { checked: 1, notices: 0, requests: 0, reminders: 0, stopped: 0, failed: 0, mailNotSent: 0 };
  },
}));

const SECRET = "0123456789abcdef-test";
const req = (token = SECRET) => new NextRequest("http://localhost/api/cron/nur-lesen", { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("Cron-Route Ende des Nur-Lesen-Modus", () => {
  beforeEach(() => {
    runs.n = 0;
    process.env.CRON_SECRET = SECRET;
    delete process.env.READONLY_EXPIRY_ENABLED;
  });
  afterEach(() => {
    delete process.env.READONLY_EXPIRY_ENABLED;
  });

  it("ohne READONLY_EXPIRY_ENABLED=1: Antwort „deaktiviert“, kein Lauf", async () => {
    const { POST } = await import("./route");
    for (const v of [undefined, "0", "true"]) {
      if (v === undefined) delete process.env.READONLY_EXPIRY_ENABLED;
      else process.env.READONLY_EXPIRY_ENABLED = v;
      const res = await POST(req());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, disabled: true });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(runs.n).toBe(0);
  });

  it("eingeschaltet: Lauf mit Zählern; falsches Token 401 ohne Lauf", async () => {
    process.env.READONLY_EXPIRY_ENABLED = "1";
    const { POST } = await import("./route");
    expect((await POST(req("falsch-falsch-falsch"))).status).toBe(401);
    expect(runs.n).toBe(0);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, checked: 1 });
    expect(runs.n).toBe(1);
  });
});
