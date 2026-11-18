import { readFileSync } from "node:fs";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ausLatin1 } from "./edifact";
import { parseKostentraegerdatei, schreibeKostentraegerdatei, type Kostentraegerdatei, type KotrInstitution } from "./kostentraeger";
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

  it("begrenzt nach geschätztem Heap (Struktur-Gewicht, mindestens Eingabe-Bytes × 10; LRU), nicht nach Anzahl", () => {
    expect(KOTR_CACHE_GEWICHT_JE_BYTE).toBe(10);
    // Gewicht eines Eintrags (Struktur-Gewicht, mindestens Eingabe × 10)
    const probe = new KotrCache(Number.MAX_SAFE_INTEGER);
    probe.hole("p", roh.length, () => parseKostentraegerdatei(roh));
    const eins = probe.bytes();
    expect(eins).toBeGreaterThanOrEqual(roh.length * KOTR_CACHE_GEWICHT_JE_BYTE);
    const c = new KotrCache(3 * eins);
    for (const k of ["a", "b", "c"]) c.hole(k, roh.length, () => parseKostentraegerdatei(roh));
    c.hole("a", roh.length, () => parseKostentraegerdatei(roh)); // a zuletzt benutzt
    c.hole("d", roh.length, () => parseKostentraegerdatei(roh));
    expect(c.schluessel()).toEqual(["c", "a", "d"]);
    expect(c.bytes()).toBe(3 * eins);
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
    // gehalten: Cache-Einträge (je nach Muster ≈ 4–32 × Eingabe, hier gültige VKG-Segmente) – mit GC gemessen; ohne GC großzügige Schwelle
    expect(gehalten).toBeLessThan((gc ? 48 : 250) * 1024 * 1024);
  });

  // Review-Runde 5 (AppSec B1''): Segmente ohne Datenelemente („UEM'“, „DFU'“, „ASP'“) kosten 4 Byte Eingabe, erzeugen aber
  // je ein Objekt mit 5–7 Eigenschaften. Nach reinem Eingabe-Gewicht (× 10) hielt ein voller Cache ~100 MB statt 32 MB.
  // Die Struktur wird hier so gebaut, wie der Zerleger sie bis Runde 4 aus diesen Mustern erzeugte (er lehnt sie seit
  // Runde 5 ab – das Gewicht muss aber unabhängig davon stimmen).
  const leereDatei = (v: number, uem: number, dfuJeUem: number, asp: number): { text: string; laden: () => Kostentraegerdatei } => {
    const segmente = ["UEM'", ...Array<string>(dfuJeUem).fill("DFU'")].join("");
    const text = `UNB+UNOC:3+990020026+999999999+261001:1200+${String(v).padStart(5, "0")}++GK05Q426KE0'UNH++KOTR'IDK+990000001'VDT+20260101'${"ASP'".repeat(asp)}${segmente.repeat(uem)}UNT+1'UNZ+1+${v}'`;
    const laden = (): Kostentraegerdatei => ({
      absenderIk: "990020026", empfaengerIk: "999999999", erstellt: "261001:1200", dateinummer: String(v).padStart(5, "0"), dateiname: "GK05Q426KE0",
      institutionen: [{
        ik: "990000001", artDerInstitution: "", kurzbezeichnung: "", vknr: undefined, gueltigkeit: { ab: "2026-01-01", bis: undefined }, verarbeitungskennzeichen: "",
        verknuepfungen: [], name: [], anschriften: [],
        ansprechpartner: Array.from({ length: asp }, () => ({ lfdNr: "", telefon: undefined, fax: undefined, name: undefined, arbeitsgebiet: undefined })),
        uebermittlung: Array.from({ length: uem }, () => ({
          medium: "", parameter: "", zeichensatz: "", komprimierung: undefined,
          dfu: Array.from({ length: dfuJeUem }, () => ({ lfdNr: "", protokoll: "", benutzerkennung: undefined, von: undefined, bis: undefined, uebertragungstage: undefined, kommunikationskanal: "" })),
        })),
      }],
    });
    return { text, laden };
  };

  it.each([
    // Muster „uem_dfu“: 1 Institution, 39 990 × „UEM'DFU'“ (≈ 320 KB); Knoten: UEM + dfu-Array + DFU je Paar
    { muster: "uem_dfu", uem: 39_990, dfuJeUem: 1, asp: 0, knoten: 3 * 39_990 },
    // Muster „asp_uem“: 49 999 × „ASP'“ + 29 990 × „UEM'“ (≈ 320 KB); Knoten: ASP, UEM + dfu-Array
    { muster: "asp_uem", uem: 29_990, dfuJeUem: 0, asp: 49_999, knoten: 49_999 + 2 * 29_990 },
  ])("Gewicht aus der Struktur, nicht nur aus der Eingabe: $muster", ({ uem, dfuJeUem, asp, knoten }) => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as (() => void) | undefined;
    // einzelner Eintrag: Gewicht ≥ konservative Untergrenze (≥ 64 Byte je Objekt/Array in V8) und ≥ gemessenem Heap
    const einzeln = new KotrCache();
    const eins = leereDatei(1, uem, dfuJeUem, asp);
    expect(eins.text.length).toBeLessThan(330_000);
    gc?.();
    const vor1 = process.memoryUsage().heapUsed;
    einzeln.hole("e", eins.text.length, eins.laden);
    gc?.();
    const heap1 = process.memoryUsage().heapUsed - vor1;
    const gewicht = einzeln.bytes();
    expect(gewicht).toBeGreaterThanOrEqual(knoten * 64);
    expect(gewicht).toBeGreaterThan(eins.text.length * KOTR_CACHE_GEWICHT_JE_BYTE);
    if (gc) expect(gewicht).toBeGreaterThanOrEqual(heap1);

    // voller Cache (Budget 32 MB): Summe der Gewichte ≤ Budget, gehaltener Heap ≤ Summe der Gewichte
    const c = new KotrCache();
    gc?.();
    const vor = process.memoryUsage().heapUsed;
    for (let v = 1; v <= 12; v++) {
      const d = leereDatei(v, uem, dfuJeUem, asp);
      c.hole(`k${v}`, d.text.length, d.laden);
    }
    gc?.();
    const gehalten = process.memoryUsage().heapUsed - vor;
    expect(c.bytes()).toBeLessThanOrEqual(KOTR_CACHE_MAX_BYTES);
    expect(c.bytes()).toBeGreaterThanOrEqual(c.schluessel().length * knoten * 64);
    expect(gehalten).toBeLessThan((gc ? 1 : 3) * KOTR_CACHE_MAX_BYTES);
    if (gc) expect(gehalten).toBeLessThanOrEqual(c.bytes());
    expect(einzeln.schluessel()).toEqual(["e"]);
  });

  // Review-Runde 6 (AppSec/Code-Review H1): gültige Segmente mit vielen kurzen Werten – jede Zeichenkette hat in V8 einen
  // festen Kopf; ohne Pauschale je Zeichenkette lag die Schätzung nur 1,0- bis 1,07-mal über dem gemessenen Heap.
  it("Gewicht deckt kurze Zeichenketten mit Spielraum ab (gültiges „ASP+ab+cd+ef+gh+ij'“)", () => {
    // Gemessen (Node 22, `heapUsed` nach GC, voller Cache mit 14 verschiedenen Dateien dieses Musters): ≈ 215 Byte Heap
    // je ASP-Segment mit fünf 2-Zeichen-Werten. Das Gewicht muss mindestens 1,5-mal darüber liegen (Spielraum für andere
    // V8-Versionen). Feste Untergrenze statt Heap-Messung im Test, weil diese im Test-Worker nicht verlässlich ist.
    const z = (n: number): string => n.toString(36).padStart(2, "0").slice(-2);
    const anzahl = 29_000;
    const asp = Array.from({ length: anzahl }, (_, i) => `ASP+${z(i)}+${z(i + 1)}+${z(i + 2)}+${z(i + 3)}+${z(i + 4)}'`).join("");
    const text = `UNB+UNOC:3+990020026+999999999+261001:1200+00001++GK05Q426KE0'UNH++KOTR'IDK+990000001'VDT+20260101'${asp}UNT+${anzahl + 4}'UNZ+1+00001'`;
    const c = new KotrCache();
    c.hole("asp", text.length, () => parseKostentraegerdatei(text));
    expect(c.schluessel()).toEqual(["asp"]);
    expect(c.bytes()).toBeGreaterThan(text.length * KOTR_CACHE_GEWICHT_JE_BYTE);
    expect(c.bytes()).toBeGreaterThanOrEqual(anzahl * 215 * 1.5);
  });
});
