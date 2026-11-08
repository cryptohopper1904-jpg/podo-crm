/**
 * Reine Funktionen für das 3D-Fußmodell (ohne three.js – testbar, auch serverseitig nutzbar).
 *
 * Modellkoordinaten (fußeigenes System, normiert etwa -1…1, für beide Seiten gleich):
 *   x: medial (Großzehenseite) negativ → lateral (Kleinzehenseite) positiv
 *   y: Fußsohle 0 → dorsal/oben positiv
 *   z: Ferse -1 → Zehenspitzen +1
 * (In einem rechtshändigen System ist das die Geometrie eines LINKEN Fußes; der rechte Fuß wird
 * gespiegelt DARGESTELLT.) Gespeicherte pos3d sind seitenunabhängig, d. h. dieselbe anatomische
 * Stelle hat links und rechts dieselben Koordinaten.
 */
import type { FootPoint } from "@/db/schema";
import { footPointLabel } from "./foot-points";

export type Vec3 = [number, number, number];
export type Side = "left" | "right";

/** Zehen als Kapseln: Basis (x, y, z), Länge entlang der (leicht gespreizten) Achse, Radius. */
export interface ToeSpec {
  n: 1 | 2 | 3 | 4 | 5;
  x: number;
  y: number;
  z: number;
  length: number;
  radius: number;
  /** Spreizung um die y-Achse (rad), positiv = Spitze nach lateral */
  splay: number;
}

export const TOES: readonly ToeSpec[] = [
  { n: 1, x: -0.235, y: 0.115, z: 0.6, length: 0.32, radius: 0.115, splay: -0.04 },
  { n: 2, x: -0.055, y: 0.085, z: 0.62, length: 0.27, radius: 0.075, splay: 0.03 },
  { n: 3, x: 0.085, y: 0.08, z: 0.59, length: 0.245, radius: 0.07, splay: 0.08 },
  { n: 4, x: 0.205, y: 0.075, z: 0.54, length: 0.215, radius: 0.065, splay: 0.14 },
  { n: 5, x: 0.31, y: 0.07, z: 0.47, length: 0.18, radius: 0.06, splay: 0.22 },
];

/** Zehenachse: Endpunkt der Kapsel-Mittellinie */
export function toeTip(t: ToeSpec): Vec3 {
  return [t.x + Math.sin(t.splay) * t.length, t.y, t.z + Math.cos(t.splay) * t.length];
}

/** Umriss der Fußsohle (Aufsicht, x/z im Modellsystem), ab Fersenmitte. */
export const SOLE_OUTLINE: readonly [number, number][] = [
  [0, -1],
  [-0.17, -0.94],
  [-0.23, -0.72],
  [-0.21, -0.42],
  [-0.24, -0.1],
  [-0.31, 0.22],
  [-0.355, 0.46],
  [-0.33, 0.64],
  [-0.15, 0.7],
  [0.06, 0.68],
  [0.22, 0.6],
  [0.335, 0.47],
  [0.36, 0.3],
  [0.33, 0.0],
  [0.275, -0.4],
  [0.235, -0.78],
  [0.14, -0.96],
];

/** Höhe des Fußrückens über der Sohle in Abhängigkeit von der Länge z (stückweise glatt). */
const HEIGHT_PROFILE: readonly [number, number][] = [
  [-1.05, 0.3],
  [-0.75, 0.4],
  [-0.45, 0.44],
  [-0.1, 0.36],
  [0.25, 0.22],
  [0.5, 0.16],
  [0.75, 0.13],
];

const smooth = (t: number) => t * t * (3 - 2 * t);

export function dorsumHeight(zz: number, xx = 0): number {
  const p = HEIGHT_PROFILE;
  let h = p[p.length - 1][1];
  if (zz <= p[0][0]) h = p[0][1];
  else {
    for (let i = 0; i < p.length - 1; i++) {
      const [z0, h0] = p[i];
      const [z1, h1] = p[i + 1];
      if (zz >= z0 && zz <= z1) {
        h = h0 + (h1 - h0) * smooth((zz - z0) / (z1 - z0));
        break;
      }
    }
  }
  // Außenseite flacher als Innenseite
  const lateral = Math.max(0, Math.min(1, (xx + 0.05) / 0.4));
  return h * (1 - 0.28 * lateral * lateral);
}

/** Knöchel/Unterschenkel-Ansatz (Zylinder) */
export const ANKLE = { x: 0.0, z: -0.55, y0: 0.3, y1: 0.86, radiusTop: 0.17, radiusBottom: 0.22 } as const;

// ───────────────────────── Regionen ─────────────────────────

/** Abstand Punkt → Strecke (3D) und Lage auf der Strecke (0…1) */
function segment(p: Vec3, a: Vec3, b: Vec3): { dist: number; s: number } {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const s = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2));
  const c: Vec3 = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
  return { dist: Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]), s };
}

