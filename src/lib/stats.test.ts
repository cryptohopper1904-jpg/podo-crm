import { describe, expect, it } from "vitest";
import {
  MAX_PERIOD_DAYS,
  addDaysIso,
  berlinWeekdayHour,
  buildHeatmap,
  daysInclusive,
  formatLead,
  formatLeadShort,
  heatLevel,
  leadTimeHours,
  median,
  monthsOf,
  periodQuery,
  rankWeekdays,
  rate,
  resolvePeriod,
  stockCoverage,
  weekdayOccurrences,
} from "./stats";

describe("resolvePeriod", () => {
  const today = "2026-11-13";
  it("feste Zeiträume", () => {
    expect(resolvePeriod({ zeitraum: "monat" }, today)).toMatchObject({ from: "2026-11-01", to: "2026-11-30", label: "November 2026", days: 30 });
    expect(resolvePeriod({ zeitraum: "vormonat" }, today)).toMatchObject({ from: "2026-10-01", to: "2026-10-31", label: "Oktober 2026" });
    expect(resolvePeriod({ zeitraum: "quartal" }, today)).toMatchObject({ from: "2026-10-01", to: "2026-12-31", label: "4. Quartal 2026" });
    expect(resolvePeriod({ zeitraum: "vorquartal" }, today)).toMatchObject({ from: "2026-07-01", to: "2026-09-30", label: "3. Quartal 2026" });
    expect(resolvePeriod({ zeitraum: "jahr" }, today)).toMatchObject({ from: "2026-01-01", to: "2026-12-31", days: 365 });
    expect(resolvePeriod({ zeitraum: "vorjahr" }, today)).toMatchObject({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolvePeriod({ zeitraum: "12monate" }, today)).toMatchObject({ from: "2025-12-01", to: "2026-11-30" });
  });
  it("Jahreswechsel: Vormonat/Vorquartal im Januar", () => {
    expect(resolvePeriod({ zeitraum: "vormonat" }, "2027-01-05")).toMatchObject({ from: "2026-12-01", to: "2026-12-31", label: "Dezember 2026" });
    expect(resolvePeriod({ zeitraum: "vorquartal" }, "2027-01-05")).toMatchObject({ from: "2026-10-01", to: "2026-12-31", label: "4. Quartal 2026" });
    expect(resolvePeriod({ zeitraum: "monat" }, "2028-02-10")).toMatchObject({ to: "2028-02-29" });
  });
  it("frei: gültige Daten, vertauscht, zu lang, ungültig", () => {
    expect(resolvePeriod({ zeitraum: "frei", von: "2026-03-01", bis: "2026-03-31" }, today)).toMatchObject({ preset: "frei", from: "2026-03-01", to: "2026-03-31", days: 31 });
    expect(resolvePeriod({ zeitraum: "frei", von: "2026-03-31", bis: "2026-03-01" }, today)).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    const long = resolvePeriod({ zeitraum: "frei", von: "2000-01-01", bis: "2026-01-01" }, today);
    expect(long.days).toBe(MAX_PERIOD_DAYS);
    expect(long.to).toBe("2026-01-01");
    expect(resolvePeriod({ zeitraum: "frei", von: "2026-02-30", bis: "2026-03-01" }, today).preset).toBe("12monate");
    expect(resolvePeriod({ zeitraum: "frei", von: ["x"], bis: "2026-03-01" }, today).preset).toBe("12monate");
    expect(resolvePeriod({ zeitraum: "__proto__" }, today).preset).toBe("12monate");
    expect(resolvePeriod({}, today).preset).toBe("12monate");
  });
  it("Suchparameter für Links", () => {
    expect(periodQuery(resolvePeriod({ zeitraum: "jahr" }, today))).toEqual({ zeitraum: "jahr" });
    expect(periodQuery(resolvePeriod({ zeitraum: "frei", von: "2026-03-01", bis: "2026-03-31" }, today))).toEqual({ zeitraum: "frei", von: "2026-03-01", bis: "2026-03-31" });
  });
});

describe("Datumshelfer", () => {
  it("addDaysIso / daysInclusive über Monats- und Jahresgrenzen, Schaltjahr", () => {
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2028-03-01", -1)).toBe("2028-02-29");
    expect(daysInclusive("2026-03-29", "2026-03-29")).toBe(1);
    expect(daysInclusive("2026-01-01", "2026-12-31")).toBe(365);
    expect(daysInclusive("2026-02-01", "2026-01-01")).toBe(0);
  });
  it("monthsOf", () => {
    expect(monthsOf({ from: "2025-11-15", to: "2026-02-01" })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsOf({ from: "2026-05-01", to: "2026-05-31" })).toEqual(["2026-05"]);
  });
  it("weekdayOccurrences zählt jeden Wochentag", () => {
    // November 2026: beginnt Sonntag, 30 Tage → So und Mo je 5×, sonst 4×
    expect(weekdayOccurrences("2026-11-01", "2026-11-30")).toEqual([5, 4, 4, 4, 4, 4, 5]);
    expect(weekdayOccurrences("2026-11-13", "2026-11-13")).toEqual([0, 0, 0, 0, 1, 0, 0]); // Freitag
    expect(weekdayOccurrences("2026-01-01", "2026-12-31").reduce((a, b) => a + b, 0)).toBe(365);
    expect(weekdayOccurrences("2026-02-01", "2026-01-01")).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("Heatmap-Bucketing in Berliner Ortszeit (inkl. Sommerzeit)", () => {
  it("Winterzeit (UTC+1) und Sommerzeit (UTC+2)", () => {
    expect(berlinWeekdayHour(new Date("2026-01-12T08:30:00Z"))).toEqual({ isodow: 1, hour: 9 }); // Mo 09:30 MEZ
    expect(berlinWeekdayHour(new Date("2026-07-13T08:30:00Z"))).toEqual({ isodow: 1, hour: 10 }); // Mo 10:30 MESZ
  });
  it("Umstellungstage: 29.03.2026 (Sprung 2→3 Uhr) und 25.10.2026 (3→2 Uhr)", () => {
    expect(berlinWeekdayHour(new Date("2026-03-29T00:59:00Z"))).toEqual({ isodow: 7, hour: 1 });
    expect(berlinWeekdayHour(new Date("2026-03-29T01:00:00Z"))).toEqual({ isodow: 7, hour: 3 });
    expect(berlinWeekdayHour(new Date("2026-10-25T00:30:00Z"))).toEqual({ isodow: 7, hour: 2 }); // erste 2-Uhr-Stunde (MESZ)
    expect(berlinWeekdayHour(new Date("2026-10-25T01:30:00Z"))).toEqual({ isodow: 7, hour: 2 }); // zweite 2-Uhr-Stunde (MEZ)
  });
  it("Mitternacht in Berlin gehört zum neuen Tag, auch wenn UTC noch Vortag ist", () => {
    expect(berlinWeekdayHour(new Date("2026-07-12T22:15:00Z"))).toEqual({ isodow: 1, hour: 0 }); // So 22:15 UTC = Mo 00:15
  });
  it("buildHeatmap: lückenlose Stunden, Summen je Zelle, Wochenende nur mit Daten", () => {
    const h = buildHeatmap([
      { isodow: 1, hour: 9, value: 2 },
      { isodow: 1, hour: 9, value: 1 },
      { isodow: 3, hour: 12, value: 5 },
      { isodow: 9, hour: 12, value: 99 }, // ungültig
    ]);
    expect(h.hours).toEqual([9, 10, 11, 12]);
    expect(h.cells[0]).toEqual([3, null, null, null]);
    expect(h.cells[2]).toEqual([null, null, null, 5]);
    expect(h.max).toBe(5);
    expect(h.days).toEqual([0, 1, 2, 3, 4]);
    expect(buildHeatmap([{ isodow: 6, hour: 10, value: 1 }]).days).toEqual([0, 1, 2, 3, 4, 5]);
    const empty = buildHeatmap([]);
    expect(empty.hours[0]).toBe(8);
    expect(empty.max).toBe(0);
  });
  it("heatLevel", () => {
    expect(heatLevel(null, 10)).toBe(0);
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(7.6, 10)).toBe(4);
    expect(heatLevel(10, 10)).toBe(4);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe("Vorlauf und Median", () => {
  it("median wie percentile_cont(0.5)", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([NaN, 4, 2])).toBe(3);
  });
  it("leadTimeHours: nachgetragene Termine haben keinen Vorlauf", () => {
    expect(leadTimeHours(new Date("2026-05-01T08:00:00Z"), new Date("2026-05-03T08:00:00Z"))).toBe(48);
    expect(leadTimeHours(new Date("2026-05-03T09:00:00Z"), new Date("2026-05-03T08:00:00Z"))).toBeNull();
    // über die Zeitumstellung: echte verstrichene Stunden (24 h Ortszeit-Abstand = 23 h)
    expect(leadTimeHours(new Date("2026-03-28T09:00:00Z"), new Date("2026-03-29T08:00:00Z"))).toBe(23);
  });
  it("formatLead / formatLeadShort", () => {
    expect(formatLead(null)).toBe("–");
    expect(formatLead(0.5)).toBe("unter 1 Std.");
    expect(formatLead(30)).toBe("30 Std.");
    expect(formatLead(72)).toBe("3 Tage");
    expect(formatLead(24 * 42)).toBe("6 Wochen");
    expect(formatLead(24 * 25)).toBe("3,6 Wochen");
    expect(formatLeadShort(5)).toBe("5 h");
    expect(formatLeadShort(24 * 4)).toBe("4 T");
    expect(formatLeadShort(24 * 42)).toBe("6 W");
    expect(formatLeadShort(null)).toBe("");
  });
  it("rate", () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(0, 0)).toBeNull();
  });
});

describe("rankWeekdays", () => {
  it("sortiert nach Ø je Kalendertag, Tage ohne Vorkommen fallen weg", () => {
    const r = rankWeekdays([10, 12, 0, 0, 0, 0, 0], [5, 4, 4, 4, 4, 0, 0]);
    expect(r.map((d) => d.label)).toEqual(["Dienstag", "Montag", "Mittwoch", "Donnerstag", "Freitag"]);
    expect(r[0].perDay).toBe(3);
  });
});

describe("stockCoverage", () => {
  it("Reichweite und Umschlag", () => {
    expect(stockCoverage(30, 30, 30)).toEqual({ coverageDays: 30, turnoverPerYear: 12.2 });
    expect(stockCoverage(10, 0, 30)).toEqual({ coverageDays: null, turnoverPerYear: null });
    expect(stockCoverage(0, 5, 30)).toEqual({ coverageDays: 0, turnoverPerYear: null });
  });
});
