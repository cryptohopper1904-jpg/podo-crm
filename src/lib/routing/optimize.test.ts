import { describe, expect, it } from "vitest";
import { haversineM, type LatLon } from "./geo";
import { nearestNeighbour, optimizeOrder, routeLength, timeWarnings, twoOpt } from "./optimize";

/** Punkte auf einer Geraden (x in km), Distanz = |Δx| */
const line = (xs: number[]) => (i: number, j: number) => Math.abs(xs[i] - xs[j]);

describe("Tourenoptimierung", () => {
  it("Nearest-Neighbour fährt die Punkte auf einer Linie der Reihe nach ab", () => {
    // Start 0, Besuche bei 5, 1, 3, 2
    const xs = [0, 5, 1, 3, 2];
    expect(nearestNeighbour(4, line(xs))).toEqual([2, 4, 3, 1]);
    expect(optimizeOrder(4, line(xs))).toEqual([1, 3, 2, 0]);
  });

  it("2-opt entfernt Überkreuzungen (Quadrat)", () => {
    // Start (0,0); Ecken eines Quadrats – gekreuzte Reihenfolge 1,3,2,4 → ohne Kreuzung
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0.5, y: -0.2 },
    ];
    const d = (i: number, j: number) => Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    const crossed = [1, 3, 2, 4];
    const fixed = twoOpt(crossed, d, null);
    expect(routeLength(fixed, d, null)).toBeLessThan(routeLength(crossed, d, null));
    expect(fixed).toEqual([4, 3, 2, 1]); // Start → unten Mitte → rechts unten → rechts oben → links oben
  });

  it("berücksichtigt ein festes Ziel (Rückfahrt)", () => {
    // Start 0, Ziel bei 10: Besuche 2, 8, 4 → aufsteigend
    const xs = [0, 8, 2, 4, 10];
    const order = optimizeOrder(3, line(xs), 4);
    expect(order).toEqual([1, 2, 0]);
  });

  it("realistische Koordinaten: kürzer als die Uhrzeit-Reihenfolge", () => {
    const start: LatLon = { lat: 52.4, lon: 13.06 }; // Potsdam
    const visits: LatLon[] = [
      { lat: 52.52, lon: 13.4 }, // Berlin Mitte
      { lat: 52.41, lon: 13.1 }, // nahe Potsdam
      { lat: 52.45, lon: 13.25 }, // dazwischen
    ];
    const nodes = [start, ...visits];
    const d = (i: number, j: number) => haversineM(nodes[i], nodes[j]);
    const opt = optimizeOrder(3, d).map((i) => i + 1);
    expect(routeLength(opt, d, null)).toBeLessThan(routeLength([1, 2, 3], d, null));
    expect(opt).toEqual([2, 3, 1]);
  });

  it("leere/einzelne Listen", () => {
    expect(optimizeOrder(0, () => 0)).toEqual([]);
    expect(optimizeOrder(1, () => 0)).toEqual([0]);
  });

  it("Terminzeiten sind nur Warnungen (Reihenfolge und knappe Fahrzeit)", () => {
    const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 9, h - 1, m)); // Berlin = UTC+1
    const stops = [
      { label: "Hausbesuch K-2", startsAt: t(11), endsAt: t(11, 45) },
      { label: "Hausbesuch K-1", startsAt: t(10), endsAt: t(10, 45) },
      { label: "Hausbesuch K-3", startsAt: t(11, 0), endsAt: t(12) },
    ];
    const w = timeWarnings(stops, [600, 900, 1200]);
    expect(w[0]).toMatch(/K-1 \(10:00\) liegt in dieser Reihenfolge nach Hausbesuch K-2 \(11:00\)/);
    expect(w.some((x) => x.startsWith("Knapp: 20 min"))).toBe(true);
    expect(timeWarnings(stops.slice(1, 2), [600])).toEqual([]);
  });
});
