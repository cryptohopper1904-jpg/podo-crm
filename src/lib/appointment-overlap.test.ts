/** Kalender-Abo: Überschneidungen in der Anzeige und Bewertung für /api/health/deep. */
import { describe, expect, it } from "vitest";
import { feedOverlapIds } from "./appointment-overlap";
import { evaluateCalendarFeeds } from "./ops-health";

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 10, h, m));
const row = (id: string, s: Date, e: Date, therapistId: string | null, feed: boolean, status = "planned") => ({ a: { id, startsAt: s, endsAt: e, status, therapistId }, feed: feed ? { label: "Doctolib" } : null });

describe("Überschneidungen mit Kalender-Abo-Terminen", () => {
  it("nur gleiche Behandler:in, mindestens ein importierter Termin, ohne Absagen, Ende exklusiv", () => {
    const ids = feedOverlapIds([
      row("feed1", t(8), t(9), "u1", true),
      row("own1", t(8, 30), t(9, 30), "u1", false),
      row("own2", t(8, 30), t(9, 30), "u2", false),
      row("own3", t(9, 30), t(10), "u1", false),
      row("feed2", t(10), t(11), "u1", true),
      row("own4", t(10), t(11), "u1", false, "cancelled"),
      row("own5", t(12), t(13), "u1", false),
      row("own6", t(12, 30), t(13), "u1", false),
    ]);
    expect([...ids].sort()).toEqual(["feed1", "own1"]);
  });
});

describe("Health: kalender_abo", () => {
  const now = Date.UTC(2026, 10, 9, 12);
  it("bewertet Alter und Fehler", () => {
    expect(evaluateCalendarFeeds({ active: 0, stale: 0, failing: 0, oldestSuccess: null }, now).status).toBe("ok");
    expect(evaluateCalendarFeeds({ active: 3, stale: 0, failing: 0, oldestSuccess: new Date(now - 4 * 60000) }, now)).toMatchObject({ status: "ok", oldestAgeMinutes: 4 });
    expect(evaluateCalendarFeeds({ active: 3, stale: 1, failing: 1, oldestSuccess: new Date(now - 90 * 60000) }, now).status).toBe("warn");
    expect(evaluateCalendarFeeds({ active: 2, stale: 2, failing: 0, oldestSuccess: new Date(now - 90 * 60000) }, now).status).toBe("fail");
  });
});
