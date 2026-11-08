/**
 * Welche Anfragen im Support-Modus als „support.view“ ins Audit-Log der Praxis gehören.
 *
 * - Schreibende Anfragen: immer (ohne Entprellung).
 * - Prefetch des Next-Routers (Header `next-router-prefetch`/`purpose: prefetch`): nein – das ist keine
 *   Ansicht; der Prefetch liefert für dynamische Seiten nur die Ladehülle.
 * - Seiten (Dokument- und RSC-Navigation) sowie Daten-Downloads unter /api (Fotos, PDFs, Kundenexport):
 *   ja, aber derselbe Pfad für dieselbe Freigabe höchstens einmal je 60 s.
 * Die Entprellung liegt im Prozessspeicher (LRU, begrenzte Größe) – bei mehreren Instanzen schlimmstenfalls
 * ein Eintrag je Instanz, nie ein fehlender.
 */
export const SUPPORT_VIEW_DEDUP_MS = 60_000;

export type SupportRequest = {
  mutating: boolean;
  path: string | null;
  /** Router-Prefetch (next-router-prefetch: 1 bzw. purpose/sec-purpose: prefetch) */
  prefetch: boolean;
};

export function createSupportViewLog(opts: { windowMs?: number; maxKeys?: number } = {}) {
  const windowMs = opts.windowMs ?? SUPPORT_VIEW_DEDUP_MS;
  const maxKeys = opts.maxKeys ?? 5_000;
  const seen = new Map<string, number>();
  return {
    /** true = protokollieren. Merkt sich den Aufruf (nur wenn protokolliert wird). */
    shouldLog(grantId: string, req: SupportRequest, now = Date.now()): boolean {
      if (req.mutating) return true;
      if (req.prefetch) return false;
      const key = `${grantId}\u0000${req.path ?? ""}`;
      const last = seen.get(key);
      if (last !== undefined && now - last < windowMs) return false;
      seen.delete(key); // ans Ende (LRU = Einfügereihenfolge)
      seen.set(key, now);
      while (seen.size > maxKeys) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      return true;
    },
    size: () => seen.size,
  };
}

/** Prefetch-Erkennung aus den Anfrage-Headern. */
export function isPrefetch(h: { get(name: string): string | null }): boolean {
  return h.get("next-router-prefetch") === "1" || /prefetch/i.test(h.get("purpose") ?? "") || /prefetch/i.test(h.get("sec-purpose") ?? "");
}
