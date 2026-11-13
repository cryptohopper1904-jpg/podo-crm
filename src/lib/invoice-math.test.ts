import { describe, expect, it } from "vitest";
import {
  addDaysIso,
  breakEvenTreatments,
  computeTotals,
  creditNoteSettlement,
  defaultVoucherValidUntil,
  effectiveVatRate,
  lineTotalCents,
  monthlyShare,
  needsTherapeuticConfirmation,
  negateLines,
  negateTotals,
  percentChange,
  remainingVatGroups,
  statusFromPayments,
  validatePayments,
  vatPortion,
  voucherBalance,
} from "./invoice-math";

describe("Positionen und Summen", () => {
  it("rechnet Menge und Faktor", () => {
    expect(lineTotalCents(6500, 1, 1)).toBe(6500);
    expect(lineTotalCents(3000, 2, 1.5)).toBe(9000);
    expect(lineTotalCents(333, 1, 1.15)).toBe(383); // 382,95 → 383
    expect(lineTotalCents(-333, 1, 1.15)).toBe(-383);
  });

  it("berechnet den USt-Anteil aus Brutto", () => {
    expect(vatPortion(3500, 19)).toBe(559); // 3500*19/119 = 558,82
    expect(vatPortion(1070, 7)).toBe(70);
    expect(vatPortion(6500, 0)).toBe(0);
    expect(vatPortion(-3500, 19)).toBe(-559);
  });

  it("summiert je Steuersatz", () => {
    const t = computeTotals([
      { totalCents: 6500, vatRate: 0 },
      { totalCents: 3500, vatRate: 19 },
      { totalCents: 1200, vatRate: 19 },
    ]);
    expect(t.totalCents).toBe(11200);
    expect(t.vatCents).toBe(vatPortion(4700, 19));
    expect(t.netCents).toBe(11200 - vatPortion(4700, 19));
    expect(t.groups.map((g) => g.rate)).toEqual([0, 19]);
    expect(t.groups[1]).toEqual({ rate: 19, grossCents: 4700, vatCents: 750, netCents: 3950 });
  });

  it("leere Rechnung ergibt 0", () => {
    expect(computeTotals([])).toEqual({ totalCents: 0, vatCents: 0, netCents: 0, groups: [] });
  });
});

describe("USt-Logik", () => {
  it("Kleinunternehmer immer 0 %", () => {
    expect(effectiveVatRate(19, { smallBusiness: true })).toBe(0);
    expect(effectiveVatRate(19, { smallBusiness: false })).toBe(19);
    expect(effectiveVatRate(5, { smallBusiness: false })).toBe(19);
  });

  it("USt-Wächter verlangt Bestätigung nur bei 0 % mit therapeutischem Ziel", () => {
    expect(needsTherapeuticConfirmation([{ vatRate: 0, requiresTherapeuticPurpose: true }], { smallBusiness: false })).toBe(true);
    expect(needsTherapeuticConfirmation([{ vatRate: 19, requiresTherapeuticPurpose: true }], { smallBusiness: false })).toBe(false);
    expect(needsTherapeuticConfirmation([{ vatRate: 0, requiresTherapeuticPurpose: false }], { smallBusiness: false })).toBe(false);
    expect(needsTherapeuticConfirmation([{ vatRate: 0, requiresTherapeuticPurpose: true }], { smallBusiness: true })).toBe(false);
  });
});

describe("Zahlungsstatus", () => {
  it("offen, teilbezahlt, bezahlt", () => {
    expect(statusFromPayments(6500, 0)).toBe("issued");
    expect(statusFromPayments(6500, 1000)).toBe("partially_paid");
    expect(statusFromPayments(6500, 6500)).toBe("paid");
    expect(statusFromPayments(0, 0)).toBe("paid");
  });

  it("Gutschriften mit negativen Beträgen", () => {
    expect(statusFromPayments(-6500, 0)).toBe("issued");
    expect(statusFromPayments(-6500, -2000)).toBe("partially_paid");
    expect(statusFromPayments(-6500, -6500)).toBe("paid");
  });

  it("prüft Zahlungen gegen den offenen Betrag (Mischzahlung)", () => {
    expect(validatePayments(6500, [3000, 3500])).toBeNull();
    expect(validatePayments(6500, [3000, 4000])).toMatch(/übersteigen/);
    expect(validatePayments(6500, [-100])).toMatch(/positiv/);
    expect(validatePayments(-6500, [-6500])).toBeNull();
    expect(validatePayments(-6500, [100])).toMatch(/negative/);
    expect(validatePayments(6500, [])).toBeNull();
  });
});

