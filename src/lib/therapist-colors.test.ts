import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assignTherapistColors, byJoined, isTherapistColor, THERAPIST_COLORS, THERAPIST_COLOR_LABELS } from "./therapist-colors";

describe("Farbvergabe je Behandler:in", () => {
  it("automatisch der Reihe nach, gewählte Farben werden nicht doppelt vergeben", () => {
    const m = assignTherapistColors([
      { id: "a", color: null },
      { id: "b", color: "teal" },
      { id: "c", color: null },
      { id: "d", color: "#ff0000" }, // alter Hex-Wert → automatisch
    ]);
    expect(m.get("b")).toBe("teal");
    expect(m.get("a")).toBe("blue");
    expect(m.get("c")).toBe("violet");
    expect(m.get("d")).toBe("rose");
  });

  it("mehr Personen als Farben: Palette wird wiederholt", () => {
    const team = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, color: null }));
    const m = assignTherapistColors(team);
    expect(new Set(m.values()).size).toBe(THERAPIST_COLORS.length);
    expect(m.get("p10")).toBe(THERAPIST_COLORS[0]);
  });

  it("Reihenfolge nach Eintritt – neue Personen verschieben bestehende Farben nicht", () => {
    const t = (id: string, d: string) => ({ id, color: null, joinedAt: new Date(d) });
    const before = assignTherapistColors(byJoined([t("z", "2026-01-01"), t("y", "2026-02-01")]));
    const after = assignTherapistColors(byJoined([t("a-neu", "2026-03-01"), t("y", "2026-02-01"), t("z", "2026-01-01")]));
    expect(after.get("z")).toBe(before.get("z"));
    expect(after.get("y")).toBe(before.get("y"));
  });

  it("gleiche Millisekunde: Mikrosekunden entscheiden, sonst die ID – unabhängig von der Eingabereihenfolge", () => {
    const at = new Date("2026-05-01T10:00:00.123Z");
    const a = { id: "b-later-id", color: null, joinedAt: at, joinedKey: "20260501100000123001" };
    const b = { id: "a-earlier-id", color: null, joinedAt: at, joinedKey: "20260501100000123002" };
    expect(byJoined([b, a]).map((t) => t.id)).toEqual(["b-later-id", "a-earlier-id"]);
    expect(byJoined([a, b]).map((t) => t.id)).toEqual(["b-later-id", "a-earlier-id"]);
    const c = { id: "y", color: null, joinedAt: at }, d = { id: "x", color: null, joinedAt: at };
    expect(byJoined([c, d]).map((t) => t.id)).toEqual(["x", "y"]);
    expect(byJoined([d, c]).map((t) => t.id)).toEqual(["x", "y"]);
  });

  it("nur bekannte Schlüssel sind gültig; jede Farbe hat einen Namen", () => {
    expect(isTherapistColor("teal")).toBe(true);
    expect(isTherapistColor("#0d9488")).toBe(false);
    expect(isTherapistColor(null)).toBe(false);
    for (const c of THERAPIST_COLORS) expect(THERAPIST_COLOR_LABELS[c]).toBeTruthy();
  });
});

/** WCAG-Kontrast aus Hex */
function lum(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("Palette in globals.css (hell und dunkel lesbar)", () => {
  const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
  const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
  const vars = (b: string) => Object.fromEntries([...b.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
  const themes = { hell: vars(block(":root")), dunkel: vars(block('[data-theme="dark"]')) };

  for (const [name, v] of Object.entries(themes)) {
    it(`${name}: Text auf getönter Fläche ≥ 4.5:1, Rand/Punkt zur Fläche ≥ 3:1`, () => {
      for (const c of THERAPIST_COLORS) {
        const strong = v[`tc-${c}`], soft = v[`tc-${c}-soft`], text = v[`tc-${c}-text`];
        expect([c, strong, soft, text].every(Boolean), c).toBe(true);
        expect(contrast(text, soft), `${c} Text/Fläche`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(strong, v.surface), `${c} Rand/Seite`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
