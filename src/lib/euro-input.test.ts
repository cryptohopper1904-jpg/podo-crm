import { describe, expect, it } from "vitest";
import { parseEuroInputCents } from "./euro-input";
import { deviationHint } from "./deviation-hint";

describe("parseEuroInputCents (Zuzahlung erhalten)", () => {
  it("einzelner Punkt ist Dezimaltrenner", () => {
    expect(parseEuroInputCents("12.5")).toBe(1250);
    expect(parseEuroInputCents("12.34")).toBe(1234);
    expect(parseEuroInputCents("0.5")).toBe(50);
  });
  it("Komma als Dezimaltrenner, ganze Euro", () => {
    expect(parseEuroInputCents("12,50")).toBe(1250);
    expect(parseEuroInputCents("12,5")).toBe(1250);
    expect(parseEuroInputCents("12")).toBe(1200);
    expect(parseEuroInputCents(" 12,50 € ")).toBe(1250);
  });
  it("Tausenderpunkte nur im deutschen Muster", () => {
    expect(parseEuroInputCents("1.234,56")).toBe(123456);
    expect(parseEuroInputCents("1.234")).toBe(123400);
    expect(parseEuroInputCents("12.345")).toBe(1234500);
    expect(parseEuroInputCents("1.234.567,8")).toBe(123456780);
  });
  it("leer → null, ungültig → Fehler", () => {
    expect(parseEuroInputCents("")).toBeNull();
    expect(parseEuroInputCents("   ")).toBeNull();
    expect(parseEuroInputCents(undefined)).toBeNull();
    for (const bad of ["12.345,6.7", "12,345", "1,234,56", "12.3456", "abc", "-5", "12,50,1", "1.23,45", "1e3", ".5", "12."]) {
      expect(parseEuroInputCents(bad), bad).toHaveProperty("error");
    }
  });
});

describe("deviationHint (Doku/Besuchstag)", () => {
  it("Server-Hinweis gilt nur bis zum Wechsel der Verordnung", () => {
    expect(deviationHint({ selected: true, pageText: null, serverText: "Frequenz unterschritten", serverStale: false })).toBe("Frequenz unterschritten");
    expect(deviationHint({ selected: true, pageText: null, serverText: "Frequenz unterschritten", serverStale: true })).toBeNull();
    expect(deviationHint({ selected: true, pageText: "laut Seite", serverText: "Server", serverStale: true })).toBe("laut Seite");
    expect(deviationHint({ selected: false, pageText: "laut Seite", serverText: "Server", serverStale: false })).toBeNull();
  });
});
