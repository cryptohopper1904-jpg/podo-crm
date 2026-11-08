import { describe, expect, it } from "vitest";
import { writeCsv } from "@/integrations/csv";
import { neutralizeCsvCell, neutralizeCsvRows } from "./csv-safe";

describe("CSV-Injection", () => {
  it("entschärft Formel-Präfixe", () => {
    for (const v of ["=HYPERLINK(\"http://x\")", "+49 331", "-1+2", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(neutralizeCsvCell(v)).toBe(`'${v}`);
    }
    expect(neutralizeCsvCell("Muster")).toBe("Muster");
    expect(neutralizeCsvCell(6)).toBe(6);
    expect(neutralizeCsvCell(-5)).toBe(-5);
    expect(neutralizeCsvCell(null)).toBe(null);
  });
  it("bleibt korrekt gequotet", () => {
    const csv = writeCsv(neutralizeCsvRows([["=1+1;\"x\"", "Ab\nC", 3]]), { bom: false });
    expect(csv).toBe(`"'=1+1;""x""";"Ab\nC";3\r\n`);
  });
});
