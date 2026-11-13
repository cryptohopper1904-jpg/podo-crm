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
    const res = await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 900_000)));
    expect(res).toMatchObject({ ok: false, conflict: true, absentDays: [] });
    // Fehlermeldung nennt die belegte Zeit (Berlin: 10:00–10:30 Uhr)
    expect(res.ok || !("conflict" in res) ? "" : ap.conflictMessage(res)).toContain("07.05. 10:00–10:30 Uhr");
    expect((await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 900_000), { allowConflict: true }))).ok).toBe(true);
    // andere Behandler:in, anderer Zeitraum → frei
    expect((await ap.createInternalAppointments(org, input(u, new Date(start.getTime() + 4 * 3600_000)))).ok).toBe(true);
  });

  it("Abwesenheit der Behandler:in: Anlage und Verschieben abgelehnt, nach Bestätigung möglich", async () => {
    const org = await f.org();
    const u = await f.user();
    await f.asOrg(org, (c) => c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2031-05-12','2031-05-13','vacation')", [org, u]));
    const res = await ap.createInternalAppointments(org, input(u, new Date("2031-05-13T07:00:00Z")));
    expect(res).toMatchObject({ ok: false, conflict: true, clashes: [], absentDays: ["2031-05-13"] });
    expect(res.ok || !("conflict" in res) ? "" : ap.conflictMessage(res)).toContain("abwesend – nicht verfügbar (13.05.2031)");
    // Serie: nur die Termine in der Abwesenheit werden gemeldet
    const series = await ap.createInternalAppointments(org, input(u, new Date("2031-05-06T07:00:00Z"), { occurrences: [new Date("2031-05-06T07:00:00Z"), new Date("2031-05-13T07:00:00Z")] }));
    expect(series).toMatchObject({ ok: false, absentDays: ["2031-05-13"] });
    expect((await ap.createInternalAppointments(org, input(u, new Date("2031-05-13T07:00:00Z"), { allowConflict: true }))).ok).toBe(true);
    expect((await ap.createInternalAppointments(org, input(u, new Date("2031-05-14T07:00:00Z")))).ok).toBe(true);
  });
});
