/** /api/cron/aufbewahrung: fail closed (503 ohne Secret, 401 falsches Token), 500 + Fehler-Log bei Teil-Fehlschlag. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const run = vi.hoisted(() => ({ result: { organizations: 2, appointments: 3, messages: 3, errors: 0 }, calls: 0 }));
vi.mock("@/server/online-request-retention", () => ({
  purgeStaleOnlineRequestsAll: vi.fn(async () => {
    run.calls++;
    return run.result;
  }),
}));
const logged = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn((e: string) => logged.errors.push(e)), info: vi.fn(), warn: vi.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "./route";

const SECRET = "cron-secret-0123456789";
const req = (auth?: string) => POST(new NextRequest("http://app:3000/api/cron/aufbewahrung", { method: "POST", headers: auth ? { authorization: auth } : {} }));

describe("POST /api/cron/aufbewahrung", () => {
  const prev = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    run.calls = 0;
    run.result = { organizations: 2, appointments: 3, messages: 3, errors: 0 };
    logged.errors = [];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("ohne CRON_SECRET: 503, kein Lauf", async () => {
    delete process.env.CRON_SECRET;
    const r = await req(`Bearer ${SECRET}`);
    expect(r.status).toBe(503);
    expect(run.calls).toBe(0);
  });

  it("falsches oder fehlendes Token: 401, kein Lauf", async () => {
    expect((await req("Bearer falsch")).status).toBe(401);
    expect((await req()).status).toBe(401);
    expect(run.calls).toBe(0);
  });

  it("richtiges Token: 200 nur mit Zählern", async () => {
    const r = await req(`Bearer ${SECRET}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, organizations: 2, appointments: 3, messages: 3, errors: 0 });
  });

  it("Fehlschlag einer Praxis: 500 (kein Zeitstempel im cron-Container → Alarm) und Fehler-Log", async () => {
    run.result = { organizations: 2, appointments: 1, messages: 1, errors: 1 };
    const r = await req(`Bearer ${SECRET}`);
    expect(r.status).toBe(500);
    expect((await r.json()).errors).toBe(1);
    expect(logged.errors).toContain("cron.aufbewahrung.partial");
  });
});
