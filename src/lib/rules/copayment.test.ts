import { describe, expect, it } from "vitest";
import { copaymentBreakdown, copaymentExpectedNote, copaymentReceiptLines } from "./copayment";
import { priceSnapshot } from "./prescription";
import { priceFor } from "./podologie-verguetung";

const day = "2026-08-03";

describe("Zuzahlungsquittung: Aufteilung je Position + Pauschale", () => {
  it("summiert den 10-%-Anteil je Position aus dem Snapshot, Pauschale gedeckelt wie dort", () => {
    const snap = priceSnapshot({
      positions: [{ position: "78020", label: "groß", units: 2 }, { position: "79933", label: "Hausbesuch", units: 2 }],
      treatmentDates: [day, "2026-09-01"],
      birthDate: "1950-01-01",
      exemptions: [],
      computedOn: day,
    });
    const b = copaymentBreakdown(snap);
    expect(b.positions.map((p) => p.position)).toEqual(["78020", "79933"]);
    expect(b.positions[0]).toEqual({ position: "78020", units: 2, cents: 2 * priceFor("78020", day)!.copayCents! });
    expect(b.flatCents).toBe(1000);
    expect(b.totalCents).toBe(snap.copaymentCents);
  });

  it("Position ohne Zuzahlung (78530) und befreite Tage tauchen nicht auf", () => {
    const snap = priceSnapshot({
      positions: [{ position: "78610", label: "Spange", units: 1 }, { position: "78530", label: "Therapiebericht", units: 1 }],
      treatmentDates: [day],
      birthDate: "1950-01-01",
      exemptions: [],
      computedOn: day,
    });
    const b = copaymentBreakdown(snap);
    expect(b.positions.map((p) => p.position)).toEqual(["78610"]);
    const exempt = copaymentBreakdown(priceSnapshot({ positions: [{ position: "78020", label: "groß", units: 1 }], treatmentDates: [day], birthDate: "1950-01-01", exemptions: [{ validFrom: "2026-01-01", validTo: "2026-12-31" }], computedOn: day }));
    expect(exempt).toEqual({ positions: [], flatCents: 0, totalCents: 0 });
  });

  it("Quittungszeilen: genau die berechnete Zuzahlung → je Position + Pauschale, sonst eine Zeile; Hinweis bei Teilbetrag", () => {
    const b = { positions: [{ position: "78020", units: 2, cents: 1000 }], flatCents: 1000, totalCents: 2000 };
    expect(copaymentReceiptLines(b, 2000, { prescriptionLabel: "Heilmittelverordnung vom 01.08.2026", positionLabel: () => "Podologische Behandlung (groß)" })).toEqual([
      { description: "Zuzahlung 10 % – Pos. 78020 Podologische Behandlung (groß) (2 Einheiten)", cents: 1000 },
      { description: "Zuzahlung je Verordnung (Verordnungsblattgebühr)", cents: 1000 },
    ]);
    expect(copaymentReceiptLines(b, 500, { prescriptionLabel: "Heilmittelverordnung vom 01.08.2026" })).toEqual([{ description: "Zuzahlung zur Heilmittelverordnung vom 01.08.2026", cents: 500 }]);
    expect(copaymentReceiptLines(null, 500, { prescriptionLabel: "X" })).toHaveLength(1);
    expect(copaymentExpectedNote(b, 2000, 0)).toBeNull();
    expect(copaymentExpectedNote(b, 500, 0)).toBe("Berechnete Zuzahlung 20,00 € (Pos. 78020: 10,00 €, je Verordnung: 10,00 €), offen nach dieser Zahlung 15,00 €.");
    expect(copaymentExpectedNote(b, 500, 1500)).toBe("Berechnete Zuzahlung 20,00 € (Pos. 78020: 10,00 €, je Verordnung: 10,00 €), bereits quittiert 15,00 €.");
  });
});
