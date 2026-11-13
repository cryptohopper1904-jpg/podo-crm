import { describe, expect, it } from "vitest";
import { findFreeSlots, startDateFor } from "./free-slots";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const at = (iso: string) => new Date(iso);
const longAgo = at("2020-01-01T00:00:00Z");
// 16.11.2026 = Montag (MEZ, UTC+1)
const day = (dateIso: string, therapistId: string, ranges = [{ start: "08:00", end: "10:00" }]) => ({ dateIso, therapistId, ranges });

describe("startDateFor", () => {
  it("Schnellauswahl", () => {
    expect(startDateFor("sofort", "2026-11-13")).toBe("2026-11-13");
    expect(startDateFor("morgen", "2026-11-13")).toBe("2026-11-14");
    expect(startDateFor("1w", "2026-11-13")).toBe("2026-11-20");
    expect(startDateFor("2w", "2026-11-13")).toBe("2026-11-27");
    expect(startDateFor("4w", "2026-11-13")).toBe("2026-12-11");
    expect(startDateFor("6w", "2026-11-13")).toBe("2026-12-25");
  });
});

describe("findFreeSlots", () => {
  it("15-Minuten-Raster innerhalb der Arbeitszeit, Dauer muss hineinpassen", () => {
    const s = findFreeSlots({ windows: [day("2026-11-16", A)], busy: [], therapistIds: [A], durationMin: 60, now: longAgo, limit: 20 });
    expect(s.map((x) => x.time)).toEqual(["08:00", "08:15", "08:30", "08:45", "09:00"]);
    expect(s[0].startsAt.toISOString()).toBe("2026-11-16T07:00:00.000Z");
  });

  it("bestehende Termine derselben Behandler:in und ohne Zuordnung blockieren, abgesagte und fremde nicht", () => {
    const busy = [
      { startsAt: at("2026-11-16T07:00:00Z"), endsAt: at("2026-11-16T07:30:00Z"), status: "planned", therapistId: A }, // 08:00–08:30
      { startsAt: at("2026-11-16T07:45:00Z"), endsAt: at("2026-11-16T08:00:00Z"), status: "planned", therapistId: null }, // 08:45–09:00
      { startsAt: at("2026-11-16T08:00:00Z"), endsAt: at("2026-11-16T09:00:00Z"), status: "cancelled", therapistId: A }, // abgesagt
      { startsAt: at("2026-11-16T08:00:00Z"), endsAt: at("2026-11-16T09:00:00Z"), status: "planned", therapistId: B }, // andere Person
    ];
    const s = findFreeSlots({ windows: [day("2026-11-16", A)], busy, therapistIds: [A], durationMin: 30, now: longAgo, limit: 20 });
    expect(s.map((x) => x.time)).toEqual(["09:00", "09:15", "09:30"]); // 08:30 kollidiert mit 08:45 (ohne Zuordnung)
  });

  it("nicht in der Vergangenheit; Tage ohne Fenster (Abwesenheit, Feiertag) werden übersprungen", () => {
    const windows = [day("2026-11-16", A), day("2026-11-18", A, [{ start: "14:00", end: "15:00" }])];
    const s = findFreeSlots({ windows, busy: [], therapistIds: [A], durationMin: 30, now: at("2026-11-16T08:20:00Z"), limit: 3 });
    expect(s.map((x) => `${x.dateIso} ${x.time}`)).toEqual(["2026-11-16 09:30", "2026-11-18 14:00", "2026-11-18 14:15"]);
  });

  it("„egal“: je Startzeit ein Vorschlag, bevorzugte Person zuerst, sonst die freie", () => {
    const busy = [{ startsAt: at("2026-11-16T07:00:00Z"), endsAt: at("2026-11-16T07:30:00Z"), status: "planned", therapistId: A }];
    const s = findFreeSlots({ windows: [day("2026-11-16", B), day("2026-11-16", A)], busy, therapistIds: [A, B], durationMin: 30, now: longAgo, limit: 4 });
    expect(s.map((x) => [x.time, x.therapistId])).toEqual([
      ["08:00", B],
      ["08:15", B],
      ["08:30", A],
      ["08:45", A],
    ]);
  });

  it("Fenster, die nicht auf dem Raster beginnen, werden ausgerichtet; Limit greift", () => {
    const s = findFreeSlots({ windows: [day("2026-11-16", A, [{ start: "08:10", end: "12:00" }])], busy: [], therapistIds: [A], durationMin: 30, now: longAgo, limit: 2 });
    expect(s.map((x) => x.time)).toEqual(["08:15", "08:30"]);
  });

  it("Personen außerhalb der Auswahl werden ignoriert", () => {
    expect(findFreeSlots({ windows: [day("2026-11-16", B)], busy: [], therapistIds: [A], durationMin: 30, now: longAgo })).toEqual([]);
  });
});
