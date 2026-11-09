/**
 * Welche Anfragen im Support-Modus als „support.view“ ins Audit-Log der Praxis gehören.
 *
 * - Schreibende Anfragen: immer (ohne Entprellung).
 * - Alle übrigen Anfragen – Seiten (Dokument-, RSC-Navigation und Router-Prefetch) sowie Daten-Downloads
 *   unter /api (Fotos, PDFs, Kundenexport): ja, derselbe Pfad für dieselbe Freigabe höchstens einmal je 60 s.
 * - Es gibt bewusst KEINE Ausnahme nach Anfrage-Headern (`purpose`, `sec-purpose`, `next-router-prefetch`,
 *   `rsc`): Diese Header setzt der Client frei – eine Ausnahme ließe sich zum Abschalten des Audits
 *   missbrauchen (Gesamt-Review H6). Ein Prefetch erzeugt schlimmstenfalls einen zusätzlichen Eintrag.
 * Die Entprellung liegt im Prozessspeicher (LRU, begrenzte Größe) – bei mehreren Instanzen schlimmstenfalls
 * ein Eintrag je Instanz, nie ein fehlender.
 */
export const SUPPORT_VIEW_DEDUP_MS = 60_000;

export type SupportRequest = {
  mutating: boolean;
  path: string | null;
};

export function createSupportViewLog(opts: { windowMs?: number; maxKeys?: number } = {}) {
  const windowMs = opts.windowMs ?? SUPPORT_VIEW_DEDUP_MS;
  const maxKeys = opts.maxKeys ?? 5_000;
  const seen = new Map<string, number>();
  return {
    /** true = protokollieren. Merkt sich den Aufruf (nur wenn protokolliert wird). */
    shouldLog(grantId: string, req: SupportRequest, now = Date.now()): boolean {
      if (req.mutating) return true;
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
