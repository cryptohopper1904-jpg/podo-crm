/** Löschlauf über alle Praxen: ein Fehler in einer Praxis bricht den Lauf nicht ab, wird gezählt und geloggt. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

// org-d hat die AVV 0.3 (Standardweisung zur Löschung) noch nicht akzeptiert, org-e nur Version 0.2
const accepted = (avv: string) => ({ legalAcceptance: { agb: "0.3", avv, version: `agb-0.3+avv-${avv}`, at: "2026-11-14T00:00:00Z", by: "u" } });
const ORGS = [
  { id: "org-a", settings: accepted("0.3") },
  { id: "org-b", settings: accepted("0.3") },
  { id: "org-c", settings: accepted("0.10") },
  { id: "org-d", settings: {} },
  { id: "org-e", settings: accepted("0.2") },
];
vi.mock("@/db", () => ({
  db: { select: () => ({ from: async () => ORGS }) },
  withOrg: vi.fn(async (org: string) => {
    if (org === "org-b") throw new Error("deadlock detected");
    return { appointments: 2, messages: 1 };
  }),
}));
const logged = vi.hoisted(() => ({ errors: [] as [string, Record<string, unknown>][] }));
vi.mock("@/lib/log", () => ({ log: { error: vi.fn((e: string, f: Record<string, unknown>) => logged.errors.push([e, f])), info: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { onlineRequestCutoff, purgeStaleOnlineRequestsAll } from "./online-request-retention";

describe("purgeStaleOnlineRequestsAll", () => {
  it("zählt Fehler je Praxis, läuft weiter und loggt ein eigenes Ereignis", async () => {
    expect(await purgeStaleOnlineRequestsAll()).toEqual({ organizations: 5, skipped: 2, appointments: 4, messages: 2, errors: 1 });
    expect(logged.errors).toHaveLength(1);
    expect(logged.errors[0][0]).toBe("retention.online_requests.failed");
    expect(logged.errors[0][1].org).toBe("org-b");
  });

  it("Lauf nur für Praxen mit akzeptierter AVV ab 0.3 (Standardweisung § 3 Nr. 4)", async () => {
    const { withOrg } = await import("@/db");
    expect((await purgeStaleOnlineRequestsAll()).skipped).toBe(2);
    const called = (withOrg as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);
    expect(called).not.toContain("org-d");
    expect(called).not.toContain("org-e");
    expect(called).toContain("org-c");
  });

  it("Stichtag: 6 Monate vor dem Lauf", () => {
    expect(onlineRequestCutoff(new Date("2027-05-14T03:00:00Z")).toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });
});
