/**
 * Prozedurales, stilisiertes Fußmodell (kein Download, keine Lizenzfragen):
 *  - Fußkörper als „Loft“ entlang der Fußlänge: Querschnitte (Superellipse, flache Sohle,
 *    runder Rücken) mit Breite aus dem Sohlenumriss und Höhe aus dem Rückenprofil,
 *  - Zehen als abgerundete Kapseln, Nägel als flache Ellipsoide, Knöchelansatz als Zylinder.
 * Koordinaten wie in src/lib/foot3d.ts (Geometrie = linker Fuß; für rechts wird die Gruppe gespiegelt).
 */
import { BufferGeometry, CapsuleGeometry, CylinderGeometry, Float32BufferAttribute, Group, Mesh, SphereGeometry, Vector2, SplineCurve, type Material } from "three";
import { ANKLE, SOLE_OUTLINE, TOES, dorsumHeight, toeTip } from "@/lib/foot3d";

/** Dichter, geglätteter Sohlenumriss (geschlossen) */
function outlinePoints(): Vector2[] {
  const pts = SOLE_OUTLINE.map(([x, z]) => new Vector2(x, z));
  const closed = [...pts, pts[0], pts[1]];
  return new SplineCurve(closed).getSpacedPoints(240);
}

/** min/max x des Umrisses auf Höhe z (Schnitt mit dem Polygon) */
function widthAt(poly: Vector2[], z: number): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    if ((a.y - z) * (b.y - z) > 0 || a.y === b.y) continue;
    const x = a.x + ((z - a.y) / (b.y - a.y)) * (b.x - a.x);
    min = Math.min(min, x);
    max = Math.max(max, x);
  }
  return min < max ? [min, max] : null;
}

function bodyGeometry(): BufferGeometry {
  const poly = outlinePoints();
  const zs = poly.map((p) => p.y);
  const zMin = Math.min(...zs) + 0.004;
  const zMax = Math.max(...zs) - 0.004;
  const RINGS = 64;
  const SEG = 40;
  const pos: number[] = [];
  const idx: number[] = [];
  const maxHalf = 0.36;
  for (let r = 0; r <= RINGS; r++) {
    // dichter an den Enden (Ferse/Vorfußkante sind rund)
    const u = r / RINGS;
    const z = zMin + (zMax - zMin) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    const w = widthAt(poly, z) ?? [0, 0];
    const xc = (w[0] + w[1]) / 2;
    const a = Math.max(0.002, (w[1] - w[0]) / 2);
    // Enden auch in der Höhe abrunden
    const end = Math.min(1, a / maxHalf);
    const h = dorsumHeight(z, xc) * (0.55 + 0.45 * Math.sqrt(end));
    for (let s = 0; s < SEG; s++) {
      const t = (s / SEG) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      // Superellipse: unten flach (Sohle), oben rund (Rücken)
      const ex = 2 / (sn < 0 ? 4.5 : 2.4);
      const x = xc + a * Math.sign(c) * Math.abs(c) ** (2 / 2.6);
      let y = h / 2 + (h / 2) * Math.sign(sn) * Math.abs(sn) ** ex;
      // Fußgewölbe: Innenseite der Sohle im Mittelfuß angehoben
      if (sn < 0) {
        const medial = Math.max(0, Math.min(1, (xc - x) / a));
        const arch = Math.exp(-(((z + 0.2) / 0.32) ** 2));
        y += 0.075 * arch * medial ** 2 * Math.abs(sn);
      }
      pos.push(x, y, z);
    }
  }
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEG; s++) {
      const a = r * SEG + s;
      const b = r * SEG + ((s + 1) % SEG);
      const c = (r + 1) * SEG + s;
      const d = (r + 1) * SEG + ((s + 1) % SEG);
      idx.push(a, b, c, b, d, c); // gegen den Uhrzeigersinn von außen → Normalen zeigen nach außen
    }
  }
  // Enden (Ferse, Vorfußkante) mit einem Fächer schließen – sonst bleibt ein schmaler Schlitz offen
  for (const [ring, flip] of [[0, true], [RINGS, false]] as const) {
    const start = ring * SEG;
    let cx = 0, cy = 0, cz = 0;
    for (let s = 0; s < SEG; s++) {
      cx += pos[(start + s) * 3];
      cy += pos[(start + s) * 3 + 1];
      cz += pos[(start + s) * 3 + 2];
    }
    const center = pos.length / 3;
    pos.push(cx / SEG, cy / SEG, cz / SEG + (flip ? -0.004 : 0.004));
    for (let s = 0; s < SEG; s++) {
      const a = start + s;
      const b = start + ((s + 1) % SEG);
      if (flip) idx.push(center, b, a);
      else idx.push(center, a, b);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface FootModel {
  group: Group;
  /** Treffer-Flächen für das Raycasting */
  pickables: Mesh[];
  dispose: () => void;
}

export function buildFoot(materials: { skin: Material; nail: Material }): FootModel {
  const group = new Group();
  const geometries: BufferGeometry[] = [];
  const pickables: Mesh[] = [];
  const add = (g: BufferGeometry, m: Material) => {
    geometries.push(g);
    const mesh = new Mesh(g, m);
    group.add(mesh);
    pickables.push(mesh);
    return mesh;
  };

  add(bodyGeometry(), materials.skin);

  for (const t of TOES) {
    const tip = toeTip(t);
    const g = new CapsuleGeometry(t.radius, t.length, 8, 20);
    g.rotateX(Math.PI / 2); // Kapselachse y → z
    const toe = add(g, materials.skin);
    toe.rotation.y = t.splay;
    toe.position.set((t.x + tip[0]) / 2, t.y, (t.z + tip[2]) / 2);

    const ng = new SphereGeometry(1, 20, 12);
    const nail = add(ng, materials.nail);
    nail.scale.set(t.radius * 0.7, t.radius * 0.24, t.radius * 0.72);
    nail.rotation.y = t.splay;
    const s = 0.8;
    nail.position.set(t.x + (tip[0] - t.x) * s, t.y + t.radius * 0.84, t.z + (tip[2] - t.z) * s);
  }

  const ag = new CylinderGeometry(ANKLE.radiusTop, ANKLE.radiusBottom, ANKLE.y1 - ANKLE.y0, 40, 1);
  const ankle = add(ag, materials.skin);
  ankle.position.set(ANKLE.x, (ANKLE.y0 + ANKLE.y1) / 2, ANKLE.z);
  ankle.scale.set(1, 1, 1.12);

  return {
    group,
    pickables,
    dispose: () => geometries.forEach((g) => g.dispose()),
  };
}
