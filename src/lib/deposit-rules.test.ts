import { describe, expect, it } from "vitest";
import { depositAllowed, depositCheckHint, depositNotYetCreditable, depositPreselected } from "./deposit-rules";

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

describe("Vorauswahl von Anzahlungen in Rechnung/Sammelrechnung", () => {
  const today = "2026-11-13";
  const ctx = { today, receiptsYear: 2026, presetRefs: new Set<string>() };
  const dep = (p: { serviceDay?: string | null; appointmentId?: string | null; issuedAt?: string }) => ({
    appointmentId: p.appointmentId === undefined ? "a1" : p.appointmentId,
    treatmentRecordId: null,
    issuedAt: p.issuedAt ?? "2026-05-01",
    serviceDay: p.serviceDay,
  });
  it("Sammelrechnung: nur Anzahlungen mit erbrachter Leistung (Termin bis heute)", () => {
    expect(depositPreselected("collective", dep({ serviceDay: "2026-05-02" }), ctx)).toBe(true);
    expect(depositPreselected("collective", dep({ serviceDay: today }), ctx)).toBe(true);
    expect(depositPreselected("collective", dep({ serviceDay: "2026-11-20" }), ctx)).toBe(false);
    expect(depositPreselected("collective", dep({ appointmentId: null, serviceDay: null }), ctx)).toBe(false);
    // anderes Jahr
    expect(depositPreselected("collective", dep({ serviceDay: "2025-12-02", issuedAt: "2025-11-01" }), ctx)).toBe(false);
  });
  it("Rechnung aus genau diesem Termin: immer; sonst bei Rechnung nie; andere Belegarten nie", () => {
    const refs = { ...ctx, presetRefs: new Set(["a1"]) };
    expect(depositPreselected("invoice", dep({ serviceDay: "2026-11-10" }), refs)).toBe(true);
    // künftiger Termin: nie vorausgewählt (erst nach dem Termin anrechenbar)
    expect(depositPreselected("invoice", dep({ serviceDay: "2026-11-20" }), refs)).toBe(false);
    expect(depositNotYetCreditable(dep({ serviceDay: "2026-11-20" }), today)).toBe(true);
    expect(depositNotYetCreditable(dep({ serviceDay: today }), today)).toBe(false);
    expect(depositNotYetCreditable(dep({ appointmentId: null, serviceDay: null }), today)).toBe(false);
    expect(depositPreselected("invoice", dep({ serviceDay: "2026-05-02" }), ctx)).toBe(false);
    expect(depositPreselected("receipt", dep({ serviceDay: "2026-05-02" }), refs)).toBe(false);
  });
  it("Hinweis nur, wenn die Leistung nicht belegt erbracht ist", () => {
    expect(depositCheckHint(dep({ serviceDay: "2026-05-02" }), today)).toBeNull();
    expect(depositCheckHint(dep({ serviceDay: "2026-11-20" }), today)).toBe("erst nach dem Termin anrechenbar");
    expect(depositCheckHint({ ...dep({ serviceDay: null }), appointmentMissed: true }, today)).toBe("Termin abgesagt/versäumt – bitte prüfen, ggf. erstatten");
    // versäumter Termin: nicht vorausgewählt
    expect(depositPreselected("collective", { ...dep({ serviceDay: null }), appointmentMissed: true }, ctx)).toBe(false);
    expect(depositCheckHint(dep({ appointmentId: null, serviceDay: null }), today)).toMatch(/ohne Termin – Leistung erbracht\? Bitte prüfen/);
  });
});
