/** Löschlauf über alle Praxen: ein Fehler in einer Praxis bricht den Lauf nicht ab, wird gezählt und geloggt. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const ORGS = ["org-a", "org-b", "org-c"];
vi.mock("@/db", () => ({
  db: { select: () => ({ from: async () => ORGS.map((id) => ({ id })) }) },
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
    expect(await purgeStaleOnlineRequestsAll()).toEqual({ organizations: 3, appointments: 4, messages: 2, errors: 1 });
    expect(logged.errors).toHaveLength(1);
    expect(logged.errors[0][0]).toBe("retention.online_requests.failed");
    expect(logged.errors[0][1].org).toBe("org-b");
  });

  it("Stichtag: 6 Monate vor dem Lauf", () => {
    expect(onlineRequestCutoff(new Date("2027-05-14T03:00:00Z")).toISOString()).toBe("2026-11-14T03:00:00.000Z");
  });
});
