/**
 * „Heute“ als Berliner Kalendertag und Termindauer-Grenzen gegen eine echte DB (nur mit TEST_DATABASE_URL, erfundene Daten).
 * Systemzeit fest auf 23:30 UTC (= 00:30 Berlin am Folgetag, Winterzeit); mit TEST_NOW überschreibbar.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("REDIRECT"), { to });
  },
}));
const authState = vi.hoisted(() => ({ org: "", user: "" }));
vi.mock("@/lib/auth/session", () => ({
  requireAuth: async () => ({ organization: { id: authState.org, state: "BE" }, user: { id: authState.user }, role: "owner", support: null, can: () => true }),
  requestMeta: async () => ({ ip: null }),
}));
import { berlinDateIso } from "@/lib/format";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

const NOW = new Date(process.env.TEST_NOW || "2026-11-13T23:30:00Z");

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

(TEST_DB ? describe : describe.skip)("Berliner „heute“ und Termindauer (DB)", () => {
  const f = fixtures(TEST_DB!);
  let doku: typeof import("@/app/(app)/kunden/[id]/doku/actions");
  let ap: typeof import("./appointments");

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    process.env.DATABASE_URL = TEST_DB;
    doku = await import("@/app/(app)/kunden/[id]/doku/actions");
    ap = await import("./appointments");
  });
  afterAll(async () => {
    vi.useRealTimers();
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  it("Spangen-Episode: Beginn und Ende sind der Berliner Kalendertag", async () => {
    const today = berlinDateIso();
    if (!process.env.TEST_NOW) expect(today).toBe("2026-11-14"); // UTC wäre noch der 13.11.
    const org = await f.org();
    const user = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'owner')", [org, user]);
    Object.assign(authState, { org, user });
    const patientId = await f.patient(org);
    const base = { patientId, findings: "Unguis incarnatus (erfunden)", confirm: "on", missingPhotoReason: "Foto wird nachgereicht" };

    await expect(doku.saveTreatmentAction(undefined, fd({ ...base, braceAction: "set", braceSide: "left", braceToe: "1", braceType: "Testspange" }))).rejects.toThrow("REDIRECT");
    const [ep] = (await f.asOrg(org, (c) => c.query("select id, started_at::text s, ended_at::text e from brace_episodes where patient_id = $1", [patientId]))).rows;
    expect(ep).toMatchObject({ s: today, e: null });

    await expect(doku.saveTreatmentAction(undefined, fd({ ...base, braceAction: "remove", braceEpisodeId: ep.id }))).rejects.toThrow("REDIRECT");
    const [done] = (await f.asOrg(org, (c) => c.query("select status, ended_at::text e from brace_episodes where id = $1", [ep.id]))).rows;
    expect(done).toMatchObject({ status: "completed", e: today });
  });

  it("interne Terminanlage: Dauer außerhalb 5–480 Minuten wird abgelehnt (keine stille Kürzung)", async () => {
    const org = await f.org();
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
    const input = (start: Date, durationMin: number) => ({
      patientId: null, therapistId: u, occurrences: [start], durationMin, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
    });
    const err = { ok: false, error: "Dauer muss zwischen 5 und 480 Minuten liegen." };
    expect(await ap.createInternalAppointments(org, input(new Date("2031-06-02T06:00:00Z"), 600))).toEqual(err); // z. B. Summe mehrerer Leistungen
    expect(await ap.createInternalAppointments(org, input(new Date("2031-06-03T06:00:00Z"), 1))).toEqual(err);
    expect(await ap.createInternalAppointments(org, input(new Date("2031-06-03T06:00:00Z"), Number.NaN))).toEqual(err);
    expect((await ap.createInternalAppointments(org, input(new Date("2031-06-04T06:00:00Z"), 480))).ok).toBe(true);
    expect((await ap.createInternalAppointments(org, input(new Date("2031-06-05T06:00:00Z"), 5))).ok).toBe(true);
    const mins = (await f.asOrg(org, (c) => c.query("select extract(epoch from ends_at - starts_at)::int / 60 m from appointments where organization_id = $1 order by starts_at", [org]))).rows.map((r) => r.m);
    expect(mins).toEqual([480, 5]);
  });

  it("Sperrzeit: Prüfung nutzt dieselbe Dauer wie Konfliktprüfung und Terminende", async () => {
    const org = await f.org();
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
    // Sperrzeit Mo 02.06.2031, 12:00–12:30 Berlin (MESZ)
    await f.asOrg(org, (c) => c.query("insert into calendar_blocks (organization_id, user_id, starts_on, start_time, end_time, created_by) values ($1,$2,'2031-06-02','12:00','12:30',$2)", [org, u]));
    const at11 = new Date("2031-06-02T09:00:00Z"); // 11:00 Berlin
    const input = (durationMin: number, allowConflict = false) => ({
      patientId: null, therapistId: u, occurrences: [at11], durationMin, source: "phone" as const, title: "Behandlung", notes: null, homeVisit: false, serviceIds: [], allowConflict,
    });
    // 90 Minuten → endet 12:30 → Sperrzeit getroffen
    const clash = await ap.createInternalAppointments(org, input(90));
    expect(clash).toMatchObject({ ok: false, conflict: true });
    expect(clash.ok || !("blocks" in clash) ? [] : clash.blocks).toHaveLength(1);
    // 60 Minuten → endet 12:00 → frei; gespeichertes Ende passt zur geprüften Dauer
    expect((await ap.createInternalAppointments(org, input(60))).ok).toBe(true);
    const [row] = (await f.asOrg(org, (c) => c.query("select to_char(ends_at at time zone 'Europe/Berlin', 'HH24:MI') e from appointments where organization_id = $1", [org]))).rows;
    expect(row.e).toBe("12:00");
  });
});
