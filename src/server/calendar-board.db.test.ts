/** Kalender: Belegungsprüfung im Formular, „Freien Termin finden“ und gemerkte Ansicht (DB). */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { AuthContext } from "@/lib/auth/session";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Kalender-Belegung (DB)", () => {
  const f = fixtures(TEST_DB!);
  let cb: typeof import("./calendar-board");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    cb = await import("./calendar-board");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const authFor = (org: string, user: string, can = true) =>
    ({ organization: { id: org, state: "BE" }, user: { id: user }, role: "therapist", support: null, can: () => can }) as unknown as AuthContext;

  async function setup() {
    const org = await f.org({ settings: { opening: { from: "08:00", to: "12:00" } } });
    const a = await f.user();
    const b = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist'), ($1,$3,'therapist')", [org, a, b]);
    return { org, a, b };
  }
  const appt = (org: string, therapist: string | null, start: string, end: string, status = "planned") =>
    f.asOrg(org, (c) => c.query("insert into appointments (organization_id, therapist_id, starts_at, ends_at, status, source) values ($1,$2,$3,$4,$5,'manual')", [org, therapist, start, end, status]));

  it("slotStatus: belegt (eigene + ohne Zuordnung), abgesagte zählen nicht, Abwesenheit und Arbeitszeit", async () => {
    const { org, a, b } = await setup();
    // Mo 2031-05-05 (MESZ): 09:00–09:30 a, 09:30–10:00 ohne Zuordnung, 09:00–10:00 b, 09:00–10:00 a abgesagt
    await appt(org, a, "2031-05-05T07:00:00Z", "2031-05-05T07:30:00Z");
    await appt(org, null, "2031-05-05T07:30:00Z", "2031-05-05T08:00:00Z");
    await appt(org, b, "2031-05-05T07:00:00Z", "2031-05-05T08:00:00Z");
    await appt(org, a, "2031-05-05T07:00:00Z", "2031-05-05T08:00:00Z", "cancelled");
    const auth = authFor(org, a);
    const s = await cb.slotStatus(auth, { therapistId: a, dateIso: "2031-05-05", time: "09:15", durationMin: 30 });
    expect(s?.clashes).toEqual([
      { start: "09:00", end: "09:30", unassigned: false },
      { start: "09:30", end: "10:00", unassigned: true },
    ]);
    expect(s).toMatchObject({ absent: false, outsideHours: false, hours: [{ start: "08:00", end: "12:00" }] });
    expect((await cb.slotStatus(auth, { therapistId: a, dateIso: "2031-05-05", time: "10:00", durationMin: 30 }))?.clashes).toEqual([]);
    expect((await cb.slotStatus(auth, { therapistId: a, dateIso: "2031-05-05", time: "11:45", durationMin: 30 }))?.outsideHours).toBe(true);
    await f.asOrg(org, (c) => c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2031-05-06','2031-05-06','sick')", [org, a]));
    expect((await cb.slotStatus(auth, { therapistId: a, dateIso: "2031-05-06", time: "09:00", durationMin: 30 }))?.absent).toBe(true);
    // fremde Person / andere Praxis → null
    expect(await cb.slotStatus(auth, { therapistId: await f.user(), dateIso: "2031-05-05", time: "09:00", durationMin: 30 })).toBeNull();
    // ohne Leserecht → Fehler
    await expect(cb.slotStatus(authFor(org, a, false), { therapistId: a, dateIso: "2031-05-05", time: "09:00", durationMin: 30 })).rejects.toThrow();
  });

  it("searchFreeSlots: nächste freie Zeiten ab Datum, Abwesenheit/Wochenende übersprungen, „egal“ nimmt die freie Person", async () => {
    const { org, a, b } = await setup();
    const auth = authFor(org, a);
    const now = new Date("2031-05-01T00:00:00Z");
    // a ist Mo 05.05. abwesend; Di 06.05. 08:00–09:00 belegt
    await f.asOrg(org, (c) => c.query("insert into absences (organization_id, user_id, starts_on, ends_on, kind) values ($1,$2,'2031-05-05','2031-05-05','vacation')", [org, a]));
    await appt(org, a, "2031-05-06T06:00:00Z", "2031-05-06T07:00:00Z");
    // Start Samstag 03.05. → erster Werktag Montag (a abwesend) → Dienstag ab 09:00
    const onlyA = await cb.searchFreeSlots(auth, { fromIso: "2031-05-03", durationMin: 60, therapistId: a, limit: 3, now });
    expect(onlyA?.map((s) => `${s.dateIso} ${s.time}`)).toEqual(["2031-05-06 09:00", "2031-05-06 09:15", "2031-05-06 09:30"]);
    // egal: Montag ist b frei
    const any = await cb.searchFreeSlots(auth, { fromIso: "2031-05-03", durationMin: 60, therapistId: null, limit: 2, now });
    expect(any?.map((s) => [s.dateIso, s.time, s.therapistId])).toEqual([
      ["2031-05-05", "08:00", b],
      ["2031-05-05", "08:15", b],
    ]);
    // nicht in der Vergangenheit: Start vor „jetzt“ wird auf heute gesetzt
    const past = await cb.searchFreeSlots(auth, { fromIso: "2031-04-01", durationMin: 30, therapistId: b, limit: 1, now: new Date("2031-05-07T08:05:00Z") });
    expect(past?.map((s) => `${s.dateIso} ${s.time}`)).toEqual(["2031-05-07 10:15"]);
    expect(await cb.searchFreeSlots(auth, { fromIso: "2031-05-03", durationMin: 30, therapistId: await f.user(), now })).toBeNull();
  });

  it("Kalenderansicht wird je Person in users.prefs gemerkt, andere Einstellungen bleiben", async () => {
    const u = await f.user();
    await f.pool.query(`update users set prefs = '{"changelog":{"seenId":"x"}}' where id = $1`, [u]);
    expect(cb.calendarModeOf(undefined)).toBe("simple");
    await cb.saveCalendarMode(u, "full");
    const prefs = (await f.pool.query("select prefs from users where id = $1", [u])).rows[0].prefs;
    expect(prefs).toEqual({ changelog: { seenId: "x" }, calendar: { mode: "full" } });
    expect(cb.calendarModeOf(prefs)).toBe("full");
    await cb.saveCalendarMode(u, "simple");
    expect(cb.calendarModeOf((await f.pool.query("select prefs from users where id = $1", [u])).rows[0].prefs)).toBe("simple");
  });

  it("Anzeige-Optionen werden je Person gemerkt (nur Abweichungen), Ansicht und andere Einstellungen bleiben; Zurücksetzen entfernt sie", async () => {
    const u = await f.user();
    await f.pool.query(`update users set prefs = '{"changelog":{"seenId":"x"},"calendar":{"mode":"full"}}' where id = $1`, [u]);
    await cb.saveCalendarOptions(u, () => ({ schoolHolidays: true, cancelledFull: true, startHour: 6 }));
    const read = async () => (await f.pool.query("select prefs from users where id = $1", [u])).rows[0].prefs;
    const prefs = await read();
    expect(prefs).toEqual({ changelog: { seenId: "x" }, calendar: { mode: "full", options: { schoolHolidays: true, cancelledFull: true, startHour: 6 } } });
    expect(cb.calendarOptionsOf(prefs, "full")).toMatchObject({ schoolHolidays: true, cancelled: true, startHour: 6, endHour: 20, holidays: true });
    // URL überschreibt die gemerkte Einstellung
    expect(cb.calendarOptionsOf(prefs, "full", { schoolHolidays: false }).schoolHolidays).toBe(false);
    // Aktualisierung bekommt die bisherigen Werte
    await cb.saveCalendarOptions(u, (prev) => ({ ...prev, weekend: "alle" }));
    expect((await read()).calendar.options).toEqual({ schoolHolidays: true, cancelledFull: true, startHour: 6, weekend: "alle" });
    await cb.saveCalendarOptions(u, () => null);
    expect(await read()).toEqual({ changelog: { seenId: "x" }, calendar: { mode: "full" } });
  });
});
