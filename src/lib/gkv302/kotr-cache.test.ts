import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ausLatin1 } from "./edifact";
import { parseKostentraegerdatei } from "./kostentraeger";
import { KotrCache } from "./kotr-cache";

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

  it("begrenzt nach Bytes der Eingaben (LRU), nicht nach Anzahl", () => {
    const c = new KotrCache(3 * roh.length);
    for (const k of ["a", "b", "c"]) c.hole(k, roh.length, () => parseKostentraegerdatei(roh));
    c.hole("a", roh.length, () => parseKostentraegerdatei(roh)); // a zuletzt benutzt
    c.hole("d", roh.length, () => parseKostentraegerdatei(roh));
    expect(c.schluessel()).toEqual(["c", "a", "d"]);
    expect(c.bytes()).toBe(3 * roh.length);
    // zu groß für den Cache: wird geliefert, aber nicht gespeichert
    c.hole("riesig", 10 * roh.length, () => parseKostentraegerdatei(roh));
    expect(c.schluessel()).not.toContain("riesig");
  });
});
