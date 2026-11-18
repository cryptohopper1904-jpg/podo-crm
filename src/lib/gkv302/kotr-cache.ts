/**
 * Cache zerlegter Kostenträgerdateien je Prüfsumme (Review-Runden 3 und 4, AppSec): begrenzt nach dem GESCHÄTZTEN Heap
 * der zerlegten Objekte (Eingabe-Bytes × 10 – gemessen sind die Objekte 5- bis 9-mal so groß wie die Eingabe), LRU.
 * Einträge werden vor dem Speichern tief kopiert (`structuredClone`: Zeichenketten werden flache Kopien, kein Ausschnitt
 * hält die ganze Eingabe fest) und tief eingefroren – das Objekt wird zwischen Praxen geteilt (gleiche öffentliche
 * Datei), niemand darf es verändern. Nur Prozessspeicher, keine Patientendaten (Kostenträgerdateien sind öffentlich).
 */
import type { Kostentraegerdatei } from "./kostentraeger";

/** Budget für den geschätzten Heap aller Einträge */
export const KOTR_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** geschätzter Heap je Byte Eingabe (Messung Review-Runde 4: Faktor 5–9, mit Spielraum) */
export const KOTR_CACHE_GEWICHT_JE_BYTE = 10;

/** rekursiv schreibgeschützt (Typ zum eingefrorenen Cache-Objekt) */
export type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * Friert ein Objekt mit allen verschachtelten Objekten/Arrays ein. Auch bereits eingefrorene Teilobjekte werden
 * durchlaufen (ein eingefrorenes Array kann noch veränderliche Elemente enthalten); `gesehen` verhindert Endlosschleifen
 * bei Zyklen und doppelte Arbeit bei geteilten Teilobjekten.
 */
export function tiefEinfrieren<T>(o: T, gesehen = new WeakSet<object>()): DeepReadonly<T> {
  if (o && typeof o === "object" && !gesehen.has(o)) {
    gesehen.add(o);
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) tiefEinfrieren(v, gesehen);
  }
  return o as DeepReadonly<T>;
}

export class KotrCache {
  private readonly eintraege = new Map<string, { datei: DeepReadonly<Kostentraegerdatei>; gewicht: number }>();
  private summe = 0;
  constructor(private readonly maxGewicht = KOTR_CACHE_MAX_BYTES) {}

  /** liefert die (kopierte, eingefrorene) Datei aus dem Cache oder lädt sie; `bytes` = Größe der Eingabe */
  hole(sha256: string, bytes: number, laden: () => Kostentraegerdatei): DeepReadonly<Kostentraegerdatei> {
    const treffer = this.eintraege.get(sha256);
    if (treffer) {
      this.eintraege.delete(sha256);
      this.eintraege.set(sha256, treffer);
      return treffer.datei;
    }
    // flache Kopie aller Zeichenketten: Ausschnitte (slice) des Zerlegers würden sonst die ganze Eingabe festhalten
    const datei = tiefEinfrieren(structuredClone(laden()));
    const gewicht = bytes * KOTR_CACHE_GEWICHT_JE_BYTE;
    if (gewicht > this.maxGewicht) return datei;
    this.eintraege.set(sha256, { datei, gewicht });
    this.summe += gewicht;
    while (this.summe > this.maxGewicht) {
      const [k, e] = this.eintraege.entries().next().value!;
      this.eintraege.delete(k);
      this.summe -= e.gewicht;
    }
    return datei;
  }

  schluessel(): string[] {
    return [...this.eintraege.keys()];
  }

  /** Summe der Gewichte (geschätzter Heap) */
  bytes(): number {
    return this.summe;
  }
}
