/**
 * Einfache Drosselung im Prozessspeicher (gleitendes Fenster). Für mehrere App-Instanzen
 * wäre ein gemeinsamer Speicher (Redis) nötig – für eine Praxis-Instanz ausreichend.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; maxKeys?: number }) {
  const hits = new Map<string, number[]>();
  const maxKeys = opts.maxKeys ?? 10_000;
  return {
    /** true = Limit überschritten (Anfrage ablehnen). Zählt den Aufruf mit. */
    limited(key: string, now = Date.now()): boolean {
      if (hits.size > maxKeys / 2) for (const [k, v] of hits) if (!v.some((t) => now - t < opts.windowMs)) hits.delete(k);
      if (hits.size > maxKeys) hits.clear();
      const list = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
      list.push(now);
      hits.set(key, list);
      return list.length > opts.max;
    },
    /** true = Limit bereits erreicht (ohne mitzuzählen). */
    exceeded(key: string, now = Date.now()): boolean {
      return (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs).length >= opts.max;
    },
    reset() {
      hits.clear();
    },
  };
}
