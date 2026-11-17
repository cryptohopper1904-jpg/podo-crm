import { describe, expect, it } from "vitest";
import { GKV_POSITIONS, PRICE_VERSIONS, hpnrFor, positionFits, positionsForGroup, priceFor, toZlHpnr } from "./podologie-verguetung";

describe("Vergütungsliste Podologie (Anlage 2 i. d. F. 01.07.2025)", () => {
  it("Preis nach Behandlungsdatum: § 2 ab 01.07.2025, § 3 ab 01.07.2026", () => {
    expect(priceFor("78020", "2025-07-01")).toMatchObject({ cents: 5055, copayCents: 506, validFrom: "2025-07-01" });
    expect(priceFor("78020", "2026-06-30")?.cents).toBe(5055);
    expect(priceFor("78020", "2026-07-01")).toMatchObject({ cents: 5192, copayCents: 519, validFrom: "2026-07-01" });
    expect(priceFor("78010", "2026-11-17")?.cents).toBe(3610);
  });
  it("vor dem 01.07.2025 kein Preis (ältere Anlage nicht hinterlegt)", () => {
    expect(priceFor("78020", "2025-06-30")).toBeNull();
  });
  it("Hausbesuche inkl. Wegegeld", () => {
    expect(priceFor("79933", "2025-08-01")).toMatchObject({ cents: 2361, copayCents: 236 });
    expect(priceFor("79934", "2026-07-01")).toMatchObject({ cents: 1666, copayCents: 167 });
  });
  it("Positionen ohne Zuzahlung (78220, 78530)", () => {
    expect(priceFor("78220", "2025-08-01")?.copayCents).toBeNull();
    expect(priceFor("78530", "2026-08-01")?.copayCents).toBeNull();
  });
  it("Zuzahlung (nachrichtlich) ist überall 10 % kaufmännisch gerundet", () => {
    for (const v of PRICE_VERSIONS) {
      for (const [hpnr, p] of Object.entries(v.prices)) {
        if (p.copayCents === null) continue;
        expect([hpnr, p.copayCents]).toEqual([hpnr, Math.round(p.cents / 10)]);
      }
    }
  });
  it("jede Position hat in jeder Version einen Preis", () => {
    for (const v of PRICE_VERSIONS) for (const p of GKV_POSITIONS) expect(v.prices[p.hpnr], `${v.id} ${p.hpnr}`).toBeDefined();
  });
  it("KH/KB-Nummern (6xxxx/8xxxx) haben den Preis der ZL-Nummer", () => {
    expect(toZlHpnr("68020")).toBe("78020");
    expect(toZlHpnr("89933")).toBe("79933");
    expect(toZlHpnr("12345")).toBeNull();
    expect(priceFor("88010", "2026-08-01")?.cents).toBe(3610);
    expect(hpnrFor("78010", "KH")).toBe("68010");
    expect(hpnrFor("78010", "KB")).toBe("88010");
  });
  it("Position passt zur Diagnosegruppe und zum Verordnungsdatum", () => {
    expect(positionFits("78020", "DF", "2026-01-01").ok).toBe(true);
    expect(positionFits("78020", "UI1", "2026-01-01").ok).toBe(false);
    expect(positionFits("78610", "UI2", "2025-10-01").ok).toBe(true);
    expect(positionFits("78610", "UI2", "2025-09-30").ok).toBe(false);
    expect(positionFits("78210", "UI1", "2025-10-01").ok).toBe(false);
    expect(positionFits("79933", "QF", "2026-01-01").ok).toBe(true);
    expect(positionFits("99999", "DF", "2026-01-01").ok).toBe(false);
    expect(positionsForGroup("UI1").some((p) => p.hpnr === "78010")).toBe(false);
  });
});
