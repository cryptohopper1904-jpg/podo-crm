import { describe, expect, it } from "vitest";
import type { OrgBilling } from "./plans";
import { mapLink, openingHours, parseAreas, safeUrl, telHref, websiteEntitlement, websitePublished, websiteSettings } from "./website";

const now = new Date("2026-11-09T12:00:00Z");
const org = (o: Partial<OrgBilling>): OrgBilling => ({ plan: "praxis", subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: null, seats: 1, ...o });

describe("Praxis-Website: Tarif/Zusatzmodul", () => {
  it("in Praxis/Plus/Test enthalten, Starter nur mit Zusatzmodul", () => {
    expect(websiteEntitlement(org({ plan: "praxis" }), {}, now)).toMatchObject({ entitled: true, source: "plan" });
    expect(websiteEntitlement(org({ plan: "plus" }), {}, now).entitled).toBe(true);
    expect(websiteEntitlement(org({ plan: "trial", subscriptionStatus: "trialing", trialEndsAt: new Date(now.getTime() + 86_400_000) }), {}, now).entitled).toBe(true);
    const starter = websiteEntitlement(org({ plan: "starter" }), {}, now);
    expect(starter).toMatchObject({ entitled: false, addonAvailable: true });
    expect(starter.reason).toMatch(/9 €\/Monat/);
    expect(websiteEntitlement(org({ plan: "starter" }), { websiteAddon: true }, now)).toMatchObject({ entitled: true, source: "addon" });
  });
  it("Nur-Lesen-Modus: offline; veröffentlicht nur wenn eingeschaltet", () => {
    expect(websiteEntitlement(org({ plan: "trial", subscriptionStatus: "trialing", trialEndsAt: new Date(now.getTime() - 1000) }), {}, now).entitled).toBe(false);
    expect(websitePublished({ ...org({}), settings: { website: { enabled: false } } }, now)).toBe(false);
    expect(websitePublished({ ...org({}), settings: { website: { enabled: true } } }, now)).toBe(true);
    expect(websitePublished({ ...org({ plan: "starter" }), settings: { website: { enabled: true } } }, now)).toBe(false);
  });
});

describe("Praxis-Website: Einstellungen", () => {
  it("bereinigt Einstellungen und Öffnungszeiten", () => {
    const w = websiteSettings({ website: { enabled: "ja", claim: "  Hallo  ", serviceDescriptions: { PK: "Gut", "bad key!": "x" } } });
    expect(w).toMatchObject({ enabled: false, claim: "Hallo", serviceDescriptions: { PK: "Gut" } });
    expect(openingHours({ openingHours: [{ weekday: 3, from: "08:00", to: "17:00" }, { weekday: 2, from: "08:00", to: "17:00" }, { weekday: 9, from: "08:00", to: "09:00" }, { weekday: 1, from: "18:00", to: "08:00" }] }).map((h) => h.weekday)).toEqual([2, 3]);
    expect(parseAreas("Stolpe, Borgsdorf\nStolpe;  ")).toEqual(["Stolpe", "Borgsdorf"]);
  });
  it("Links: Karte ohne Einbettung, tel:, nur http(s)", () => {
    expect(mapLink(["Goethestraße 68", "16540 Hohen Neuendorf"])).toBe("https://www.openstreetmap.org/search?query=Goethestra%C3%9Fe%2068%2C%2016540%20Hohen%20Neuendorf");
    expect(telHref("0160 96210972")).toBe("tel:+4916096210972");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("https://www.podologie-kiehne.de")).toBe("https://www.podologie-kiehne.de/");
  });
});