describe("Gutscheine", () => {
  it("Restguthaben", () => {
    expect(voucherBalance(5000, [])).toBe(5000);
    expect(voucherBalance(5000, [{ amountCents: 3000 }, { amountCents: 1500 }])).toBe(500);
    expect(voucherBalance(5000, [{ amountCents: 3000 }, { amountCents: -3000 }])).toBe(5000);
  });

  it("Standard-Gültigkeit bis 31.12. des dritten Folgejahres", () => {
    expect(defaultVoucherValidUntil("2026-11-07")).toBe("2029-12-31");
    expect(defaultVoucherValidUntil("2026-01-01")).toBe("2029-12-31");
  });
});

describe("Storno", () => {
  it("negiert Positionen und Summen", () => {
    const lines = negateLines([{ description: "PK", quantity: "2", unitPriceCents: 6500, totalCents: 13000, vatRate: 0 }]);
    expect(lines[0]).toMatchObject({ quantity: "2", unitPriceCents: -6500, totalCents: -13000, vatRate: 0 });
    const t = computeTotals([{ totalCents: 3500, vatRate: 19 }]);
    const neg = negateTotals(t);
    expect(neg).toEqual({ totalCents: -3500, vatCents: -559, netCents: -2941 });
    expect(computeTotals(negateLines([{ quantity: 1, unitPriceCents: 3500, totalCents: 3500, vatRate: 19 }]))).toMatchObject(neg);
  });

  it("verrechnet den unbezahlten Teil", () => {
    expect(creditNoteSettlement(6500, 0)).toBe(-6500); // nichts bezahlt → Gutschrift sofort ausgeglichen
    expect(creditNoteSettlement(6500, 6500) + 0).toBe(0); // voll bezahlt → Erstattung offen
    expect(creditNoteSettlement(6500, 2000)).toBe(-4500);
    expect(statusFromPayments(-6500, creditNoteSettlement(6500, 0))).toBe("paid");
    expect(statusFromPayments(-6500, creditNoteSettlement(6500, 6500))).toBe("issued");
  });
});

describe("Praxisfinanzen", () => {
  it("Monatsanteil", () => {
    expect(monthlyShare(90000, "monthly")).toBe(90000);
    expect(monthlyShare(30000, "quarterly")).toBe(10000);
    expect(monthlyShare(120000, "yearly")).toBe(10000);
  });

  it("Break-even", () => {
    expect(breakEvenTreatments(300000, 5000, 350)).toBe(65); // 300000 / 4650 = 64,5
    expect(breakEvenTreatments(300000, 300, 350)).toBeNull();
    expect(breakEvenTreatments(0, 5000)).toBe(0);
  });

  it("Sammelrechnung: Rest je Steuersatz nach angerechneten Quittungen (Buchhaltungs-Übergabe)", () => {
    expect(remainingVatGroups([{ rate: 0, grossCents: 11000 }, { rate: 19, grossCents: 1190 }], [{ rate: 0, grossCents: 9000 }, { rate: 19, grossCents: 1190 }])).toEqual([{ rate: 0, grossCents: 2000 }]);
    expect(remainingVatGroups([{ rate: 0, grossCents: 4500 }], [{ rate: 0, grossCents: 4500 }])).toEqual([]);
    // Stornorechnung (negativ) minus negierte Quittungen
    expect(remainingVatGroups([{ rate: 0, grossCents: -11000 }], [{ rate: 0, grossCents: -9000 }])).toEqual([{ rate: 0, grossCents: -2000 }]);
    expect(remainingVatGroups([{ rate: 0, grossCents: 4500 }], [{ rate: 7, grossCents: 1000 }])).toEqual([{ rate: 0, grossCents: 4500 }, { rate: 7, grossCents: -1000 }]);
  });

  it("Datum und Veränderung", () => {
    expect(addDaysIso("2026-12-25", 14)).toBe("2027-01-08");
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(100, 0)).toBeNull();
  });
});
