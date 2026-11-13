/**
 * Serientermine über Zeitumstellungen gegen eine echte DB (nur mit TEST_DATABASE_URL, erfundene Daten):
 * Die Berliner Wanduhrzeit bleibt in der gespeicherten Serie gleich (12:00 MEZ → 12:00 MESZ und zurück).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { seriesStarts } from "@/lib/appointment-series";
import { fixtures, TEST_DB } from "./__tests__/db-fixtures";

(TEST_DB ? describe : describe.skip)("Serientermine über Zeitumstellungen (DB)", () => {
  const f = fixtures(TEST_DB!);
  let ap: typeof import("./appointments");
  let feeds: typeof import("./calendar-feeds");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    ap = await import("./appointments");
    feeds = await import("./calendar-feeds");
  });
  afterAll(async () => {
    await f.end();
    const { db } = await import("@/db");
    await (db.$client as { end: () => Promise<void> }).end();
  });

  const therapist = async (org: string) => {
    const u = await f.user();
    await f.pool.query("insert into memberships (organization_id, user_id, role) values ($1,$2,'therapist')", [org, u]);
    return u;
  };
  const berlinRows = (org: string) =>
    f.asOrg(org, async (c) =>
      (
        await c.query(
          "select to_char(starts_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') s, to_char(ends_at at time zone 'Europe/Berlin', 'HH24:MI') e from appointments where organization_id = $1 order by starts_at",
          [org],
        )
      ).rows.map((r) => `${r.s}–${r.e}`),
    );

  it("wöchentliche Serie über 30.03.2031 und 26.10.2031: immer 12:00–12:40 Berliner Zeit", async () => {
    const org = await f.org();
    const u = await therapist(org);
    const create = (date: string) =>
      ap.createInternalAppointments(org, {
        patientId: null, therapistId: u, occurrences: seriesStarts(date, "12:00", 1, 3), durationMin: 40, source: "phone", title: "Serie", notes: null, homeVisit: false, serviceIds: [], allowConflict: false,
      });
    expect((await create("2031-03-23")).ok).toBe(true);
    expect((await create("2031-10-19")).ok).toBe(true);
    expect(await berlinRows(org)).toEqual([
      "2031-03-23 12:00–12:40",
      "2031-03-30 12:00–12:40",
      "2031-04-06 12:00–12:40",
      "2031-10-19 12:00–12:40",
      "2031-10-26 12:00–12:40",
      "2031-11-02 12:00–12:40",
    ]);
  });

  it("Kalender-Abo: Abgleichsfenster liegt auch über Umstellungen auf Berliner Mitternacht", async () => {
    // 01.03.2031 → −7 Tage (22.02., MEZ) bis Ende 30.05. (MESZ): 24-h-Schritte lägen eine Stunde daneben
    const w = feeds.feedWindow(new Date("2031-03-01T10:00:00Z"));
    expect(w.from.toISOString()).toBe("2031-02-21T23:00:00.000Z");
    expect(w.to.toISOString()).toBe("2031-05-30T22:00:00.000Z");
  });
});
