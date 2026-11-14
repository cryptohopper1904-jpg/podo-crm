/**
 * Wann lädt die Offline-Ersatzseite (src/app/offline/retry-button.tsx) die gewünschte Seite neu?
 *
 * Das „online“-Ereignis allein reicht nicht: Es kommt oft, bevor eine Anfrage wirklich durchgeht (WLAN verbunden,
 * aber noch ohne Internet; Funkzellenwechsel; in Playwright schaltet setOffline erst die Seite und danach den
 * Service Worker um). Lädt die Seite dann sofort neu, liefert der Service Worker wieder die Ersatzseite – und weil
 * kein zweites „online“ kommt, hing man bis zur nächsten 25-s-Prüfung fest.
 *
 * Deshalb: nach „online“ (und wenn die Ersatzseite bei bestehender Verbindung erscheint) den Server kurz hintereinander
 * prüfen (/api/health, mit wachsendem Abstand) und erst bei Antwort neu laden. Damit eine Seite, die trotz
 * erreichbarem Server immer wieder als Ersatzseite endet, nicht im Sekundentakt neu lädt, sind schnelle Neuladungen
 * begrenzt (QUICK_RELOADS je QUICK_WINDOW_MS); danach bleibt nur die normale Prüfung alle PROBE_MS.
 */

/** normale Prüfung, solange die Seite sichtbar ist */
export const PROBE_MS = 25_000;
/** Abstände der schnellen Prüfungen nach „online“ bzw. beim Erscheinen mit Verbindung */
export const QUICK_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000] as const;
export const QUICK_RELOADS = 3;
export const QUICK_WINDOW_MS = 60_000;

/** Abstand vor der n-ten schnellen Prüfung (0-basiert); null = keine weitere schnelle Prüfung */
export function quickProbeDelay(attempt: number): number | null {
  return attempt >= 0 && attempt < QUICK_DELAYS_MS.length ? QUICK_DELAYS_MS[attempt] : null;
}

/** Darf jetzt noch schnell neu geladen werden? `history`: Zeitpunkte bisheriger schneller Neuladungen (ms). */
export function mayQuickReload(history: readonly number[], now: number): boolean {
  return history.filter((t) => now - t < QUICK_WINDOW_MS).length < QUICK_RELOADS;
}

/** Verlauf aus dem Sitzungsspeicher lesen (fehlerfest) und um `now` ergänzt zurückgeben */
export function parseReloadHistory(raw: string | null, now: number): number[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((t): t is number => typeof t === "number" && now - t < QUICK_WINDOW_MS) : [];
  } catch {
    return [];
  }
}
