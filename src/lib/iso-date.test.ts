import { describe, expect, it } from "vitest";
import { isValidIsoDate } from "./iso-date";

describe("isValidIsoDate", () => {
  it("nur echte Daten im Bereich", () => {
    expect(isValidIsoDate("2026-11-13")).toBe(true);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-99-99")).toBe(false);
    expect(isValidIsoDate("9999-12-31")).toBe(false);
    expect(isValidIsoDate("13.11.2026")).toBe(false);
  });
});
