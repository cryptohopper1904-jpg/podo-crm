import { describe, expect, it } from "vitest";
import { computeClosing, ustKey, type KassePayment } from "./kasse/model";
import { computeTotals, needsTherapeuticConfirmation } from "./invoice-math";
import { isTreatmentLine, resolveProductVat, type VatRuleLine } from "./product-vat";

const treatment: VatRuleLine = { kind: "service", vatRate: 0, therapeutic: true };
const cosmetic: VatRuleLine = { kind: "service", vatRate: 19, therapeutic: false };
const product = (patch: Partial<Extract<VatRuleLine, { kind: "product" }>> = {}): VatRuleLine => ({
  kind: "product",
  vatRate: 19,
  productVatRate: 19,
  inTreatment: false,
  ...patch,
});
const opts = { smallBusiness: false, invoiceKind: "invoice" };

describe("Produkte: Umsatzsteuer je Position", () => {
  it("Produkt zum Mitnehmen: regulärer Satz (19 %), mit oder ohne Behandlung", () => {
    expect(resolveProductVat([product()], opts)).toEqual({ results: [{ vatRate: 19, inTreatment: false }], error: null });
    expect(resolveProductVat([treatment, product()], opts).results[1]).toEqual({ vatRate: 19, inTreatment: false });
    expect(resolveProductVat([product({ vatRate: 7, productVatRate: 7 })], opts).results[0]).toEqual({ vatRate: 7, inTreatment: false });
  });

  it("0 % ohne „in der Behandlung angewendet“ wird abgelehnt", () => {
    expect(resolveProductVat([treatment, product({ vatRate: 0 })], opts).error).toMatch(/Mitnehmen werden mit 19 %/);
  });

  it("in der Behandlung angewendet: 0 % nur mit Heilbehandlung (0 %) auf demselben Beleg", () => {
    const ok = resolveProductVat([treatment, product({ vatRate: 0, inTreatment: true })], opts);
    expect(ok).toEqual({ results: [null, { vatRate: 0, inTreatment: true }], error: null });

    // ohne Behandlungsposition
    expect(resolveProductVat([product({ vatRate: 0, inTreatment: true })], opts).error).toMatch(/nur zusammen mit einer Heilbehandlung/);
    // kosmetische Leistung (19 %) zählt nicht als Heilbehandlung
    expect(resolveProductVat([cosmetic, product({ vatRate: 0, inTreatment: true })], opts).error).toMatch(/nur zusammen mit einer Heilbehandlung/);
    // Heilbehandlungs-Leistung auf 19 % umgestellt (kein therapeutisches Ziel) zählt nicht
    expect(resolveProductVat([{ ...treatment, vatRate: 19 }, product({ vatRate: 0, inTreatment: true })], opts).error).not.toBeNull();
    // Freitext mit 0 % ist keine Katalog-Heilbehandlung
    expect(resolveProductVat([{ kind: "service", vatRate: 0, therapeutic: false }, product({ vatRate: 0, inTreatment: true })], opts).error).not.toBeNull();
    // angewendet, aber 19 % gesendet → Fehler (kein stilles Umdeuten)
    expect(resolveProductVat([treatment, product({ vatRate: 19, inTreatment: true })], opts).error).toMatch(/mit 0 %/);
  });

  it("Ausfallhonorar: keine Behandlung, keine Produkte", () => {
    expect(isTreatmentLine(treatment, "no_show_fee")).toBe(false);
    expect(resolveProductVat([treatment, product()], { ...opts, invoiceKind: "no_show_fee" }).error).toMatch(/Ausfallhonorar/);
  });

  it("Sammelrechnung mit mehreren Behandlungen: Produkt muss einer Behandlung zugeordnet sein", () => {
    const coll = { ...opts, invoiceKind: "collective" };
    const lines = [treatment, treatment, product({ vatRate: 0, inTreatment: true })];
    expect(resolveProductVat(lines, coll).error).toMatch(/zuordnen/);
    expect(resolveProductVat([treatment, treatment, product({ vatRate: 0, inTreatment: true, treatmentLine: 1 })], coll).error).toBeNull();
    // Zuordnung auf eine Nicht-Behandlung
    expect(resolveProductVat([treatment, cosmetic, product({ vatRate: 0, inTreatment: true, treatmentLine: 1 })], coll).error).toMatch(/keine Heilbehandlung/);
    // nur eine Behandlung → Zuordnung nicht nötig
    expect(resolveProductVat([treatment, product({ vatRate: 0, inTreatment: true })], coll).error).toBeNull();
  });

  it("Kleinunternehmer: immer 0 %, kein Behandlungsbezug, keine Fehler", () => {
    const sb = { ...opts, smallBusiness: true };
    expect(resolveProductVat([product({ vatRate: 0, inTreatment: true })], sb)).toEqual({ results: [{ vatRate: 0, inTreatment: false }], error: null });
    expect(resolveProductVat([product()], sb).results[0]).toEqual({ vatRate: 0, inTreatment: false });
  });

  it("0-%-Produktposition zählt für den USt-Wächter, 19 % nicht", () => {
    expect(needsTherapeuticConfirmation([{ vatRate: 0, requiresTherapeuticPurpose: true }], { smallBusiness: false })).toBe(true);
    expect(needsTherapeuticConfirmation([{ vatRate: 19, requiresTherapeuticPurpose: false }], { smallBusiness: false })).toBe(false);
  });

  it("Kasse: Behandlung (0 %) und Produkt (19 %) werden als Umsatz je Steuersatz gebucht", () => {
    const totals = computeTotals([
      { totalCents: 6500, vatRate: 0 },
      { totalCents: 1290, vatRate: 19 },
    ]);
    expect(totals.vatCents).toBe(206);
    const pay: KassePayment = {
      id: "p1",
      method: "cash",
      amountCents: totals.totalCents,
      paidAt: new Date(Date.UTC(2026, 10, 6, 9)),
      invoiceNumber: "Q1",
      vatGroups: totals.groups.map((g) => ({ rate: g.rate, grossCents: g.grossCents })),
      voucher: null,
      soldVoucher: null,
      externalRef: null,
      tse: null,
      createdBy: null,
    };
    const c = computeClosing({
      zNumber: 1,
      firstBonNr: 1,
      closedAt: new Date(Date.UTC(2026, 10, 6, 17)),
      openingCents: 0,
      openingIsNew: true,
      denominations: { "1": totals.totalCents },
      payments: [pay],
      movements: [],
    });
    const umsatz = c.totals.businessCases.filter((b) => b.gvTyp === "Umsatz");
    expect(umsatz).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ustKey: ustKey(19), grossCents: 1290, vatCents: 206 }),
        expect.objectContaining({ ustKey: ustKey(0), grossCents: 6500, vatCents: 0 }),
      ]),
    );
  });
});
