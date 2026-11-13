import { describe, expect, it } from "vitest";
import type { NavKey } from "./nav";
import { DEFAULT_VIEW_LEVEL, NAV_BY_LEVEL, VIEW_LEVELS, isViewLevel, splitNav, todaySections, viewLevelOf } from "./view-level";

const ALL: NavKey[] = [
  "heute", "kalender", "touren", "kunden", "verordnungen", "pflegeheime", "doku", "posteingang", "telefon", "bewertungen",
  "rechnungen", "gutscheine", "kasse", "hygiene", "team", "news", "auswertung", "einstellungen", "plattform",
];

describe("viewLevelOf", () => {
  it("Standard ist „Komplex“ (bestehende Konten sehen alles wie bisher)", () => {
    expect(DEFAULT_VIEW_LEVEL).toBe("komplex");
    expect(viewLevelOf(undefined)).toBe("komplex");
    expect(viewLevelOf(null)).toBe("komplex");
    expect(viewLevelOf({})).toBe("komplex");
  });
  it("liest gültige Werte und verwirft alles andere", () => {
    expect(viewLevelOf({ view: "einfach" })).toBe("einfach");
    expect(viewLevelOf({ view: "kompakt" })).toBe("kompakt");
    expect(viewLevelOf({ view: "EINFACH" })).toBe("komplex");
    expect(viewLevelOf({ view: 1 })).toBe("komplex");
    expect(viewLevelOf({ view: "__proto__" })).toBe("komplex");
    expect(isViewLevel("komplex")).toBe(true);
    expect(isViewLevel("")).toBe(false);
  });
});

describe("splitNav", () => {
  it("Komplex: alles sichtbar, nichts unter „Mehr“", () => {
    expect(splitNav(ALL, "komplex")).toEqual({ visible: ALL, more: [] });
  });
  it("Einfach: nur die Grundbereiche, Rest unter „Mehr“ – Reihenfolge bleibt", () => {
    const { visible, more } = splitNav(ALL, "einfach");
    expect(visible).toEqual(["heute", "kalender", "kunden", "doku", "rechnungen", "kasse", "einstellungen"]);
    expect(more).toEqual(["touren", "verordnungen", "pflegeheime", "posteingang", "telefon", "bewertungen", "gutscheine", "hygiene", "team", "news", "auswertung", "plattform"]);
  });
  it("Kompakt = Einfach + Posteingang, Verordnungen, Touren, Gutscheine, Auswertung", () => {
    const { visible } = splitNav(ALL, "kompakt");
    expect(visible).toEqual(["heute", "kalender", "touren", "kunden", "verordnungen", "doku", "posteingang", "rechnungen", "gutscheine", "kasse", "auswertung", "einstellungen"]);
    for (const k of NAV_BY_LEVEL.einfach!) expect(visible).toContain(k);
  });
  it("nichts geht verloren und nichts kommt hinzu (Rechte/Tarif bleiben maßgeblich)", () => {
    const restricted: NavKey[] = ["heute", "kalender", "touren", "news", "team"]; // z. B. ohne Rechnungs-/Kassenrechte
    for (const level of VIEW_LEVELS) {
      const { visible, more } = splitNav(restricted, level);
      expect([...visible, ...more].sort()).toEqual([...restricted].sort());
      expect(visible.every((k) => restricted.includes(k))).toBe(true);
    }
    expect(splitNav(restricted, "einfach").visible).toEqual(["heute", "kalender"]);
  });
  it("verändert die übergebene Liste nicht", () => {
    const input: NavKey[] = ["heute", "news"];
    splitNav(input, "einfach");
    expect(input).toEqual(["heute", "news"]);
  });
});

describe("todaySections", () => {
  it("Komplex zeigt alles (wie bisher)", () => {
    expect(Object.entries(todaySections("komplex")).filter(([k, v]) => k !== "quickActions" && !v)).toEqual([]);
    expect(todaySections("komplex").quickActions).toBe(false);
  });
  it("Kompakt blendet nur Nebenkarten aus", () => {
    expect(todaySections("kompakt")).toMatchObject({ stats: true, inbox: true, tasks: "always", integrations: false });
  });
  it("Einfach: Schnellzugriff statt Kennzahlen, keine Nebenkarten – wichtige Erinnerungen (Sammelrechnungen) bleiben", () => {
    expect(todaySections("einfach")).toEqual({ stats: false, quickActions: true, inbox: false, collective: true, tasks: "ifOpen", integrations: false });
  });
});
