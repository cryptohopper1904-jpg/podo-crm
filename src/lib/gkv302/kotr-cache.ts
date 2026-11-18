/**
 * Cache zerlegter Kostenträgerdateien je Prüfsumme (Review-Runde 3, AppSec): begrenzt nach der Summe der
 * Eingabegrößen (LRU), Objekte tief eingefroren – das Objekt wird zwischen Praxen geteilt (gleiche öffentliche Datei),
 * niemand darf es verändern. Nur Prozessspeicher, keine Patientendaten (Kostenträgerdateien sind öffentlich).
 */
import type { Kostentraegerdatei } from "./kostentraeger";

export const KOTR_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** friert ein Objekt mit allen verschachtelten Objekten/Arrays ein */
export function tiefEinfrieren<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) tiefEinfrieren(v);
  }
  return o;
}

export class KotrCache {
  private readonly eintraege = new Map<string, { datei: Kostentraegerdatei; bytes: number }>();
  private summe = 0;
  constructor(private readonly maxBytes = KOTR_CACHE_MAX_BYTES) {}

  /** liefert die (eingefrorene) Datei aus dem Cache oder lädt sie; `bytes` = Größe der Eingabe */
  hole(sha256: string, bytes: number, laden: () => Kostentraegerdatei): Kostentraegerdatei {
    const treffer = this.eintraege.get(sha256);
    if (treffer) {
      this.eintraege.delete(sha256);
      this.eintraege.set(sha256, treffer);
      return treffer.datei;
    }
    const datei = tiefEinfrieren(laden());
    if (bytes > this.maxBytes) return datei;
    this.eintraege.set(sha256, { datei, bytes });
    this.summe += bytes;
    while (this.summe > this.maxBytes) {
      const [k, e] = this.eintraege.entries().next().value!;
      this.eintraege.delete(k);
      this.summe -= e.bytes;
    }
    return datei;
  }

  schluessel(): string[] {
    return [...this.eintraege.keys()];
  }

  bytes(): number {
    return this.summe;
  }
}
