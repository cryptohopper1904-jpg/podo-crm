import { describe, expect, it } from "vitest";
import { catalogViewOf, filterCatalog, groupByCategory, parseCatalogQuery } from "./catalog";
import { correctionQuantity, isBelowMinimum, orderEmailText, reorderGroups, stockLimitError, stockOf, type ReorderSource } from "./stock";

describe("Warenwirtschaft: Bestand aus Bewegungen", () => {
  it("Bestand = Summe der Bewegungen", () => {
    expect(stockOf([])).toBe(0);
    expect(stockOf([{ quantity: 10 }, { quantity: -3 }, { quantity: -1 }, { quantity: 1 }])).toBe(7);
  });

  it("Inventur bucht die Differenz zum gezählten Bestand, Bruch/Eigenverbrauch immer als Abgang", () => {
    expect(correctionQuantity("inventory", 7, 5)).toEqual({ quantity: -2 });
    expect(correctionQuantity("inventory", -2, 4)).toEqual({ quantity: 6 });
    expect(correctionQuantity("inventory", 5, 5)).toEqual({ error: expect.stringMatching(/stimmt bereits/) });
    expect(correctionQuantity("inventory", 5, -1)).toHaveProperty("error");
    expect(correctionQuantity("breakage", 5, 2)).toEqual({ quantity: -2 });
    expect(correctionQuantity("own_use", 5, 0)).toHaveProperty("error");
    expect(correctionQuantity("own_use", 5, 1.5)).toHaveProperty("error");
  });

  it("Obergrenzen: höchstens 1 Mio. je Buchung, Bestand höchstens 10 Mio.", () => {
    expect(stockLimitError(0, 1_000_000)).toBeNull();
    expect(stockLimitError(0, 1_000_001)).toMatch(/je Buchung/);
    expect(stockLimitError(9_500_000, 600_000)).toMatch(/nicht übersteigen/);
    expect(stockLimitError(-9_500_000, -600_000)).toMatch(/nicht übersteigen/);
    expect(correctionQuantity("inventory", 0, 1_000_001)).toEqual({ error: expect.stringMatching(/je Buchung/) });
    expect(correctionQuantity("breakage", 0, 2_000_000)).toHaveProperty("error");
  });
});

describe("Warenwirtschaft: Nachbestellen", () => {
  const item = (patch: Partial<ReorderSource>): ReorderSource => ({
    name: "Salbe",
    unit: "Stück",
    trackStock: true,
    active: true,
    stock: 1,
    minStock: 3,
    supplierName: "Fußpflege-Großhandel",
    supplierCustomerNumber: "K-42",
    ...patch,
  });

  it("nur aktive Produkte mit Bestandsführung und erreichtem Mindestbestand", () => {
    expect(isBelowMinimum(item({}))).toBe(true);
    expect(isBelowMinimum(item({ stock: 3 }))).toBe(true);
    expect(isBelowMinimum(item({ stock: 4 }))).toBe(false);
    expect(isBelowMinimum(item({ minStock: 0, stock: 0 }))).toBe(false);
    expect(isBelowMinimum(item({ trackStock: false }))).toBe(false);
    expect(isBelowMinimum(item({ active: false }))).toBe(false);
  });

  it("gruppiert nach Lieferant (ohne Lieferant zuletzt), Vorschlag füllt auf das Doppelte des Mindestbestands", () => {
    const groups = reorderGroups([
      item({ name: "Zehenschutz", supplierName: null, stock: 0, minStock: 2 }),
      item({ name: "Hornhautsalbe", stock: 1, minStock: 3, sku: "HS-75" }),
      item({ name: "Fußcreme", supplierName: "Apotheke Nord", supplierCustomerNumber: null, stock: -1, minStock: 2 }),
      item({ name: "Nagelöl", stock: 10, minStock: 3 }),
    ]);
    expect(groups.map((g) => g.supplier)).toEqual(["Apotheke Nord", "Fußpflege-Großhandel", "ohne Lieferant"]);
    expect(groups[0].lines).toEqual([expect.objectContaining({ name: "Fußcreme", orderQty: 5 })]);
    expect(groups[1].lines).toEqual([expect.objectContaining({ name: "Hornhautsalbe", orderQty: 5, sku: "HS-75" })]);
    expect(groups[2].lines[0]).toMatchObject({ name: "Zehenschutz", orderQty: 4 });

    const text = orderEmailText(groups[1], { name: "Praxis Fuß" });
    expect(text).toContain("Kundennummer K-42");
    expect(text).toContain("- 5 Stück Hornhautsalbe (Art.-Nr. HS-75)");
    expect(text.trim().endsWith("Praxis Fuß")).toBe(true);
  });
});

describe("Kataloge: Darstellung, Filter, Sortierung", () => {
  const items = [
    { name: "Podologische Komplexbehandlung", code: "PK", category: "treatment", priceCents: 6500, active: true },
    { name: "Nägel lackieren", code: "LA", category: "cosmetic", priceCents: 1000, active: true },
    { name: "Alte Pauschale", code: "AP", category: "treatment", priceCents: 3000, active: false },
  ];

  it("Darstellung aus users.prefs, Standard Kacheln", () => {
    expect(catalogViewOf({}, "services")).toBe("kacheln");
    expect(catalogViewOf({ catalog: { services: "liste" } }, "services")).toBe("liste");
    expect(catalogViewOf({ catalog: { services: "liste" } }, "products")).toBe("kacheln");
    expect(catalogViewOf({ catalog: { products: "quatsch" } }, "products")).toBe("kacheln");
  });

  it("Status aktiv/archiviert/alle, Suche über Name und Kürzel, Sortierung", () => {
    expect(filterCatalog(items, parseCatalogQuery({})).map((i) => i.code)).toEqual(["LA", "PK"]);
    expect(filterCatalog(items, parseCatalogQuery({ status: "archiviert" })).map((i) => i.code)).toEqual(["AP"]);
    expect(filterCatalog(items, parseCatalogQuery({ status: "alle", sort: "preis" })).map((i) => i.code)).toEqual(["LA", "AP", "PK"]);
    expect(filterCatalog(items, parseCatalogQuery({ status: "alle", sort: "kuerzel" })).map((i) => i.code)).toEqual(["AP", "LA", "PK"]);
    expect(filterCatalog(items, parseCatalogQuery({ q: "nagel" })).map((i) => i.code)).toEqual(["LA"]);
    expect(filterCatalog(items, parseCatalogQuery({ q: "pk" })).map((i) => i.code)).toEqual(["PK"]);
    expect(filterCatalog(items, parseCatalogQuery({ kat: "cosmetic", status: "unsinn" })).map((i) => i.code)).toEqual(["LA"]);
  });

  it("Kacheln nach Kategorie gruppiert, in fester Reihenfolge", () => {
    expect(groupByCategory(items, ["treatment", "cosmetic"]).map(([c, l]) => [c, l.length])).toEqual([
      ["treatment", 2],
      ["cosmetic", 1],
    ]);
  });
});
