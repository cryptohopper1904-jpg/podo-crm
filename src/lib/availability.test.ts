import { describe, expect, it } from "vitest";
import { computeAvailability, fitsInRanges, isoWeekday, mergeRanges, parseRanges } from "./availability";
import { weekdaysWeek, weekFromList } from "./opening-hours";

const hours = [
  { weekday: 1, startTime: "08:00", endTime: "12:00" },
  { weekday: 1, startTime: "13:00", endTime: "17:00" },
  { weekday: 3, startTime: "09:00", endTime: "15:00" },
];

describe("Verfügbarkeit", () => {
  it("Wochentag 1 = Montag, 7 = Sonntag", () => {
    expect(isoWeekday("2026-11-09")).toBe(1);
    expect(isoWeekday("2026-11-08")).toBe(7);
  });
  it("Arbeitszeiten des Wochentags", () => {
    const a = computeAvailability({ dateIso: "2026-11-09", hours, absences: [] });
    expect(a).toMatchObject({ available: true, source: "working_hours", ranges: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }] });
  });
  it("kein Arbeitstag", () => expect(computeAvailability({ dateIso: "2026-11-10", hours, absences: [] })).toMatchObject({ available: false, reason: "no_hours" }));
  it("Abwesenheit inkl. Start- und Endtag", () => {
    const absences = [{ startsOn: "2026-11-09", endsOn: "2026-11-11", kind: "vacation" }];
    expect(computeAvailability({ dateIso: "2026-11-09", hours, absences })).toMatchObject({ available: false, reason: "absence", absenceKind: "vacation" });
    expect(computeAvailability({ dateIso: "2026-11-11", hours, absences }).reason).toBe("absence");
    expect(computeAvailability({ dateIso: "2026-11-16", hours, absences }).available).toBe(true);
  });
  it("Feiertag", () => expect(computeAvailability({ dateIso: "2026-11-09", hours, absences: [], holiday: "Testtag" })).toMatchObject({ available: false, reason: "holiday" }));
  it("ohne gepflegte Zeiten: Öffnungszeiten der Praxis (Standard Mo–Fr 08–18 Uhr)", () => {
    expect(computeAvailability({ dateIso: "2026-11-10", hours: [], absences: [], opening: weekdaysWeek({ start: "09:00", end: "18:00" }) })).toMatchObject({
      available: true, source: "opening_hours", ranges: [{ start: "09:00", end: "18:00" }],
    });
    expect(computeAvailability({ dateIso: "2026-11-10", hours: [], absences: [] }).ranges).toEqual([{ start: "08:00", end: "18:00" }]);
    expect(computeAvailability({ dateIso: "2026-11-08", hours: [], absences: [] }).available).toBe(false);
  });
  it("Öffnungszeiten je Tag: Mittagspause, Samstag, Sonntag, geschlossener Tag", () => {
    const opening = weekFromList([
      { weekday: 1, from: "08:00", to: "12:00" },
      { weekday: 1, from: "13:00", to: "18:00" },
      { weekday: 6, from: "09:00", to: "12:00" },
      { weekday: 7, from: "10:00", to: "14:00" },
    ]);
    const at = (dateIso: string) => computeAvailability({ dateIso, hours: [], absences: [], opening });
    expect(at("2026-11-09")).toMatchObject({ available: true, ranges: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "18:00" }] }); // Mo
    expect(at("2026-11-10")).toMatchObject({ available: false, reason: "no_hours" }); // Di geschlossen
    expect(at("2026-11-14").ranges).toEqual([{ start: "09:00", end: "12:00" }]); // Sa
    expect(at("2026-11-15").ranges).toEqual([{ start: "10:00", end: "14:00" }]); // So
    expect(computeAvailability({ dateIso: "2026-11-15", hours: [], absences: [], opening, holiday: "Testtag" }).reason).toBe("holiday");
    // gepflegte Arbeitszeiten gehen den Öffnungszeiten vor
    expect(computeAvailability({ dateIso: "2026-11-15", hours, absences: [], opening }).available).toBe(false);
  });
  it("verschmilzt Überlappungen", () => {
    expect(mergeRanges([{ start: "10:00", end: "12:00" }, { start: "08:00", end: "10:30" }, { start: "14:00", end: "13:00" }])).toEqual([{ start: "08:00", end: "12:00" }]);
  });
  it("parst Eingaben", () => {
    expect(parseRanges("8-12, 13:30–17").ranges).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:30", end: "17:00" }]);
    expect(parseRanges("").ranges).toEqual([]);
    expect(parseRanges("12-8").error).toBeTruthy();
    expect(parseRanges("morgens").error).toBeTruthy();
  });
  it("Termin passt ins Zeitfenster", () => {
    const r = [{ start: "08:00", end: "12:00" }];
    expect(fitsInRanges(r, "11:15", "12:00")).toBe(true);
    expect(fitsInRanges(r, "11:30", "12:15")).toBe(false);
  });
});
