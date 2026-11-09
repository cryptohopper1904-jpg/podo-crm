/** Praxis-Modus „nur Privat-/Selbstzahler“: zentrale Feature-Map, Hinweise, Navigation, News-Filter. */
import { describe, expect, it } from "vitest";
import {
  GKV_AREAS,
  billingModeOf,
  feature,
  filterNewsForOrg,
  gkvGuard,
  hiddenAreaHint,
  hiddenAreaRedirect,
  isGkvNews,
  isPrivateOnly,
  privateOnlyNote,
  removeHiddenNav,
} from "./features";

const priv = { settings: { billingMode: "private_only" } };
const gkv = { settings: { billingMode: "with_gkv" } };
const legacy = { settings: {} };

describe("billingMode", () => {
  it("Bestandspraxen ohne Einstellung bzw. mit ungültigem Wert: mit Kassenzulassung", () => {
    expect(billingModeOf({})).toBe("with_gkv");
    expect(billingModeOf(null)).toBe("with_gkv");
    expect(billingModeOf({ billingMode: "irgendwas" })).toBe("with_gkv");
    expect(isPrivateOnly(legacy)).toBe(false);
    expect(isPrivateOnly(null)).toBe(false);
  });
  it("erkennt private_only aus settings und aus dem AuthContext", () => {
    expect(isPrivateOnly(priv)).toBe(true);
    expect(isPrivateOnly({ billingMode: "private_only" })).toBe(true);
    expect(isPrivateOnly({ billingMode: "with_gkv", settings: { billingMode: "private_only" } })).toBe(false);
  });
});

describe("Feature-Map", () => {
  const areas = Object.keys(GKV_AREAS) as (keyof typeof GKV_AREAS)[];
  it("alle Kassen-Bereiche sind bei private_only aus, sonst an", () => {
    for (const a of [...areas, "gkv" as const]) {
      expect(feature(priv, a)).toBe(false);
      expect(feature(gkv, a)).toBe(true);
      expect(feature(legacy, a)).toBe(true);
    }
  });
  it("Hinweis unter der Einstellung nennt genau die Bereiche der Map", () => {
    const note = privateOnlyNote();
    for (const a of Object.values(GKV_AREAS)) expect(note).toContain(a.label);
    expect(note).toMatch(/Vorhandene Daten bleiben erhalten/);
    expect(note).toContain("Verordnungen");
    expect(note).toContain("TI & KIM");
  });
  it("Hinweis bei Direktaufruf und Weiterleitung", () => {
    expect(hiddenAreaHint("verordnungen")).toBe(
      "Verordnungen sind ausgeblendet, weil deine Praxis nur Privatpatient:innen & Selbstzahler behandelt – ändern unter Einstellungen → Praxisdaten.",
    );
    expect(hiddenAreaHint("copayment")).toMatch(/^„Zuzahlung“ ist ausgeblendet/);
    expect(hiddenAreaRedirect("verordnungen")).toBe("/heute?ausgeblendet=verordnungen");
  });
  it("gkvGuard: freundliche Meldung nur bei private_only", () => {
    expect(gkvGuard(gkv)).toBeNull();
    expect(gkvGuard(priv, "gkvBilling")?.error).toMatch(/^Nicht verfügbar: Die GKV-Abrechnung ist ausgeblendet/);
  });
});

describe("Navigation", () => {
  it("„Verordnungen“ verschwindet nur bei private_only", () => {
    const keys = () => ["heute", "kunden", "verordnungen", "pflegeheime", "rechnungen"];
    expect(removeHiddenNav(gkv, keys())).toEqual(keys());
    expect(removeHiddenNav(legacy, keys())).toEqual(keys());
    const k = keys();
    removeHiddenNav(priv, k); // in-place
    expect(k).toEqual(["heute", "kunden", "pflegeheime", "rechnungen"]);
  });
});

describe("News-Filter", () => {
  const items = [
    { title: "Neue Heilmittel-Richtlinie ab 2027", summary: null, category: "Recht & Abrechnung" },
    { title: "GKV-Spitzenverband: Vergütung Podologie", summary: "", category: "Recht & Abrechnung" },
    { title: "Kassensicherungsverordnung: TSE-Pflicht", summary: "Registrierkassen", category: "Recht & Abrechnung" },
    { title: "Urteil zur Umsatzsteuer bei Fußpflege", summary: "", category: "Recht & Abrechnung" },
    { title: "Neue Verordnung zur Fortbildung", summary: "", category: "Fortbildung" },
  ];
  it("blendet nur GKV-/Heilmittel-Meldungen aus „Recht & Abrechnung“ aus", () => {
    expect(items.map(isGkvNews)).toEqual([true, true, false, false, false]);
    expect(filterNewsForOrg(priv, items).map((i) => i.title)).toEqual([items[2].title, items[3].title, items[4].title]);
    expect(filterNewsForOrg(gkv, items)).toHaveLength(5);
  });
});
