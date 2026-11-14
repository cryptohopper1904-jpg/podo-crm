import { describe, expect, it } from "vitest";
import {
  absentOn,
  addDaysIso,
  berlinParts,
  dayInterval,
  describeClashes,
  findClashes,
  gridRange,
  isBusy,
  layoutLanes,
  mondayOfIso,
  monthWeeks,
  outsideRanges,
  parseFullView,
  defaultFullView,
  isNarrowCookie,
  shortCalendarTitle,
  initials,
  parseHhmm,
  parseMode,
  shiftMonthIso,
} from "./calendar-grid";

const at = (iso: string) => new Date(iso);

describe("Datumshilfen", () => {
  it("Montag der Woche, Tage addieren, Monat wechseln", () => {
    expect(mondayOfIso("2026-11-13")).toBe("2026-11-09");
    expect(mondayOfIso("2026-11-15")).toBe("2026-11-09"); // Sonntag gehört zur Woche davor
    expect(mondayOfIso("2026-11-09")).toBe("2026-11-09");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonthIso("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftMonthIso("2026-01-15", -1)).toBe("2025-12-01");
  });

  it("Monatsraster: ganze Wochen Mo–So, die den Monat abdecken", () => {
    const w = monthWeeks("2026-11-13");
    expect(w[0][0]).toBe("2026-10-26");
    expect(w.at(-1)?.at(-1)).toBe("2026-12-06");
    expect(w).toHaveLength(6);
    expect(w.every((x) => x.length === 7)).toBe(true);
    // Februar 2027 beginnt Montag und hat 4 Wochen
    expect(monthWeeks("2027-02-10")).toHaveLength(4);
  });

  it("Berliner Ortszeit inkl. Sommerzeit", () => {
    expect(berlinParts(at("2026-07-01T07:30:00Z"))).toEqual({ dateIso: "2026-07-01", min: 9 * 60 + 30 });
    expect(berlinParts(at("2026-11-13T08:15:00Z"))).toEqual({ dateIso: "2026-11-13", min: 9 * 60 + 15 });
    expect(berlinParts(at("2026-11-13T23:30:00Z"))).toEqual({ dateIso: "2026-11-14", min: 30 });
  });
});

describe("Lage im Raster", () => {
  it("Termin am Tag, über Mitternacht beschnitten, anderer Tag → null", () => {
    expect(dayInterval(at("2026-11-13T08:00:00Z"), at("2026-11-13T08:45:00Z"), "2026-11-13")).toEqual({ startMin: 540, endMin: 585 });
    expect(dayInterval(at("2026-11-13T22:00:00Z"), at("2026-11-14T00:00:00Z"), "2026-11-13")).toEqual({ startMin: 23 * 60, endMin: 1440 });
    expect(dayInterval(at("2026-11-13T22:00:00Z"), at("2026-11-14T00:00:00Z"), "2026-11-14")).toEqual({ startMin: 0, endMin: 60 });
    expect(dayInterval(at("2026-11-13T08:00:00Z"), at("2026-11-13T08:45:00Z"), "2026-11-14")).toBeNull();
    // Dauer 0 wird als ein Slot dargestellt
    expect(dayInterval(at("2026-11-13T08:00:00Z"), at("2026-11-13T08:00:00Z"), "2026-11-13")).toEqual({ startMin: 540, endMin: 555 });
  });

  it("Zeitachse 07–20 Uhr, erweitert auf volle Stunden", () => {
    expect(gridRange([])).toEqual({ startMin: 420, endMin: 1200 });
    expect(gridRange([{ startMin: 6 * 60 + 30, endMin: 7 * 60 }, { startMin: 19 * 60, endMin: 20 * 60 + 10 }])).toEqual({ startMin: 360, endMin: 1260 });
  });

  it("überlappende Termine nebeneinander (Lanes), getrennte Gruppen unabhängig", () => {
    const out = layoutLanes([
      { id: "a", startMin: 540, endMin: 600 },
      { id: "b", startMin: 555, endMin: 585 },
      { id: "c", startMin: 585, endMin: 630 }, // passt in Lane von b
      { id: "d", startMin: 700, endMin: 730 }, // eigene Gruppe
    ]);
    const by = Object.fromEntries(out.map((o) => [o.id, o]));
    expect(by.a).toMatchObject({ lane: 0, lanes: 2 });
    expect(by.b).toMatchObject({ lane: 1, lanes: 2 });
    expect(by.c).toMatchObject({ lane: 1, lanes: 2 });
    expect(by.d).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("Bereiche außerhalb der Arbeitszeit", () => {
    expect(outsideRanges([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:30" }], 420, 1200)).toEqual([
      { startMin: 420, endMin: 480 },
      { startMin: 720, endMin: 780 },
      { startMin: 1050, endMin: 1200 },
    ]);
    expect(outsideRanges([], 420, 1200)).toEqual([{ startMin: 420, endMin: 1200 }]);
    expect(outsideRanges([{ start: "06:00", end: "21:00" }], 420, 1200)).toEqual([]);
  });
});

describe("Belegung (belegt – nicht verfügbar)", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const T2 = "22222222-2222-4222-8222-222222222222";
  const rows = [
    { id: "x1", startsAt: at("2026-11-13T08:00:00Z"), endsAt: at("2026-11-13T08:30:00Z"), status: "planned", therapistId: T1 },
    { id: "x2", startsAt: at("2026-11-13T08:00:00Z"), endsAt: at("2026-11-13T09:00:00Z"), status: "cancelled", therapistId: T1 },
    { id: "x3", startsAt: at("2026-11-13T09:00:00Z"), endsAt: at("2026-11-13T09:30:00Z"), status: "planned", therapistId: null },
    { id: "x4", startsAt: at("2026-11-13T08:00:00Z"), endsAt: at("2026-11-13T09:00:00Z"), status: "confirmed", therapistId: T2 },
  ];

  it("gleiche Behandler:in und Termine ohne Zuordnung, ohne abgesagte und ohne den Termin selbst", () => {
    expect(findClashes(rows, T1, at("2026-11-13T08:15:00Z"), at("2026-11-13T09:15:00Z")).map((r) => r.id)).toEqual(["x1", "x3"]);
    expect(findClashes(rows, T1, at("2026-11-13T08:15:00Z"), at("2026-11-13T09:15:00Z"), "x1").map((r) => r.id)).toEqual(["x3"]);
    expect(findClashes(rows, T2, at("2026-11-13T08:30:00Z"), at("2026-11-13T08:45:00Z")).map((r) => r.id)).toEqual(["x4"]);
  });

  it("angrenzende Termine überschneiden sich nicht", () => {
    expect(findClashes(rows, T1, at("2026-11-13T08:30:00Z"), at("2026-11-13T09:00:00Z"))).toEqual([]);
    expect(isBusy([{ startMin: 540, endMin: 570 }], 570, 585)).toBe(false);
    expect(isBusy([{ startMin: 540, endMin: 570 }], 555, 570)).toBe(true);
  });

  it("Abwesenheit inklusive Start- und Endtag", () => {
    const abs = [{ startsOn: "2026-11-10", endsOn: "2026-11-12" }];
    expect(absentOn(abs, "2026-11-10")).toBe(true);
    expect(absentOn(abs, "2026-11-12")).toBe(true);
    expect(absentOn(abs, "2026-11-13")).toBe(false);
  });

  it("lesbare Zeitenliste für die Fehlermeldung", () => {
    const c = [{ startsAt: at("2026-11-13T08:00:00Z"), endsAt: at("2026-11-13T08:30:00Z") }, { startsAt: at("2026-11-20T09:00:00Z"), endsAt: at("2026-11-20T09:45:00Z") }];
    expect(describeClashes(c)).toBe("13.11. 09:00–09:30 Uhr, 20.11. 10:00–10:45 Uhr");
    expect(describeClashes(c.slice(0, 1), "2026-11-13")).toBe("09:00–09:30 Uhr");
  });
});

describe("Kalenderkopf (Handy)", () => {
  it("kurze Titel je Zeitraum", () => {
    expect(shortCalendarTitle("tag", "2026-11-16")).toBe("Mo 16.11.");
    expect(shortCalendarTitle("woche", "2026-11-12")).toBe("9.–15. Nov.");
    expect(shortCalendarTitle("woche", "2026-12-02")).toBe("30. Nov. – 6. Dez.");
    expect(shortCalendarTitle("monat", "2026-03-20")).toBe("März 2026");
  });
  it("Initialen", () => {
    expect(initials("Toni Beispielkraft-Langname")).toBe("TB");
    expect(initials("Demo Praxis Inhaberin")).toBe("DI");
    expect(initials("Anna")).toBe("AN");
    expect(initials("  ")).toBe("?");
  });
});

describe("URL-Parameter", () => {
  it("Ansicht, Zeitraum und Uhrzeit", () => {
    expect(parseMode("voll")).toBe("full");
    expect(parseMode("einfach")).toBe("simple");
    expect(parseMode("x")).toBeNull();
    expect(parseFullView("monat")).toBe("monat");
    expect(parseFullView(undefined)).toBe("woche");
    expect(parseFullView(undefined, "tag")).toBe("tag");
    expect(parseFullView("woche", "tag")).toBe("woche");
    expect(parseFullView("quatsch", defaultFullView(true))).toBe("tag");
    expect(defaultFullView(false)).toBe("woche");
    expect(isNarrowCookie("1")).toBe(true);
    expect(isNarrowCookie(undefined)).toBe(false);
    expect(parseHhmm("07:45")).toBe("07:45");
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm(["09:00"])).toBeNull();
  });
});
