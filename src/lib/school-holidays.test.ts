import { describe, expect, it } from "vitest";
import { STATES, type StateCode } from "./holidays";
import { SCHOOL_HOLIDAYS, SCHOOL_HOLIDAYS_META, schoolHolidayOn, schoolHolidaysCovered } from "./school-holidays";

describe("Schulferien (KMK)", () => {
  it("Daten für alle 16 Länder mit Quelle und Stand", () => {
    expect(Object.keys(SCHOOL_HOLIDAYS).sort()).toEqual(Object.keys(STATES).sort());
    expect(SCHOOL_HOLIDAYS_META.sources[0]).toMatch(/^https:\/\/www\.kmk\.org\//);
    expect(SCHOOL_HOLIDAYS_META.stand).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it("Einträge gültig: ISO-Datum, von ≤ bis, sortiert ohne Überlappung; Herbst-, Weihnachts- und Sommerferien 2026/2027 je Land", () => {
    for (const [state, list] of Object.entries(SCHOOL_HOLIDAYS)) {
      let prevEnd = "";
      for (const [, from, to] of list) {
        expect(from, state).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(`${from}T12:00:00Z`)), `${state} ${from}`).toBe(false);
        const end = to ?? from;
        expect(end >= from, `${state} ${from}`).toBe(true);
        expect(from > prevEnd, `${state} ${from} überlappt`).toBe(true);
        prevEnd = end;
      }
      for (const y of ["2026", "2027"]) {
        expect(list.some(([n, f]) => n === "Sommerferien" && f.startsWith(y)), `${state} Sommer ${y}`).toBe(true);
        expect(list.some(([n, f]) => n === "Herbstferien" && f.startsWith(y)), `${state} Herbst ${y}`).toBe(true);
        expect(list.some(([n, f]) => n === "Weihnachtsferien" && f.startsWith(y)), `${state} Weihnachten ${y}`).toBe(true);
        expect(list.some(([n, f]) => (n === "Osterferien" || (state === "HH" && n === "Frühjahrsferien")) && f.startsWith(y)), `${state} Ostern ${y}`).toBe(true);
      }
    }
  });

  it("Lookup: Tag im Zeitraum (inklusive Grenzen) je Land", () => {
    const cases: [StateCode, string, string | null][] = [
      ["BB", "2026-07-09", "Sommerferien"],
      ["BB", "2026-08-22", "Sommerferien"],
      ["BB", "2026-08-23", null],
      ["BB", "2026-07-08", null],
      ["BE", "2026-10-19", "Herbstferien"],
      ["BY", "2026-02-18", "Frühjahrsferien"],
      ["BW", "2026-02-18", null],
      ["NW", "2026-11-13", null],
      ["NW", "2026-10-31", "Herbstferien"],
      ["HH", "2026-01-30", "Winterferien"],
      ["SN", "2027-05-07", "Ferientag"],
      ["SN", "2027-05-16", "Pfingstferien"],
      ["HE", "2027-01-12", "Weihnachtsferien"],
      ["HE", "2028-01-11", "Weihnachtsferien"],
      ["SL", "2027-01-01", null],
      ["SH", "2027-08-14", "Sommerferien"],
      ["TH", "2027-10-09", "Herbstferien"],
    ];
    for (const [st, d, name] of cases) expect(schoolHolidayOn(d, st), `${st} ${d}`).toBe(name);
  });

  it("Abdeckung: außerhalb unbekannt (null)", () => {
    expect(schoolHolidaysCovered("2026-06-01")).toBe(true);
    expect(schoolHolidaysCovered("2029-07-15")).toBe(false);
    expect(schoolHolidayOn("2029-07-15", "BB")).toBeNull();
  });
});
