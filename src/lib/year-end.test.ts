import { describe, expect, it } from "vitest";
import { dateDe } from "./format";
import { creditedReceiptsBlock, creditedReceiptsNote, paymentSummary, serviceYear } from "./invoice-view";
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
describe("Sammelrechnung: angerechnete Quittungen (Teilrechnungen)", () => {
  const receipts = [
    // 45,00 € steuerfrei + 11,90 € mit 19 %
    { kind: "receipt", number: "Q2026-0004", issuedAt: "2026-02-03", totalCents: 5690, netCents: 5500, vatCents: 190, vatGroups: [{ rate: 0, netCents: 4500, vatCents: 0 }, { rate: 19, netCents: 1000, vatCents: 190 }] },
    { kind: "receipt", number: "Q2026-0019", issuedAt: "2026-05-06", totalCents: 4500, netCents: 4500, vatCents: 0, vatGroups: [{ rate: 0, netCents: 4500, vatCents: 0 }] },
  ];

  it("je Quittung „abzgl. bereits bezahlt mit Quittung …“ mit USt-Ausweis (§ 14 Abs. 5 UStG), danach verbleibende USt", () => {
    expect(paymentSummary({ kind: "collective", paidCents: 10190, vatCents: 190 }, receipts, dateDe)).toEqual([
      { label: "abzgl. bereits bezahlt mit Quittung Q2026-0004 vom 03.02.2026 (netto 55,00 € zzgl. 19 % USt 1,90 €)", cents: -5690 },
      { label: "abzgl. bereits bezahlt mit Quittung Q2026-0019 vom 06.05.2026", cents: -4500 },
      { label: "darin verbleibende USt", cents: 0 },
    ]);
  });

  it("mehrere Steuersätze in einer Quittung, gemischt mit Anzahlung und Restzahlung", () => {
    const mixed = { kind: "receipt", number: "Q2026-0030", issuedAt: "2026-07-01", totalCents: 2260, netCents: 2000, vatCents: 260, vatGroups: [{ rate: 7, netCents: 1000, vatCents: 70 }, { rate: 19, netCents: 1000, vatCents: 190 }] };
    const deposit = { number: "AZ2026-0002", issuedAt: "2026-08-01", totalCents: 4500, netCents: 4500, vatCents: 0 };
    expect(paymentSummary({ kind: "collective", paidCents: 9760, vatCents: 260 }, [mixed, deposit], dateDe)).toEqual([
      { label: "abzgl. bereits bezahlt mit Quittung Q2026-0030 vom 01.07.2026 (netto 20,00 € zzgl. 7 % USt 0,70 € + 19 % USt 1,90 €)", cents: -2260 },
      { label: "abzgl. Anzahlung AZ2026-0002 vom 01.08.2026", cents: -4500 },
      { label: "darin verbleibende USt", cents: 0 },
      { label: "weitere Zahlungen", cents: 3000 },
    ]);
  });

  it("Block „Bereits bezahlt (Quittungen)“: nur normale Quittungen, mit Summe und USt", () => {
    const deposit = { kind: "deposit", number: "AZ2026-0002", issuedAt: "2026-08-01", totalCents: 4500, vatCents: 0 };
    expect(creditedReceiptsBlock([...receipts, deposit])).toEqual({
      rows: [
        { number: "Q2026-0004", issuedAt: "2026-02-03", totalCents: 5690, vatCents: 190 },
        { number: "Q2026-0019", issuedAt: "2026-05-06", totalCents: 4500, vatCents: 0 },
      ],
      totalCents: 10190,
      vatCents: 190,
    });
    expect(creditedReceiptsBlock([deposit]).rows).toEqual([]);
  });
});

describe("Sammelrechnung mit Quittungen: verbleibende USt je Steuersatz und Hinweis", () => {
  it("weist die verbleibende USt je Satz aus, wenn die Steuersätze der Rechnung bekannt sind", () => {
    const q = { kind: "receipt", number: "Q2026-0004", issuedAt: "2026-02-03", totalCents: 5690, netCents: 5500, vatCents: 190, vatGroups: [{ rate: 0, netCents: 4500, vatCents: 0 }, { rate: 19, netCents: 1000, vatCents: 190 }] };
    // Sammelrechnung: 45 € + 11,90 € (aus der Quittung) + 23,80 € neu mit 19 % und 10,70 € mit 7 %
    const groups = [{ rate: 0, vatCents: 0 }, { rate: 7, vatCents: 70 }, { rate: 19, vatCents: 570 }];
    expect(paymentSummary({ kind: "collective", paidCents: 5690, vatCents: 640 }, [q], dateDe, groups).slice(1)).toEqual([
      { label: "darin verbleibende USt 7 %", cents: 70 },
      { label: "darin verbleibende USt 19 %", cents: 380 },
    ]);
  });

  it("Hinweistext mit Leistungsjahr", () => {
    expect(serviceYear(["2026-03-01", "2026-01-12"], "2027-01-10")).toBe("2026");
    expect(serviceYear([], "2027-01-10")).toBe("2027");
    expect(creditedReceiptsNote("2026")).toMatch(/^Diese Rechnung fasst die Leistungen 2026 zusammen\..*nicht erneut geschuldet\. Die Quittungen bleiben gültige Rechnungen\.$/);
  });
});
