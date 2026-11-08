/**
 * Einfache Drosselung im Prozessspeicher (gleitendes Fenster). Für mehrere App-Instanzen
 * wäre ein gemeinsamer Speicher (Redis) nötig – für eine Praxis-Instanz ausreichend.
 *
 * Speicherbegrenzung: LRU-Verdrängung (zuletzt benutzte Schlüssel bleiben), nie ein komplettes
 * Leeren – sonst könnte man mit vielen wechselnden Schlüsseln die Sperren aller anderen zurücksetzen.
 *
 * Anfragen ohne verlässliche IP: eigener Schlüssel `noip:<Hash des User-Agents>` (siehe clientKey)
 * mit halbem Limit – sie teilen sich weder einen gemeinsamen „unbekannt“-Eimer (der alle zugleich
 * sperren würde) noch bekommen sie das volle Kontingent.
 */
import { createHash } from "node:crypto";

export const NO_IP_PREFIX = "noip:";

export function createRateLimiter(opts: { windowMs: number; max: number; maxKeys?: number }) {
  const hits = new Map<string, number[]>();
  const maxKeys = opts.maxKeys ?? 10_000;
  const limitFor = (key: string) => (key.includes(NO_IP_PREFIX) ? Math.max(1, Math.floor(opts.max / 2)) : opts.max);
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
  return {
    /** true = Limit überschritten (Anfrage ablehnen). Zählt den Aufruf mit. */
    limited(key: string, now = Date.now()): boolean {
      const list = recent(key, now);
      list.push(now);
      // ans Ende verschieben (LRU-Reihenfolge = Einfügereihenfolge der Map)
      hits.delete(key);
      hits.set(key, list);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return list.length > limitFor(key);
    },
    /** true = Limit bereits erreicht (ohne mitzuzählen). */
    exceeded(key: string, now = Date.now()): boolean {
      return recent(key, now).length >= limitFor(key);
    },
    size: () => hits.size,
    reset() {
      hits.clear();
    },
  };
}

/** Schlüssel für die Drosselung: IP, sonst eigener (strengerer) Eimer je User-Agent. */
export function clientKey(meta: { ip: string | null; userAgent?: string | null }): string {
  if (meta.ip) return meta.ip;
  return `${NO_IP_PREFIX}${createHash("sha256").update(meta.userAgent ?? "").digest("hex").slice(0, 16)}`;
}
