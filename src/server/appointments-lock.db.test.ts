/** Gesamt-Review M2: interne Terminanlage unter derselben Buchungssperre – keine Doppelbelegung. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Interne Terminanlage (DB)", () => {
  const f = fixtures(TEST_DB!);
  let ap: typeof import("./appointments");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    ap = await import("./appointments");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const input = (therapistId: string, start: Date, o: Partial<import("./appointments").InternalAppointmentInput> = {}) => ({
    patientId: null, therapistId, occurrences: [start], durationMin: 60, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false, ...o,
  });

  it("parallele Anlage desselben Slots: genau eine gelingt", async () => {
    const org = await f.org();
    const u = await f.user();
    const start = new Date("2031-05-06T08:00:00Z");
    const results = await Promise.all([1, 2, 3].map(() => ap.createInternalAppointments(org, input(u, start))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await f.asOrg(org, (c) => c.query("select count(*)::int n from appointments where organization_id = $1", [org]))).rows[0].n).toBe(1);
  });

  it("Konflikt auch mit Online-Buchungen ohne Behandler:in; bewusste Doppelbuchung bleibt möglich", async () => {
    const org = await f.org();
    const u = await f.user();
    const start = new Date("2031-05-07T08:00:00Z");
    await f.asOrg(org, (c) => c.query("insert into appointments (organization_id, starts_at, ends_at, status, source) values ($1,$2,$3,'planned','online')", [org, start, new Date(start.getTime() + 1800_000)]));
    expect(await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 900_000)))).toEqual({ ok: false, conflict: true });
    expect((await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 900_000), { allowConflict: true }))).ok).toBe(true);
    // andere Behandler:in, anderer Zeitraum → frei
    expect((await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 4 * 3600_000)))).ok).toBe(true);
  });
});
