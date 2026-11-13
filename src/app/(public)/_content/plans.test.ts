import { describe, expect, it } from "vitest";
import { ADDONS, PRICE_NOTE, PUBLIC_PLANS } from "./plans";

const sp = (t: string | null | undefined) => t?.replace(/ /g, " ");
const byId = (id: string) => PUBLIC_PLANS.find((p) => p.id === id)!;

describe("Öffentliche Preise", () => {
  it("netto als Hauptpreis, brutto aus den Netto-Cent berechnet", () => {
    expect([sp(byId("starter").price), sp(byId("starter").gross)]).toEqual(["59 €", "70,21 € inkl. USt."]);
    expect([sp(byId("praxis").price), sp(byId("praxis").gross)]).toEqual(["99 €", "117,81 € inkl. USt."]);
    expect([sp(byId("plus").price), sp(byId("plus").gross)]).toEqual(["149 €", "177,31 € inkl. USt."]);
  });
  it("Testphase und Kostenlos: 0 € ohne USt-Zeile", () => {
    for (const id of ["trial", "free"]) {
      expect(sp(byId(id).price)).toBe("0 €");
      expect(byId(id).gross).toBeNull();
    }
  });
  it("Hinweise: vorläufig, Empfang/Azubis kostenlos, Zusatzplatz und Website mit Brutto", () => {
    expect(PRICE_NOTE).toMatch(/vorläufig/);
    expect(PRICE_NOTE).toMatch(/netto/);
    for (const id of ["starter", "praxis", "plus"]) expect(byId(id).note).toMatch(/Empfang und Azubis ohne eigenen Kalender sind kostenlos/);
    expect(sp(byId("plus").note)).toMatch(/\+15 € netto \(17,85 € inkl\. USt\.\) je weiterer Behandler:in/);
    expect(sp(ADDONS[0].pricing)).toMatch(/Starter: \+9 € netto\/Monat \(10,71 € inkl\. USt\., vorläufig\)/);
  });
});
