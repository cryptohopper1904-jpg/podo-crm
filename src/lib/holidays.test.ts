import { describe, expect, it } from "vitest";
import { easterSunday, holidayOn, holidays } from "./holidays";

describe("Feiertage", () => {
  it("berechnet Ostern korrekt", () => {
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe("2026-04-05");
    expect(easterSunday(2027).toISOString().slice(0, 10)).toBe("2027-03-28");
  });
  it("kennt Landesfeiertage", () => {
    expect(holidayOn("2026-10-31", "BB")).toBe("Reformationstag");
    expect(holidayOn("2026-10-31", "BY")).toBeNull();
    expect(holidayOn("2026-11-18", "SN")).toBe("Buß- und Bettag");
    expect(holidays(2026, "BE").some((h) => h.name === "Internationaler Frauentag")).toBe(true);
  });
});
