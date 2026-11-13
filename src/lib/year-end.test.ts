import { describe, expect, it } from "vitest";
import { dateDe } from "./format";
import { paymentSummary } from "./invoice-view";
import { collectiveReminderYear, estimateCents, parseYear } from "./year-end";

describe("Jahresend-Erinnerung Sammelrechnung", () => {
  it("ab 1. Dezember fürs laufende Jahr, im Januar fürs Vorjahr, sonst nicht", () => {
    expect(collectiveReminderYear("2026-11-30")).toBeNull();
    expect(collectiveReminderYear("2026-12-01")).toBe(2026);
    expect(collectiveReminderYear("2026-12-31")).toBe(2026);
    expect(collectiveReminderYear("2027-01-15")).toBe(2026);
    expect(collectiveReminderYear("2027-02-01")).toBeNull();
    expect(collectiveReminderYear("2026-06-10")).toBeNull();
  });

  it("Jahr aus Suchparameter nur im sinnvollen Bereich", () => {
    expect(parseYear("2025", 2026)).toBe(2025);
    expect(parseYear("2027", 2026)).toBe(2027);
    expect(parseYear("2030", 2026)).toBe(2026);
    expect(parseYear("1999", 2026)).toBe(2026);
    expect(parseYear(["2025"], 2026)).toBe(2026);
    expect(parseYear(undefined, 2026)).toBe(2026);
  });

  it("Schätzbetrag: Positionen ohne Preis zählen 0", () => {
    expect(estimateCents([{ quantity: 1, unitPriceCents: 4500 }, { quantity: 2, unitPriceCents: 1000 }, { quantity: 1, unitPriceCents: null }])).toBe(6500);
  });
});

describe("Rechnung: angerechnete Anzahlungen in den Summen", () => {
  it("listet jede Anzahlung einzeln und danach nur die übrigen Zahlungen", () => {
    const deps = [
      { number: "AZ2026-0001", issuedAt: "2026-03-12", totalCents: 4500 },
      { number: "AZ2026-0007", issuedAt: "2026-06-02", totalCents: 4500 },
    ];
    expect(paymentSummary({ kind: "collective", paidCents: 9000 }, deps, dateDe)).toEqual([
      { label: "abzgl. Anzahlung AZ2026-0001 vom 12.03.2026", cents: -4500 },
      { label: "abzgl. Anzahlung AZ2026-0007 vom 02.06.2026", cents: -4500 },
    ]);
    expect(paymentSummary({ kind: "collective", paidCents: 12000 }, deps, dateDe).at(-1)).toEqual({ label: "weitere Zahlungen", cents: 3000 });
  });

  it("ohne Anzahlungen wie bisher: „bezahlt“ bzw. bei Storno „erstattet/verrechnet“", () => {
    // § 14 Abs. 5 S. 2 UStG: Steuer der Anzahlung absetzen, verbleibende USt nennen
    expect(
      paymentSummary({ kind: "collective", paidCents: 11900, vatCents: 3800 }, [{ number: "AZ2026-0003", issuedAt: "2026-05-04", totalCents: 11900, netCents: 10000, vatCents: 1900 }], dateDe),
    ).toEqual([
      { label: "abzgl. Anzahlung AZ2026-0003 vom 04.05.2026 (netto 100,00 € zzgl. 19 % USt 19,00 €)", cents: -11900 },
      { label: "darin verbleibende USt", cents: 1900 },
    ]);
    expect(paymentSummary({ kind: "invoice", paidCents: 5000 }, [], dateDe)).toEqual([{ label: "bezahlt", cents: 5000 }]);
    expect(paymentSummary({ kind: "credit_note", paidCents: -5000 }, [], dateDe)).toEqual([{ label: "erstattet/verrechnet", cents: -5000 }]);
    expect(paymentSummary({ kind: "invoice", paidCents: 0 }, [], dateDe)).toEqual([]);
  });
});
