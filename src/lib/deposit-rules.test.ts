import { describe, expect, it } from "vitest";
import { depositAllowed } from "./deposit-rules";

describe("Anzahlung nur als Vorauszahlung", () => {
  const today = "2026-11-13";
  it("künftiger Termin: erlaubt", () => {
    expect(depositAllowed({ appointmentDay: "2026-11-14", today, hasRecord: false })).toBe(true);
    expect(depositAllowed({ appointmentDay: "2027-01-02", today, hasRecord: false })).toBe(true);
  });
  it("heutiger oder vergangener Termin: Quittung statt Anzahlung", () => {
    expect(depositAllowed({ appointmentDay: today, today, hasRecord: false })).toBe(false);
    expect(depositAllowed({ appointmentDay: "2026-11-12", today, hasRecord: false })).toBe(false);
    expect(depositAllowed({ appointmentDay: "2025-12-31", today, hasRecord: false })).toBe(false);
  });
  it("dokumentierte Behandlung: nie", () => {
    expect(depositAllowed({ appointmentDay: "2026-11-20", today, hasRecord: true })).toBe(false);
    expect(depositAllowed({ appointmentDay: null, today, hasRecord: true })).toBe(false);
  });
  it("ohne Termin (z. B. Nagelspange): erlaubt", () => {
    expect(depositAllowed({ appointmentDay: null, today, hasRecord: false })).toBe(true);
  });
});