/** Nächste Zehe, falls der Punkt auf/an einer Zehe liegt. */
export function toeAt(p: Vec3): { toe: ToeSpec; s: number } | null {
  let best: { toe: ToeSpec; s: number; rel: number } | null = null;
  for (const t of TOES) {
    const { dist, s } = segment(p, [t.x, t.y, t.z], toeTip(t));
    const rel = dist / t.radius;
    if (rel <= 1.6 && (!best || rel < best.rel)) best = { toe: t, s, rel };
  }
  if (!best) return null;
  // Zehengrundgelenk-Übergang gehört zum Vorfuß, nicht zur Zehe
  if (best.s <= 0 && p[2] < best.toe.z) return null;
  return { toe: best.toe, s: best.s };
}

const PLANTAR_Y = 0.07;

/**
 * Ordnet eine Stelle am 3D-Modell dem nächsten anatomischen Kürzel des 2D-Vokabulars zu
 * (siehe src/lib/foot-points.ts), damit 2D-Ansicht, Akte-Druck und Berichte weiter funktionieren.
 */
export function regionFor3d(pos: Vec3): string {
  const [x, y, zz] = pos;
  const toe = toeAt(pos);
  if (toe) {
    const t = toe.toe;
    // Nagel: distale Hälfte, Oberseite der Zehe
    if (toe.s >= 0.45 && y >= t.y + 0.35 * t.radius) return `N${t.n}`;
    return t.n === 1 ? "Z1" : "Z25";
  }
  if (y > ANKLE.y0 + 0.12 && zz < -0.2) return zz < ANKLE.z ? "FE" : "DR"; // Knöchel/Ansatz Unterschenkel
  const plantar = y <= PLANTAR_Y;
  if (zz < -0.62) {
    if (zz < -0.93) return "FR";
    if (plantar) return "FE";
    return y < 0.22 ? "FR" : "FE";
  }
  if (zz < 0.28) {
    if (!plantar && y > 0.18 && x < 0.26) return "DR";
    if (x > 0.24 && y < 0.24) return "LR";
    return "MF";
  }
  // Vorfuß (Ballen)
  if (!plantar && y > 0.13 && x > -0.3 && x < 0.3) return "DR";
  if (x < -0.13) return "MT1";
  if (x > 0.2) return "MT5";
  return "MT25";
}

/** Gut sichtbare Ankerpunkte je Kürzel (für Markierungen ohne pos3d, z. B. aus dem 2D-Schema). */
export const REGION_ANCHORS: Record<string, Vec3> = (() => {
  const nail = (n: number): Vec3 => {
    const t = TOES[n - 1];
    const tip = toeTip(t);
    const s = 0.8;
    return [t.x + (tip[0] - t.x) * s, t.y + t.radius * 0.95, t.z + (tip[2] - t.z) * s];
  };
  const toeMid = (n: number): Vec3 => {
    const t = TOES[n - 1];
    const tip = toeTip(t);
    return [t.x + (tip[0] - t.x) * 0.25, t.y - t.radius * 0.6, t.z + (tip[2] - t.z) * 0.25];
  };
  return {
    N1: nail(1),
    N2: nail(2),
    N3: nail(3),
    N4: nail(4),
    N5: nail(5),
    Z1: toeMid(1),
    Z25: toeMid(3),
    MT1: [-0.22, 0, 0.44],
    MT25: [0.03, 0, 0.47],
    MT5: [0.27, 0, 0.36],
    MF: [0.02, 0, -0.1],
    LR: [0.33, 0.1, 0.0],
    FE: [0.03, 0, -0.78],
    FR: [0.0, 0.12, -1.0],
    DR: [-0.02, 0.34, -0.15],
  };
})();

/** Position für die Anzeige: gespeicherte pos3d oder Anker des Kürzels. */
export function displayPos(p: Pick<FootPoint, "point" | "pos3d">): Vec3 | null {
  if (p.pos3d && isVec3(p.pos3d)) return p.pos3d;
  return REGION_ANCHORS[p.point] ?? null;
}

// ───────────────────────── Serialisierung ─────────────────────────

export const POS_LIMIT = 1.5;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= POS_LIMIT);
}

/** auf 3 Nachkommastellen runden (≈ 0,1 mm bei 25 cm Fuß – genug, kompakt im JSON) */
export const roundPos = (p: readonly number[]): Vec3 => [0, 1, 2].map((i) => Math.round((p[i] ?? 0) * 1000) / 1000 + 0) as Vec3;

export function serializeFootPoints(points: FootPoint[]): string {
  return JSON.stringify(points.map((p) => ({ ...p, ...(p.pos3d ? { pos3d: roundPos(p.pos3d) } : {}) })));
}

/** Neue Markierung aus einem Treffer am 3D-Modell */
export function pointFrom3d(side: Side, pos: readonly number[]): FootPoint {
  const p = roundPos(pos);
  const point = regionFor3d(p);
  return { side, point, label: footPointLabel(point), pos3d: p };
}
