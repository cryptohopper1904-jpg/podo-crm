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
  it("negative Beträge bleiben Zahlen (kein Apostroph), Formeln mit Minus weiter entschärft – Paket C R1-15", () => {
    for (const v of ["-12,50", "-12.50", "-5", "-0,01", "-1234567,89"]) expect(neutralizeCsvCell(v)).toBe(v);
    for (const v of ["-1+1", "-12,50+1", "-A1", "-12,5,0", "- 12,50", "-12,50\t", "-1e5", "--12"]) expect(neutralizeCsvCell(v)).toBe(`'${v}`);
  });
  it("bleibt korrekt gequotet", () => {
    const csv = writeCsv(neutralizeCsvRows([["=1+1;\"x\"", "Ab\nC", 3]]), { bom: false });
    expect(csv).toBe(`"'=1+1;""x""";"Ab\nC";3\r\n`);
  });
});
