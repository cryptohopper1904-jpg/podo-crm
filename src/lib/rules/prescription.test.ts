import { describe, expect, it } from "vitest";
import {
  START_DEADLINE_DAYS,
  START_DEADLINE_URGENT_DAYS,
  acceptsUnit,
  canTransition,
  copaymentCents,
  evaluatePrescription,
  frequencyWarnings,
  maxGapDays,
  remedyCostCents,
  startDeadline,
  statusAfterUnit,
  validatePrescription,
} from "./prescription";

describe("Behandlungsbeginn-Frist", () => {
  it("28 Tage ab Ausstellung, dringlich 14 Tage", () => {
    expect(START_DEADLINE_DAYS).toBe(28);
    expect(START_DEADLINE_URGENT_DAYS).toBe(14);
    expect(startDeadline("2026-01-01", false)).toBe("2026-01-29");
    expect(startDeadline("2026-01-01", true)).toBe("2026-01-15");
    // über Monats-/Jahresgrenze und Schaltjahr
    expect(startDeadline("2028-02-10", false)).toBe("2028-03-09");
    expect(startDeadline("2026-12-20", true)).toBe("2027-01-03");
  });
});

describe("Frequenz", () => {
  it("versteht übliche Angaben", () => {
    expect(maxGapDays("1x alle 4-6 Wochen")).toBe(42);
    expect(maxGapDays("1x alle 4 Wochen")).toBe(28);
    expect(maxGapDays("1x wöchentlich")).toBe(7);
    expect(maxGapDays("2x/Woche")).toBe(4);
    expect(maxGapDays("1-2x pro Woche")).toBe(7);
    expect(maxGapDays("14-tägig")).toBe(14);
    expect(maxGapDays("nach Bedarf")).toBeNull();
    expect(maxGapDays(null)).toBeNull();
  });

  it("warnt bei zu großen Abständen (mit Toleranz)", () => {
    const dates = ["2026-01-05", "2026-02-10", "2026-04-20"];
    const w = frequencyWarnings(dates, "1x alle 4-6 Wochen");
    // 36 Tage ok, 69 Tage > 42 + 7
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ from: "2026-02-10", to: "2026-04-20", gapDays: 69, allowedDays: 42 });
    expect(frequencyWarnings(dates, "nach Bedarf")).toEqual([]);
  });

  it("prüft laufende Verordnungen auch bis heute", () => {
    expect(frequencyWarnings(["2026-01-05"], "1x alle 4 Wochen", { today: "2026-03-01", running: true })).toHaveLength(1);
    expect(frequencyWarnings(["2026-01-05"], "1x alle 4 Wochen", { today: "2026-03-01", running: false })).toHaveLength(0);
  });
});

describe("Zuzahlung", () => {
  it("10 € + 10 % der Kosten", () => {
    const cost = remedyCostCents([{ units: 6, priceCents: 4250 }, { units: 6, priceCents: 1000 }]);
    expect(cost).toEqual({ cents: 31500, complete: true });
    expect(copaymentCents(cost.cents)).toBe(1000 + 3150);
  });
  it("rundet kaufmännisch", () => {
    expect(copaymentCents(3333)).toBe(1000 + 333);
    expect(copaymentCents(3335)).toBe(1000 + 334);
  });
  it("befreit: Flag oder unter 18", () => {
    expect(copaymentCents(30000, { exempt: true })).toBe(0);
    expect(copaymentCents(30000, { ageYears: 17 })).toBe(0);
    expect(copaymentCents(30000, { ageYears: 18 })).toBe(4000);
  });
  it("meldet fehlende Preise", () => {
    expect(remedyCostCents([{ units: 6, priceCents: null }]).complete).toBe(false);
    expect(remedyCostCents([]).complete).toBe(false);
  });
});

