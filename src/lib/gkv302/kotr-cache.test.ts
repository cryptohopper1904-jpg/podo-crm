import { readFileSync } from "node:fs";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ausLatin1 } from "./edifact";
import { parseKostentraegerdatei, schreibeKostentraegerdatei, type KotrInstitution } from "./kostentraeger";
import { KOTR_CACHE_GEWICHT_JE_BYTE, KOTR_CACHE_MAX_BYTES, KotrCache } from "./kotr-cache";

const roh = ausLatin1(new Uint8Array(readFileSync(path.join(__dirname, "fixtures", "kotr-test.ke0"))));

describe("Cache zerlegter Kostenträgerdateien (Review-Runde 3)", () => {
  it("liefert tief eingefrorene Objekte – keine Praxis kann das geteilte Objekt ändern", () => {
    const c = new KotrCache(1024 * 1024);
    let geladen = 0;
    const d = c.hole("a", roh.length, () => (geladen++, parseKostentraegerdatei(roh)));
    expect(c.hole("a", roh.length, () => (geladen++, parseKostentraegerdatei(roh)))).toBe(d);
    expect(geladen).toBe(1);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.institutionen)).toBe(true);
    expect(Object.isFrozen(d.institutionen[0].verknuepfungen[0])).toBe(true);
    expect(Object.isFrozen(d.institutionen[0].gueltigkeit)).toBe(true);
    expect(() => {
      "use strict";
      (d.institutionen as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("begrenzt nach geschätztem Heap (Eingabe-Bytes × 10, LRU), nicht nach Anzahl", () => {
    expect(KOTR_CACHE_GEWICHT_JE_BYTE).toBe(10);
    const c = new KotrCache(3 * roh.length * KOTR_CACHE_GEWICHT_JE_BYTE);
    for (const k of ["a", "b", "c"]) c.hole(k, roh.length, () => parseKostentraegerdatei(roh));
    c.hole("a", roh.length, () => parseKostentraegerdatei(roh)); // a zuletzt benutzt
    c.hole("d", roh.length, () => parseKostentraegerdatei(roh));
    expect(c.schluessel()).toEqual(["c", "a", "d"]);
    expect(c.bytes()).toBe(3 * roh.length * KOTR_CACHE_GEWICHT_JE_BYTE);
    // zu groß für den Cache: wird geliefert, aber nicht gespeichert
    c.hole("riesig", 4 * roh.length, () => parseKostentraegerdatei(roh));
    expect(c.schluessel()).not.toContain("riesig");
  });

  it("gehaltener Heap bei vollem Cache bleibt klein (Felder flach kopiert, keine Ausschnitte der Eingabe)", () => {
    // GC zur Laufzeit freischalten (Vitest-Worker laufen ohne --expose-gc), damit nur Gehaltenes gemessen wird
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as (() => void) | undefined;
    // ungünstige, aber gültige Datei: viele Institutionen mit vielen VKG und Feldern ≥ 13 Zeichen (≈ 0,9 MB)
    const datei = (v: number) =>
      schreibeKostentraegerdatei({
        absenderIk: "990020026", empfaengerIk: "999999999", erstellt: "261001:1200", dateinummer: String(v).padStart(5, "0"), dateiname: "GK05Q426KE0",
        institutionen: Array.from({ length: 300 }, (_, n): KotrInstitution => ({
          ik: String(990000000 + n), artDerInstitution: "99", kurzbezeichnung: `KASSE NUMMER ${n} ${v}`, gueltigkeit: { ab: "2026-01-01" }, verarbeitungskennzeichen: "01",
          verknuepfungen: Array.from({ length: 40 }, (_, k) => ({ art: "03", ik: String(990030000 + k), leistungserbringergruppe: "5", abrechnungsstelleIk: "990050012", artDerDatenlieferung: "07", uebermittlungsmedium: "1", bundesland: "11", kvBezirk: `KV-BEZIRK-${v}-${k}-LANG`, abrechnungscode: "71", tarifkennzeichen: "50000", unterverfahren: "1" })),
          name: [`Testkasse mit langem Namen ${n}`], anschriften: [], ansprechpartner: [], uebermittlung: [],
        })),
      });
    const c = new KotrCache();
    gc?.();
    const vor = process.memoryUsage().heapUsed;
    let laenge = 0;
    for (let v = 1; v <= 8; v++) {
      const text = datei(v);
      laenge = text.length;
      c.hole(`k${v}`, text.length, () => parseKostentraegerdatei(text));
    }
    gc?.();
    const gehalten = process.memoryUsage().heapUsed - vor;
    // Budget 32 MB geschätzter Heap (Eingabe × 10) → nur wenige solcher Dateien bleiben
    expect(laenge).toBeGreaterThan(800_000);
    expect(c.bytes()).toBeLessThanOrEqual(KOTR_CACHE_MAX_BYTES);
    expect(c.schluessel().length).toBe(Math.floor(KOTR_CACHE_MAX_BYTES / (laenge * KOTR_CACHE_GEWICHT_JE_BYTE)));
    // gehalten: Cache-Einträge (≈ 5–9 × Eingabe) – mit GC gemessen; ohne GC großzügige Schwelle
    expect(gehalten).toBeLessThan((gc ? 48 : 250) * 1024 * 1024);
  });
});
