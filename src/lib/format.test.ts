import { describe, expect, it } from "vitest";
import { berlinToUtc, money, parseMoney } from "./format";

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
