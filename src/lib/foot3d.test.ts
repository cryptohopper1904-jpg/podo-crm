import { describe, expect, it } from "vitest";
import { FOOT_POINTS } from "./foot-points";
import { REGION_ANCHORS, TOES, displayPos, parseFootPoints, pointFrom3d, regionFor3d, roundPos, serializeFootPoints, toeTip } from "./foot3d";

describe("3D-Fuß: Regionen", () => {
  it("jeder Anker liegt in seiner eigenen Region (2D ↔ 3D konsistent)", () => {
    for (const p of FOOT_POINTS) {
      expect(REGION_ANCHORS[p.id], p.id).toBeDefined();
      expect(regionFor3d(REGION_ANCHORS[p.id]), p.id).toBe(p.id);
    }
  });

  it("erkennt Nagel vs. Zehe", () => {
    const t = TOES[0];
    const tip = toeTip(t);
    expect(regionFor3d([tip[0], t.y + t.radius, tip[2] - 0.02])).toBe("N1");
    expect(regionFor3d([tip[0], t.y - t.radius, tip[2] - 0.02])).toBe("Z1"); // Zehenkuppe unten
    const t4 = TOES[3];
    expect(regionFor3d([t4.x, t4.y - t4.radius * 0.9, t4.z + 0.03])).toBe("Z25");
  });

  it("Sohle: Ballen, Mittelfuß, Ferse; Rand und Rücken", () => {
    expect(regionFor3d([-0.25, 0, 0.4])).toBe("MT1");
    expect(regionFor3d([0.0, 0, 0.45])).toBe("MT25");
    expect(regionFor3d([0.3, 0, 0.4])).toBe("MT5");
    expect(regionFor3d([0.0, 0, -0.2])).toBe("MF");
    expect(regionFor3d([0.0, 0, -0.8])).toBe("FE");
    expect(regionFor3d([0.0, 0.1, -0.99])).toBe("FR");
    expect(regionFor3d([0.32, 0.12, -0.1])).toBe("LR");
    expect(regionFor3d([0.0, 0.35, -0.2])).toBe("DR");
    expect(regionFor3d([0.0, 0.18, 0.4])).toBe("DR");
  });

  it("liefert immer ein bekanntes Kürzel – auch für Punkte außerhalb", () => {
    const keys = new Set(FOOT_POINTS.map((p) => p.id));
    for (let i = 0; i < 500; i++) {
      const p: [number, number, number] = [Math.sin(i) * 0.5, Math.abs(Math.cos(i * 1.7)) * 0.9, Math.sin(i * 0.37) * 1.1];
      expect(keys.has(regionFor3d(p))).toBe(true);
    }
  });
});

describe("3D-Fuß: Serialisierung", () => {
  it("rundet, normiert -0 und leitet das Kürzel aus pos3d ab", () => {
    expect(roundPos([0.123456, -0.0000001, 1])).toEqual([0.123, 0, 1]);
    expect(Object.is(roundPos([-0.0001, 0, 0])[0], -0)).toBe(false);
    const p = pointFrom3d("left", [-0.25, 0, 0.4]);
    expect(p).toMatchObject({ side: "left", point: "MT1", label: "Großzehenballen (MT1)", pos3d: [-0.25, 0, 0.4] });
  });

  it("Round-Trip: serialize → parse ist stabil", () => {
    const pts = [pointFrom3d("right", [0.0, 0.35, -0.2]), { side: "left" as const, point: "FE", label: "Ferse", note: "Rhagade" }];
    pts[0].note = "Druckstelle";
    const back = parseFootPoints(serializeFootPoints(pts));
    expect(back).toEqual(pts);
    expect(parseFootPoints(serializeFootPoints(back))).toEqual(back);
  });

  it("Server überschreibt ein gefälschtes Kürzel anhand der Position", () => {
    const [p] = parseFootPoints(JSON.stringify([{ side: "right", point: "N1", label: "Nagel D1", pos3d: [0, 0, -0.8] }]));
    expect(p.point).toBe("FE");
    expect(p.label).toBe("Ferse");
  });

  it("weist ungültige Daten zurück", () => {
    const bad = [
      [{ side: "oben", point: "FE" }],
      [{ side: "left", point: "XYZ" }],
      [{ side: "left", point: "FE", pos3d: [0, 0] }],
      [{ side: "left", point: "FE", pos3d: [0, 0, 99] }],
      [{ side: "left", point: "FE", pos3d: ["0", 0, 0] }],
      [{ side: "left", point: "FE", evil: true }],
      Array.from({ length: 61 }, () => ({ side: "left", point: "FE" })),
    ];
    for (const b of bad) expect(() => parseFootPoints(JSON.stringify(b))).toThrow();
    expect(() => parseFootPoints("{kaputt")).toThrow();
    expect(() => parseFootPoints(JSON.stringify([{ side: "left", point: "FE", pos3d: [0, null, 0] }]))).toThrow();
  });

  it("Anzeige-Position: pos3d hat Vorrang, sonst Anker, sonst null", () => {
    expect(displayPos({ point: "FE", pos3d: [0.1, 0.2, 0.3] })).toEqual([0.1, 0.2, 0.3]);
    expect(displayPos({ point: "FE" })).toEqual(REGION_ANCHORS.FE);
    expect(displayPos({ point: "??" })).toBeNull();
  });
});
