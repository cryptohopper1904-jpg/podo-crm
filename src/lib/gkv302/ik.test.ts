import { describe, expect, it } from "vitest";
import { ikMitPruefziffer, ikPruefziffer, istGueltigesIk } from "./ik";
import { TEST_IK } from "./fixtures/testdaten";

describe("IK-Prüfziffer", () => {
  it("Beispiel der Sekundärquelle: 26032682 → 260326822", () => {
    expect(ikMitPruefziffer("26032682")).toBe("260326822");
  });

  it("öffentliche IKs aus der Broschüre TP5 (Stand 04.11.2026) sind gültig", () => {
    // Datenannahmestellen/Kostenträger, wie in der Broschüre abgedruckt
    for (const ik of ["101576623", "102109128", "102171012", "103170002", "104027544", "104593971", "104940005", "105830016", "107436557", "109905003"]) {
      expect(istGueltigesIk(ik)).toBe(true);
    }
  });

  it("falsche Prüfziffer, falsche Länge und Buchstaben werden erkannt", () => {
    expect(istGueltigesIk("104027545")).toBe(false);
    expect(istGueltigesIk("10402754")).toBe(false);
    expect(istGueltigesIk("10402754A")).toBe(false);
    expect(() => ikPruefziffer("1234")).toThrow("genau 8 Ziffern");
  });

  it("alle Test-IKs (Präfix 99) haben eine gültige Prüfziffer", () => {
    for (const ik of Object.values(TEST_IK)) {
      expect(ik.startsWith("99")).toBe(true);
      expect(istGueltigesIk(ik)).toBe(true);
    }
  });
});
