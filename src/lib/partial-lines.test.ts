import { describe, expect, it } from "vitest";
import { newLine, receiptLineText, syncDepositLines, type OpenDeposit, type OpenReceipt } from "./partial-lines";

const line = (p: Partial<OpenReceipt["lines"][number]>): OpenReceipt["lines"][number] => ({
  description: "Podologische Komplexbehandlung",
  quantity: 1,
  factor: 1,
  unitPriceCents: 4500,
  vatRate: 0,
  totalCents: 4500,
  appointmentId: null,
  treatmentRecordId: null,
  serviceDate: "2026-02-03",
  ...p,
});
const receipt = (id: string, number: string, lines: OpenReceipt["lines"]): OpenReceipt => ({
  id,
  patientId: "p",
  number,
  issuedAt: "2026-02-03",
  totalCents: lines.reduce((s, l) => s + l.totalCents, 0),
  vatCents: 0,
  lines,
});

describe("Sammelrechnung: Positionen aus Quittungen", () => {
  it("Positionstext mit Leistungsdatum und Quittungsnummer", () => {
    expect(receiptLineText({ description: "Nagelspange", serviceDate: "2026-02-03" }, "Q2026-0004")).toBe("03.02.2026: Nagelspange – abgerechnet mit Quittung Q2026-0004");
    expect(receiptLineText({ description: "12.01.2026: Behandlung", serviceDate: "2026-02-03" }, "Q2026-0001")).toBe("12.01.2026: Behandlung – abgerechnet mit Quittung Q2026-0001");
    expect(receiptLineText({ description: "x".repeat(400), serviceDate: null }, "Q2026-0001")).toHaveLength(300);
  });

  it("zwei Positionen derselben Quittung zum selben Termin bleiben beide erhalten (Freitext ohne Leistung)", () => {
    const r = receipt("r1", "Q2026-0004", [
      line({ appointmentId: "a1" }),
      line({ appointmentId: "a1", description: "Nagelspange", unitPriceCents: 3000, totalCents: 3000, vatRate: 19 }),
    ]);
    const out = syncDepositLines([newLine()], [], [r]);
    expect(out.map((l) => [l.description, l.price, l.vatRate, l.appointmentId, l.serviceId])).toEqual([
      ["03.02.2026: Podologische Komplexbehandlung – abgerechnet mit Quittung Q2026-0004", "45,00", 0, "a1", ""],
      ["03.02.2026: Nagelspange – abgerechnet mit Quittung Q2026-0004", "30,00", 19, "a1", ""],
    ]);
    // unveränderte Auswahl behält die Zeilen
    expect(syncDepositLines(out, [], [r]).map((l) => l.key)).toEqual(out.map((l) => l.key));
    // abgewählt → Zeilen fallen weg
    expect(syncDepositLines(out, [], [])).toHaveLength(1);
  });

  it("nie doppelt: Termin schon als eigene Position oder aus einer anderen Quittung bzw. Anzahlung", () => {
    const own = newLine({ appointmentId: "a1", description: "Behandlung", price: "45,00" });
    const r1 = receipt("r1", "Q1", [line({ appointmentId: "a1" }), line({ appointmentId: null, description: "Creme" })]);
    const r2 = receipt("r2", "Q2", [line({ appointmentId: "a2" })]);
    const r3 = receipt("r3", "Q3", [line({ appointmentId: "a2", description: "zweite Quittung zum selben Termin" })]);
    const dep: OpenDeposit = { id: "d1", patientId: "p", number: "AZ1", issuedAt: "2026-02-03", totalCents: 4500, description: "Anzahlung", vatRate: 0, appointmentId: "a2", treatmentRecordId: null };
    const out = syncDepositLines([own], [dep], [r1, r2, r3]);
    expect(out.map((l) => l.description)).toEqual([
      "Behandlung",
      "03.02.2026: Creme – abgerechnet mit Quittung Q1",
      "03.02.2026: Podologische Komplexbehandlung – abgerechnet mit Quittung Q2",
    ]);
  });
});
