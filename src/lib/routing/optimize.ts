/**
 * Reihenfolge der Hausbesuche optimieren: Nearest-Neighbour als Start, danach 2-opt.
 * Feste Terminzeiten sind KEINE harte Bedingung – Abweichungen werden nur als Warnung gemeldet.
 * Reine Funktionen auf einer Distanzfunktion (z. B. Luftlinie), damit keine Daten das System verlassen.
 */
export type DistFn = (i: number, j: number) => number;

/**
 * Knoten: 0 = Start, 1..n = Besuche, optional n+1 = Ziel (Rückkehr). Ergebnis: Besuchsindizes 1..n in Reihenfolge.
 */
export function nearestNeighbour(n: number, dist: DistFn): number[] {
  const left = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const order: number[] = [];
  let cur = 0;
  while (left.size) {
    let best = -1;
    let bestD = Infinity;
    for (const j of left) {
      const d = dist(cur, j);
      if (d < bestD || (d === bestD && j < best)) {
        best = j;
        bestD = d;
      }
    }
    order.push(best);
    left.delete(best);
    cur = best;
  }
  return order;
}

/** Länge einer Route Start → order… → (optional) Ziel `end` */
export function routeLength(order: number[], dist: DistFn, end: number | null): number {
  let sum = 0;
  let cur = 0;
  for (const j of order) {
    sum += dist(cur, j);
    cur = j;
  }
  if (end !== null && order.length) sum += dist(cur, end);
  return sum;
}

/** 2-opt: kehrt Teilstücke um, solange die Gesamtstrecke kürzer wird (Start fix, Ziel fix oder offen). */
export function twoOpt(order: number[], dist: DistFn, end: number | null, maxRounds = 50): number[] {
  let best = [...order];
  let bestLen = routeLength(best, dist, end);
  for (let round = 0; round < maxRounds; round++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const len = routeLength(cand, dist, end);
        if (len < bestLen - 1e-9) {
          best = cand;
          bestLen = len;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/** Optimierte Reihenfolge der Besuche (Indizes 0..n-1 der übergebenen Besuche). */
export function optimizeOrder(n: number, dist: DistFn, end: number | null = null): number[] {
  if (n <= 1) return n === 1 ? [0] : [];
  return twoOpt(nearestNeighbour(n, dist), dist, end).map((i) => i - 1);
}

export type TimedStop = { label: string; startsAt: Date; endsAt: Date };

/**
 * Warnungen zu festen Terminzeiten:
 *  - Reihenfolge widerspricht den Uhrzeiten (späterer Termin vor früherem)
 *  - Fahrzeit zum nächsten Termin länger als die Lücke zwischen Terminende und nächstem Beginn
 */
export function timeWarnings(stops: TimedStop[], legDurationsSec: (number | null)[]): string[] {
  const out: string[] = [];
  const hm = (d: Date) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(d);
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const cur = stops[i];
    if (cur.startsAt < prev.startsAt) {
      out.push(`${cur.label} (${hm(cur.startsAt)}) liegt in dieser Reihenfolge nach ${prev.label} (${hm(prev.startsAt)}) – Termin ggf. verschieben.`);
      continue;
    }
    const leg = legDurationsSec[i];
    if (leg !== null && leg !== undefined) {
      const gapSec = (cur.startsAt.getTime() - prev.endsAt.getTime()) / 1000;
      if (leg > gapSec) {
        out.push(`Knapp: ${Math.round(leg / 60)} min Fahrt von ${prev.label} zu ${cur.label}, aber nur ${Math.max(0, Math.round(gapSec / 60))} min Zeit.`);
      }
    }
  }
  return out;
}
