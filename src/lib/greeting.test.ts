import { describe, expect, it } from "vitest";
import { greeting } from "./greeting";

describe("Begrüßung nach Berliner Uhrzeit", () => {
  it("Winterzeit: 07:28 Berlin = Morgen, 12:00 = Tag, 18:30 = Abend", () => {
    expect(greeting(new Date("2026-11-14T06:28:00Z"))).toBe("Guten Morgen");
    expect(greeting(new Date("2026-11-14T11:00:00Z"))).toBe("Guten Tag");
    expect(greeting(new Date("2026-11-14T17:30:00Z"))).toBe("Guten Abend");
  });
  it("Sommerzeit und Grenzen", () => {
    expect(greeting(new Date("2026-07-14T08:59:00Z"))).toBe("Guten Morgen"); // 10:59
    expect(greeting(new Date("2026-07-14T09:00:00Z"))).toBe("Guten Tag"); // 11:00
    expect(greeting(new Date("2026-07-14T16:00:00Z"))).toBe("Guten Abend"); // 18:00
    expect(greeting(new Date("2026-07-13T22:30:00Z"))).toBe("Guten Morgen"); // 00:30
  });
});
