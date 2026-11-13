import { describe, expect, it } from "vitest";
import { findServiceByCode, normalizeServiceCode } from "./service-code";

const services = [
  { id: "1", code: "PK" },
  { id: "2", code: "PKB" },
  { id: "3", code: "AN" },
  { id: "4", code: "HB 1" },
];

describe("Leistungs-Kürzel", () => {
  it("findet exakt, ohne Groß-/Kleinschreibung und Leerzeichen", () => {
    expect(findServiceByCode(services, "pk")?.id).toBe("1");
    expect(findServiceByCode(services, " An ")?.id).toBe("3");
    expect(findServiceByCode(services, "hb1")?.id).toBe("4");
  });
  it("rät keine Präfixe und liefert bei Leereingabe nichts", () => {
    expect(findServiceByCode(services, "P")).toBeUndefined();
    expect(findServiceByCode(services, "PKBX")).toBeUndefined();
    expect(findServiceByCode(services, "  ")).toBeUndefined();
  });
  it("normalisiert", () => {
    expect(normalizeServiceCode(" pk b ")).toBe("PKB");
  });
});
