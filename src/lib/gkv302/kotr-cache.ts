/**
 * Cache zerlegter Kostenträgerdateien je Prüfsumme (Review-Runden 3–5, AppSec): begrenzt nach dem GESCHÄTZTEN Heap
 * der zerlegten Objekte, LRU. Die Eingabegröße allein taugt nicht als Maß: gemessen halten die Objekte 4- bis 32-mal so
 * viel Heap wie die Eingabe Bytes hat (kurze Segmente wie „UEM'“ erzeugen je ein Objekt mit 5–7 Eigenschaften). Das
 * Gewicht kommt daher aus der Struktur (Objekte, Felder, Zeichen; siehe `kotrGewicht`), mindestens Eingabe-Bytes × 10.
 * Einträge werden vor dem Speichern tief kopiert (`structuredClone`: Zeichenketten werden flache Kopien, kein Ausschnitt
 * hält die ganze Eingabe fest) und tief eingefroren – das Objekt wird zwischen Praxen geteilt (gleiche öffentliche
 * Datei), niemand darf es verändern. Nur Prozessspeicher, keine Patientendaten (Kostenträgerdateien sind öffentlich).
 */
import type { Kostentraegerdatei } from "./kostentraeger";

/** Budget für den geschätzten Heap aller Einträge */
export const KOTR_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Untergrenze des Gewichts je Byte Eingabe (Zeichenketten, Ausschnitte beim Zerlegen) */
export const KOTR_CACHE_GEWICHT_JE_BYTE = 10;
/**
 * Struktur-Gewichte (Review-Runden 5/6, gemessen mit V8/Node 22, `heapUsed` nach GC): ein eingefrorenes Objekt/Array
 * belegt 75–215 Byte samt Eigenschaften; jede Zeichenkette mit mehr als einem Zeichen hat zusätzlich einen festen Kopf
 * (≈ 24 Byte, Einzelzeichen legt V8 nur einmal an). Ohne die Pauschale je Zeichenkette lag die Schätzung bei vielen
 * kurzen Werten (z. B. „ASP+ab+cd+ef+gh+ij'“) nur 1,0- bis 1,07-mal über dem Heap; mit ihr bleibt Spielraum für andere
 * V8-Versionen und den Dictionary-Modus.
 */
export const KOTR_GEWICHT_JE_KNOTEN = 160;
export const KOTR_GEWICHT_JE_FELD = 8;
export const KOTR_GEWICHT_JE_ZEICHEN = 2;
export const KOTR_GEWICHT_JE_ZEICHENKETTE = 24;

/** beim Einfrieren gezählte Struktur: Objekte/Arrays, Eigenschaften/Elemente, Zeichen aller Zeichenketten, Zeichenketten mit mehr als einem Zeichen */
export interface KotrStruktur {
  knoten: number;
  felder: number;
  zeichen: number;
  zeichenketten: number;
}

/** geschätzter Heap einer eingefrorenen Datei: max(Eingabe × 10, Knoten × 160 + Felder × 8 + Zeichen × 2 + Zeichenketten × 24) */
export function kotrGewicht(bytes: number, s: KotrStruktur): number {
  return Math.max(
    bytes * KOTR_CACHE_GEWICHT_JE_BYTE,
    s.knoten * KOTR_GEWICHT_JE_KNOTEN + s.felder * KOTR_GEWICHT_JE_FELD + s.zeichen * KOTR_GEWICHT_JE_ZEICHEN + s.zeichenketten * KOTR_GEWICHT_JE_ZEICHENKETTE,
  );
}

/** rekursiv schreibgeschützt (Typ zum eingefrorenen Cache-Objekt) */
export type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/**
 * Friert ein Objekt mit allen verschachtelten Objekten/Arrays ein. Auch bereits eingefrorene Teilobjekte werden
 * durchlaufen (ein eingefrorenes Array kann noch veränderliche Elemente enthalten); `gesehen` verhindert Endlosschleifen
 * bei Zyklen und doppelte Arbeit bei geteilten Teilobjekten. Mit `zaehler` wird im selben Durchlauf die Struktur
 * gezählt (für das Cache-Gewicht, kein zweiter Durchlauf).
 */
export function tiefEinfrieren<T>(o: T, gesehen = new WeakSet<object>(), zaehler?: KotrStruktur): DeepReadonly<T> {
  if (o && typeof o === "object" && !gesehen.has(o)) {
    gesehen.add(o);
    Object.freeze(o);
    const werte = Object.values(o as Record<string, unknown>);
    if (zaehler) {
      zaehler.knoten++;
      zaehler.felder += werte.length;
    }
    for (const v of werte) {
      if (zaehler && typeof v === "string") {
        zaehler.zeichen += v.length;
        if (v.length > 1) zaehler.zeichenketten++;
      } else tiefEinfrieren(v, gesehen, zaehler);
    }
  }
  return o as DeepReadonly<T>;
}

export class KotrCache {
  private readonly eintraege = new Map<string, { datei: DeepReadonly<Kostentraegerdatei>; gewicht: number }>();
  private summe = 0;
  constructor(private readonly maxGewicht = KOTR_CACHE_MAX_BYTES) {}

  /** liefert die (kopierte, eingefrorene) Datei aus dem Cache oder lädt sie; `bytes` = Größe der Eingabe (Untergrenze des Gewichts) */
  hole(sha256: string, bytes: number, laden: () => Kostentraegerdatei): DeepReadonly<Kostentraegerdatei> {
    const treffer = this.eintraege.get(sha256);
    if (treffer) {
      this.eintraege.delete(sha256);
      this.eintraege.set(sha256, treffer);
      return treffer.datei;
    }
    // flache Kopie aller Zeichenketten: Ausschnitte (slice) des Zerlegers würden sonst die ganze Eingabe festhalten
    const struktur: KotrStruktur = { knoten: 0, felder: 0, zeichen: 0, zeichenketten: 0 };
    const datei = tiefEinfrieren(structuredClone(laden()), new WeakSet<object>(), struktur);
    const gewicht = kotrGewicht(bytes, struktur);
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
