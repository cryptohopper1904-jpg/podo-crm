import { describe, expect, it } from "vitest";
import { ageYears, berlinToUtc, money, parseMoney } from "./format";

describe("Format", () => {
  it("Geld", () => {
    expect(money(6500).replace(/\s/g, " ")).toBe("65,00 €");
    expect(parseMoney("65,50")).toBe(6550);
    expect(parseMoney("1.234,5")).toBe(123450);
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney(29)).toBe(2900);
  });
  it("Berliner Zeit inkl. Sommerzeit", () => {
    expect(berlinToUtc("2026-07-01", "09:00").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(berlinToUtc("2026-12-01", "09:00").toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });
});

describe("ageYears (Berliner Kalendertag)", () => {
  it("Geburtstag kurz nach Mitternacht in Berlin zählt schon (UTC ist noch Vortag)", () => {
    // 15.03.2026, 00:30 Berlin (MEZ) = 14.03.2026, 23:30 UTC
    expect(ageYears("1950-03-15", new Date("2026-03-14T23:30:00Z"))).toBe(76);
    // eine Stunde früher: in Berlin noch der 14.03.
    expect(ageYears("1950-03-15", new Date("2026-03-14T22:30:00Z"))).toBe(75);
  });
  it("Sommerzeit, Schaltjahr, leer/ungültig", () => {
    // 01.07.2026, 00:10 Berlin (MESZ) = 30.06.2026, 22:10 UTC
    expect(ageYears("2000-07-01", new Date("2026-06-30T22:10:00Z"))).toBe(26);
    expect(ageYears("2004-02-29", new Date("2026-02-28T12:00:00Z"))).toBe(21);
    expect(ageYears("2004-02-29", new Date("2026-03-01T12:00:00Z"))).toBe(22);
    expect(ageYears(null)).toBeNull();
    expect(ageYears("kaputt")).toBeNull();
  });
});
