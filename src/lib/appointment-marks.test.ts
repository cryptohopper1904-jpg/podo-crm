/** Symbole N (Neupatient:in) und R (Rechnung offen/geschrieben) im Termin-Block – reine Regeln. */
import { describe, expect, it } from "vitest";
import { invoiceRelevant, markFor } from "./appointment-marks";

const now = new Date("2026-11-15T12:00:00Z");
const past = new Date("2026-11-15T10:00:00Z");
const future = new Date("2026-11-15T15:00:00Z");
const p = "11111111-1111-4111-8111-111111111111";

describe("invoiceRelevant", () => {
  it("erledigt → ja, auch wenn das Ende in der Zukunft liegt", () => {
    expect(invoiceRelevant({ status: "done", endsAt: future, patientId: p }, now)).toBe(true);
  });
  it("geplant/bestätigt: nur wenn vorbei", () => {
    expect(invoiceRelevant({ status: "planned", endsAt: past, patientId: p }, now)).toBe(true);
    expect(invoiceRelevant({ status: "confirmed", endsAt: past, patientId: p }, now)).toBe(true);
    expect(invoiceRelevant({ status: "confirmed", endsAt: future, patientId: p }, now)).toBe(false);
    expect(invoiceRelevant({ status: "planned", endsAt: now, patientId: p }, now)).toBe(true);
  });
  it("abgesagt, nicht erschienen, ohne Patient:in → nein", () => {
    expect(invoiceRelevant({ status: "cancelled", endsAt: past, patientId: p }, now)).toBe(false);
    expect(invoiceRelevant({ status: "no_show", endsAt: past, patientId: p }, now)).toBe(false);
    expect(invoiceRelevant({ status: "done", endsAt: past, patientId: null }, now)).toBe(false);
  });
});

describe("markFor", () => {
  it("R grau = offen, R grün = geschrieben", () => {
    expect(markFor({ status: "done", endsAt: past, patientId: p }, now, false, false)).toEqual({ newPatient: false, invoice: "open" });
    expect(markFor({ status: "done", endsAt: past, patientId: p }, now, false, true)).toEqual({ newPatient: false, invoice: "written" });
  });
  it("künftiger Termin: kein R, aber N möglich", () => {
    expect(markFor({ status: "confirmed", endsAt: future, patientId: p }, now, true, false)).toEqual({ newPatient: true, invoice: null });
  });
  it("abgesagter Termin: weder N noch R", () => {
    expect(markFor({ status: "cancelled", endsAt: past, patientId: p }, now, true, true)).toEqual({ newPatient: false, invoice: null });
  });
  it("ohne Patient:in: nichts", () => {
    expect(markFor({ status: "done", endsAt: past, patientId: null }, now, true, true)).toEqual({ newPatient: false, invoice: null });
  });
  it("Neupatient:in mit erledigtem, abgerechnetem Termin: N und R grün", () => {
    expect(markFor({ status: "done", endsAt: past, patientId: p }, now, true, true)).toEqual({ newPatient: true, invoice: "written" });
  });
});
