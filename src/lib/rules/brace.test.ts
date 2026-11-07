import { describe, expect, it } from "vitest";
import { checkBracePhotos } from "./brace";

describe("Spangen-Pflichtfotos", () => {
  it("verlangt Vorher-Foto beim Setzen", () => {
    expect(checkBracePhotos("set", []).ok).toBe(false);
    expect(checkBracePhotos("set", ["brace_before"]).ok).toBe(true);
  });
  it("akzeptiert Begründung statt Foto", () => {
    expect(checkBracePhotos("remove", [], "Kamera defekt, wird nachgereicht").ok).toBe(true);
    expect(checkBracePhotos("remove", [], "x").ok).toBe(false);
  });
  it("Kontrolle braucht kein Pflichtfoto", () => {
    expect(checkBracePhotos("check", []).ok).toBe(true);
  });
});
