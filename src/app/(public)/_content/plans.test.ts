import { describe, expect, it } from "vitest";
import { ADDONS, PRICE_NOTE, PRICE_PRELIMINARY_TEXT, PUBLIC_PLANS, SEATS_FAQ } from "./plans";

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
  it("enthaltene Plätze je Tarif (UWG) und Preis je weiterer Behandler:in", () => {
    expect(byId("starter").therapists).toBe("1 Behandler:in inklusive");
    expect(byId("praxis").therapists).toBe("2 Behandler:innen inklusive, bis 5 möglich");
    expect(byId("plus").therapists).toBe("3 Behandler:innen inklusive, beliebig erweiterbar");
    expect(sp(byId("praxis").note)).toContain("+15 € netto (17,85 € inkl. USt.) je weiterer Behandler:in (3.–5.)");
    expect(sp(byId("plus").note)).toContain("+15 € netto (17,85 € inkl. USt.) je weiterer Behandler:in (ab 4.)");
    expect(byId("starter").note).not.toMatch(/je weiterer/);
    for (const id of ["starter", "praxis", "plus"]) expect(byId(id).note).toMatch(/Empfang kostenlos/);
    expect(sp(ADDONS[0].pricing)).toMatch(/Starter: \+9 € netto\/Monat \(10,71 € inkl\. USt\., vorläufig\)/);
  });
  it("Pflichthinweise: nur Unternehmer, netto, vorläufig mit AGB-Verweis; FAQ zu Plätzen", () => {
    expect(PRICE_NOTE).toBe("Angebot ausschließlich für Unternehmer (§ 14 BGB), z. B. Praxen. Alle Preise netto zzgl. 19 % USt.; Bruttopreise zur Orientierung. Preise vorläufig (siehe unten).");
    expect(PRICE_PRELIMINARY_TEXT).toMatch(/mindestens sechs Wochen vorher.*AGB § 4/);
    expect(sp(SEATS_FAQ)).toMatch(/Starter 1, Praxis 2, Plus 3\); jede weitere kostet 15 € netto im Monat/);
  });
});
