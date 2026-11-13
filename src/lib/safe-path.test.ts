import { describe, expect, it } from "vitest";
import { isSafeReturnPath } from "./safe-path";

describe("isSafeReturnPath", () => {
  it("nimmt interne, einfache Pfade mit prozentkodierter Query an", () => {
    for (const ok of ["/heute", "/kunden?q=D%27Angelo%20M&status=active", "/kalender?datum=2026-11-13&ansicht=woche"]) {
      expect(isSafeReturnPath(ok)).toBe(true);
    }
  });

  it("lehnt externe, protokollrelative und unkodierte Sonderzeichen ab", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "heute", "/kunden?q=D'Angelo", "/kunden#x", `/${"a".repeat(300)}`]) {
      expect(isSafeReturnPath(bad)).toBe(false);
    }
  });
});
