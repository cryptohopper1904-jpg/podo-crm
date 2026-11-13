import { describe, expect, it } from "vitest";
import {
  clampTimeAxis,
  defaultCalendarOptions,
  isoWeek,
  keepOptionParams,
  parseOptionParams,
  resolveCalendarOptions,
  sanitizeStoredOptions,
  toStoredOptions,
  visibleWeekDays,
} from "./calendar-options";

describe("Kalender-Anzeigeoptionen", () => {
  it("Standardwerte je Ansicht", () => {
    expect(defaultCalendarOptions("full")).toEqual({
      holidays: true,
      schoolHolidays: false,
      absences: true,
      cancelled: false,
      weekend: "auto",
      workHours: true,
      weekNumbers: true,
      startHour: 7,
      endHour: 20,
    });
    expect(defaultCalendarOptions("simple").cancelled).toBe(true);
    expect(resolveCalendarOptions("full", {})).toEqual(defaultCalendarOptions("full"));
  });

  it("gespeicherte Werte prüfen: Unbekanntes und Ungültiges fällt weg", () => {
    expect(sanitizeStoredOptions(null)).toEqual({});
    expect(sanitizeStoredOptions([1])).toEqual({});
    expect(sanitizeStoredOptions({ holidays: "ja", schoolHolidays: true, weekend: "immer", startHour: 6.5, endHour: 22, foo: 1, cancelledFull: true })).toEqual({
      schoolHolidays: true,
      endHour: 22,
      cancelledFull: true,
    });
  });

  it("URL-Parameter: 0/1, letzter Wert zählt (Formular mit verstecktem „0“), ungültige ignoriert", () => {
    expect(parseOptionParams({ feiertage: "0", ferien: ["0", "1"], abwesend: "x", abgesagt: "1", we: "keine", von: "6", bis: "99", kw: "0", az: "0" })).toEqual({
      holidays: false,
      schoolHolidays: true,
      cancelled: true,
      weekend: "keine",
      startHour: 6,
      weekNumbers: false,
      workHours: false,
    });
    expect(parseOptionParams({ we: "foo", datum: "2026-01-01" })).toEqual({});
  });

  it("Vorrang: Standard ← gespeichert ← URL; abgesagte je Ansicht getrennt", () => {
    const stored = { cancelledFull: true, holidays: false };
    expect(resolveCalendarOptions("full", stored).cancelled).toBe(true);
    expect(resolveCalendarOptions("simple", stored).cancelled).toBe(true); // Standard „Einfach“
    expect(resolveCalendarOptions("simple", { cancelledSimple: false }).cancelled).toBe(false);
    expect(resolveCalendarOptions("full", stored).holidays).toBe(false);
    expect(resolveCalendarOptions("full", stored, { holidays: true }).holidays).toBe(true);
  });

  it("Zeitachse in sinnvollen Grenzen (0–12 / 12–24, mind. 4 Std.)", () => {
    expect(clampTimeAxis(7, 20)).toEqual({ startHour: 7, endHour: 20 });
    expect(clampTimeAxis(15, 8)).toEqual({ startHour: 8, endHour: 12 });
    expect(clampTimeAxis(12, 13)).toEqual({ startHour: 9, endHour: 13 });
    expect(clampTimeAxis(-3, 30)).toEqual({ startHour: 0, endHour: 24 });
    expect(resolveCalendarOptions("full", {}, { startHour: 12, endHour: 12 })).toMatchObject({ startHour: 8, endHour: 12 });
  });

  it("speichert nur Abweichungen; abgesagte der anderen Ansicht bleiben erhalten", () => {
    const o = { ...defaultCalendarOptions("full"), schoolHolidays: true, endHour: 21 };
    expect(toStoredOptions("full", o, { cancelledSimple: false })).toEqual({ cancelledSimple: false, schoolHolidays: true, endHour: 21 });
    expect(toStoredOptions("simple", defaultCalendarOptions("simple"))).toEqual({});
    expect(toStoredOptions("simple", { ...defaultCalendarOptions("simple"), cancelled: false })).toEqual({ cancelledSimple: false });
  });

  it("Links behalten gesetzte Options-Parameter", () => {
    expect(keepOptionParams({ datum: "2026-01-01", feiertage: "0", ferien: ["0", "1"], we: "alle" })).toBe("&feiertage=0&ferien=1&we=alle");
    expect(keepOptionParams({ feiertage: "<script>" })).toBe("");
    expect(keepOptionParams({})).toBe("");
  });

  it("Wochenende: auto = Sa immer, So nur mit Terminen oder heute; alle; keine", () => {
    const week = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
    const none = () => false;
    expect(visibleWeekDays(week, "auto", none)).toEqual(week.slice(0, 6));
    expect(visibleWeekDays(week, "auto", (d) => d === "2026-11-15")).toEqual(week);
    expect(visibleWeekDays(week, "auto", none, "2026-11-15")).toEqual(week);
    expect(visibleWeekDays(week, "alle", none)).toEqual(week);
    expect(visibleWeekDays(week, "keine", () => true)).toEqual(week.slice(0, 5));
  });

  it("Kalenderwoche nach ISO 8601", () => {
    expect(isoWeek("2026-11-13")).toBe(46);
    expect(isoWeek("2026-01-01")).toBe(1);
    expect(isoWeek("2027-01-01")).toBe(53); // Freitag → KW 53 von 2026
    expect(isoWeek("2027-01-04")).toBe(1);
    expect(isoWeek("2024-12-30")).toBe(1);
  });
});
