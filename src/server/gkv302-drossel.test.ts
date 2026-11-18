import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { TESTDATEI_JE_MINUTE, testdateiStarten } from "./gkv302-drossel";

describe("Drosselung Testdatei je Praxis (Review-Runde 2, AppSec H3)", () => {
  it("nur eine gleichzeitige Erzeugung je Praxis, andere Praxen unabhängig", () => {
    const a = testdateiStarten("org-a", 0);
    expect("fertig" in a).toBe(true);
    expect(testdateiStarten("org-a", 1)).toEqual({ error: expect.stringContaining("läuft bereits") });
    expect("fertig" in testdateiStarten("org-b", 1)).toBe(true);
    if ("fertig" in a) a.fertig();
    expect("fertig" in testdateiStarten("org-a", 2)).toBe(true);
  });

  it(`höchstens ${TESTDATEI_JE_MINUTE} je Minute`, () => {
    for (let i = 0; i < TESTDATEI_JE_MINUTE; i++) {
      const r = testdateiStarten("org-c", 1000 + i);
      if (!("fertig" in r)) throw new Error(r.error);
      r.fertig();
    }
    expect(testdateiStarten("org-c", 2000)).toEqual({ error: expect.stringContaining("Zu viele") });
    expect("fertig" in testdateiStarten("org-c", 1000 + 61_000)).toBe(true);
  });
});