describe("Status", () => {
  it("open → active → completed → billing_ready → billed", () => {
    expect(statusAfterUnit("open", 1, 6)).toBe("active");
    expect(statusAfterUnit("active", 5, 6)).toBe("active");
    expect(statusAfterUnit("active", 6, 6)).toBe("completed");
    expect(statusAfterUnit("billing_ready", 6, 6)).toBe("billing_ready");
    expect(canTransition("completed", "billing_ready", { unitsUsed: 6, units: 6 }).ok).toBe(true);
    expect(canTransition("billing_ready", "billed", { unitsUsed: 6, units: 6 }).ok).toBe(true);
  });
  it("verbietet unzulässige Wechsel", () => {
    expect(canTransition("billed", "open").ok).toBe(false);
    expect(canTransition("open", "billing_ready").ok).toBe(false);
    expect(canTransition("cancelled", "active").ok).toBe(false);
  });
  it("vorzeitige Abrechnung nur mit Begründung", () => {
    expect(canTransition("active", "billing_ready", { unitsUsed: 3, units: 6 }).ok).toBe(false);
    expect(canTransition("active", "billing_ready", { unitsUsed: 3, units: 6, interruptionNote: "Patient verstorben" }).ok).toBe(true);
    expect(canTransition("active", "completed", { unitsUsed: 3, units: 6 }).ok).toBe(false);
    expect(canTransition("active", "completed", { unitsUsed: 6, units: 6 }).ok).toBe(true);
  });
  it("nimmt Einheiten nur bei offenen/aktiven VOs mit Rest an", () => {
    expect(acceptsUnit("open", 0, 6)).toBe(true);
    expect(acceptsUnit("active", 6, 6)).toBe(false);
    expect(acceptsUnit("billing_ready", 2, 6)).toBe(false);
  });
});

describe("Eingabeprüfung", () => {
  const base = { issuedAt: "2026-11-01", diagnosisGroup: "DF", units: 6, icd10: "E11.74", today: "2026-11-08", positions: [{ label: "Podologische Komplexbehandlung", units: 6 }] };
  it("akzeptiert gültige Verordnung", () => {
    expect(validatePrescription(base)).toEqual({ errors: [], warnings: [] });
  });
  it("findet Fehler und Warnungen", () => {
    expect(validatePrescription({ ...base, issuedAt: "2026-12-01" }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, positions: [] }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, positions: [{ label: "X", units: 7 }] }).errors).toHaveLength(1);
    expect(validatePrescription({ ...base, diagnosisGroup: "XY" }).errors).toContain("Unbekannte Diagnosegruppe.");
    expect(validatePrescription({ ...base, units: 10, positions: [{ label: "X", units: 10 }] }).warnings[0]).toMatch(/Höchstmenge/);
    expect(validatePrescription({ ...base, icd10: null }).warnings[0]).toMatch(/ICD-10/);
  });
});

describe("Ampel", () => {
  const vo = { issuedAt: "2026-11-01", urgent: false, units: 6, status: "open", frequency: "1x alle 4-6 Wochen", treatmentDates: [] as string[] };
  it("grün, solange die Frist weit weg ist", () => {
    const e = evaluatePrescription({ ...vo, today: "2026-11-05" });
    expect(e).toMatchObject({ light: "green", startState: "ok", startBy: "2026-11-29", unitsRemaining: 6 });
  });
  it("gelb kurz vor Fristende, rot danach", () => {
    expect(evaluatePrescription({ ...vo, today: "2026-11-26" }).light).toBe("yellow");
    expect(evaluatePrescription({ ...vo, today: "2026-11-30" })).toMatchObject({ light: "red", startState: "missed" });
  });
  it("zählt Einheiten und meldet die letzte", () => {
    const e = evaluatePrescription({ ...vo, status: "active", treatmentDates: ["2026-11-02", "2026-12-01", "2027-01-05", "2027-02-02", "2027-03-01"], today: "2027-03-02" });
    expect(e.unitsUsed).toBe(5);
    expect(e.unitsRemaining).toBe(1);
    expect(e.light).toBe("yellow");
  });
  it("blau = abrechnungsreif", () => {
    expect(evaluatePrescription({ ...vo, status: "billing_ready", treatmentDates: ["2026-11-02"], today: "2027-06-01" }).light).toBe("blue");
  });
});
