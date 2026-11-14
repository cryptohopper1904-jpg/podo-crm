import { describe, expect, it } from "vitest";
import { BOTTOM_BAR_SLOTS, NAV_GROUPS, NAV_KEYS, bottomNavSplit, groupNav, showSettings, type NavKey } from "./nav";
import { VIEW_LEVELS, splitNav } from "./view-level";

const ALL = [...NAV_KEYS] as NavKey[];

describe("NAV_GROUPS (linke Navigation)", () => {
  it("jeder Bereich außer „Einstellungen“ steht in genau einer Gruppe", () => {
    const grouped = NAV_GROUPS.flatMap((g) => g.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(ALL.filter((k) => k !== "einstellungen").sort());
  });
  it("groupNav lässt leere Gruppen weg und verliert nichts", () => {
    expect(groupNav(["heute", "kasse", "einstellungen"])).toEqual([
      { id: "praxis", label: "Praxis", keys: ["heute"] },
      { id: "abrechnung", label: "Abrechnung", keys: ["kasse"] },
    ]);
  });
});

describe("bottomNavSplit (Handy/Tablet hochkant)", () => {
  it("Komplex (Standard): 4 Kernbereiche unten, alles Übrige unter „Mehr“ – A1: Rechnungen, Kasse, … erreichbar", () => {
    const { visible } = splitNav(ALL, "komplex");
    const s = bottomNavSplit(ALL, visible);
    expect(s.bar).toEqual(["heute", "kalender", "kunden", "doku"]);
    expect(s.hidden).toEqual([]);
    for (const k of ["rechnungen", "kasse", "produkte", "hygiene", "telefon", "auswertung", "team", "verordnungen", "gutscheine", "posteingang"] as const) expect(s.inView).toContain(k);
    expect(s.inView).not.toContain("einstellungen"); // steht gesondert im „Mehr“-Blatt
  });
  it("Einfach: ausgeblendete Bereiche stehen getrennt unter „Weitere Bereiche“", () => {
    const { visible } = splitNav(ALL, "einfach");
    const s = bottomNavSplit(ALL, visible);
    expect(s.bar).toEqual(["heute", "kalender", "kunden", "doku"]);
    expect(s.inView).toEqual(["rechnungen", "kasse"]);
    expect(s.hidden).toContain("posteingang");
    expect(s.hidden).toContain("auswertung");
  });
  it("ohne Kernbereiche (z. B. Steuerberatung) rücken andere Kandidaten nach, nie mehr als 4", () => {
    const accountant: NavKey[] = ["heute", "rechnungen", "gutscheine", "kasse", "produkte", "news", "auswertung"];
    const s = bottomNavSplit(accountant, accountant);
    expect(s.bar).toEqual(["heute"]);
    expect(s.inView).toEqual(["rechnungen", "gutscheine", "kasse", "produkte", "news", "auswertung"]);
    const withInbox: NavKey[] = ["heute", "kalender", "posteingang", "kunden"];
    expect(bottomNavSplit(withInbox, withInbox).bar).toEqual(["heute", "kalender", "posteingang", "kunden"]);
  });
  it("für jede Ansicht und jede Teilmenge: Leiste + „Mehr“ = erlaubte Bereiche, ohne Doppelte", () => {
    // alle 2^20 Teilmengen wären zu viel – zufällige, aber feste Auswahl (deterministisch)
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 400; n++) {
      const allowed = ALL.filter(() => rnd() < 0.6);
      for (const level of VIEW_LEVELS) {
        const { visible } = splitNav(allowed, level);
        const s = bottomNavSplit(allowed, visible);
        const all = [...s.bar, ...s.inView, ...s.hidden];
        expect(new Set(all).size).toBe(all.length);
        expect([...all, ...(allowed.includes("einstellungen") ? ["einstellungen"] : [])].sort()).toEqual([...allowed].sort());
        expect(s.bar.length).toBeLessThanOrEqual(BOTTOM_BAR_SLOTS);
        expect(s.bar.every((k) => visible.includes(k))).toBe(true);
        expect(s.hidden.every((k) => !visible.includes(k))).toBe(true);
      }
    }
  });
});

describe("showSettings (Konto-Eintrag „Einstellungen“)", () => {
  it("für alle Rollen (persönliche Seiten), im Support-Modus nur mit Praxis-Recht", () => {
    expect(showSettings(["heute"], true)).toBe(true);
    expect(showSettings(["heute", "einstellungen"], true)).toBe(true);
    expect(showSettings(["heute"], false)).toBe(false); // Support-Modus ohne Einstellungs-Recht
    expect(showSettings(["heute", "einstellungen"], false)).toBe(true);
  });
});
