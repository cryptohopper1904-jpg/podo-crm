import { describe, expect, it } from "vitest";
import { retentionDecision } from "./patient-retention";

const none = { lastTreatmentAt: null, lastAnamnesisAt: null, recordMediaCount: 0, lastInvoiceAt: null };
const now = new Date("2026-11-09T12:00:00Z");

describe("Aufbewahrung je Patient:in (Gesamt-Review H3)", () => {
  it("ohne Dokumentation und Rechnungen: vollständige Löschung", () => {
    expect(retentionDecision(none, now).mode).toBe("delete");
  });
  it("Behandlung: 10 Jahre nach der letzten Behandlung", () => {
    const d = retentionDecision({ ...none, lastTreatmentAt: new Date("2024-03-01T10:00:00Z") }, now);
    expect(d.mode).toBe("anonymize");
    if (d.mode !== "anonymize") return;
    expect(d.retainUntil.toISOString().slice(0, 10)).toBe("2034-03-01");
    expect(d.expired).toBe(false);
    expect(d.reasons[0]).toMatch(/630f/);
  });
  it("Rechnung: 8 Jahre ab Jahresende (BEG IV); Behandlungsdoku 10 Jahre – das spätere Fristende gilt", () => {
    const d = retentionDecision({ ...none, lastTreatmentAt: new Date("2020-01-05T10:00:00Z"), lastInvoiceAt: new Date("2023-01-06T00:00:00Z") }, now);
    if (d.mode !== "anonymize") throw new Error("erwartet anonymize");
    expect(d.retainUntil.toISOString().slice(0, 10)).toBe("2031-12-31");
    expect(d.reasons).toHaveLength(2);
    expect(d.reasons[1]).toMatch(/8 Jahre.*Ablaufhemmung/);
    const late = retentionDecision({ ...none, lastTreatmentAt: new Date("2020-01-05T10:00:00Z"), lastInvoiceAt: new Date("2020-01-06T00:00:00Z") }, now);
    expect(late.mode === "anonymize" && late.retainUntil.toISOString().slice(0, 10)).toBe("2030-01-05");
  });
  it("Kassenvorgang (TSE-Einzelaufzeichnung): 10 Jahre ab Jahresende", () => {
    const d = retentionDecision({ ...none, lastInvoiceAt: new Date("2024-12-30T10:00:00Z"), lastRegisterPaymentAt: new Date("2025-01-02T10:00:00Z") }, now);
    if (d.mode !== "anonymize") throw new Error("erwartet anonymize");
    expect(d.retainUntil.toISOString().slice(0, 10)).toBe("2035-12-31");
    expect(d.reasons).toHaveLength(2);
  });
  it("Anamnese oder Behandlungsfoto genügen für die Aufbewahrung", () => {
    expect(retentionDecision({ ...none, lastAnamnesisAt: new Date("2026-01-01") }, now).mode).toBe("anonymize");
    expect(retentionDecision({ ...none, recordMediaCount: 1 }, now).mode).toBe("anonymize");
  });
  it("abgelaufene Frist wird als abgelaufen gekennzeichnet", () => {
    const d = retentionDecision({ ...none, lastTreatmentAt: new Date("2010-01-01T00:00:00Z") }, now);
    expect(d.mode === "anonymize" && d.expired).toBe(true);
  });
});
