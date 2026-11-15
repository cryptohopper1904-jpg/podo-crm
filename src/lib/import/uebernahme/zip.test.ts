import { describe, expect, it } from "vitest";
import { buildZip, safeEntryPath, unzip, ZipError } from "./zip";
import { collectFiles } from "./collect";

const dec = (d: Uint8Array) => new TextDecoder().decode(d);

/** Feld im zentralen Verzeichnis des ersten Eintrags überschreiben (für manipulierte Archive). */
function patchCentral(zip: Uint8Array, offset: number, value: number, bytes: 2 | 4) {
  const z = zip.slice();
  let p = -1;
  for (let i = 0; i < z.length - 4; i++) if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x01 && z[i + 3] === 0x02) { p = i; break; }
  const v = new DataView(z.buffer);
  if (bytes === 2) v.setUint16(p + offset, value, true);
  else v.setUint32(p + offset, value, true);
  return z;
}

describe("unzip (sicheres Entpacken)", () => {
  it("entpackt gepackte und ungepackte Einträge, ignoriert Ordner und __MACOSX", () => {
    const z = buildZip([
      { path: "a.csv", data: "x;y\n1;2" },
      { path: "ordner/b.csv", data: "b", store: true },
      { path: "__MACOSX/._a.csv", data: "müll" },
      { path: ".DS_Store", data: "müll" },
    ]);
    const out = unzip(z);
    expect(out.map((e) => e.path)).toEqual(["a.csv", "ordner/b.csv"]);
    expect(dec(out[0].data)).toBe("x;y\n1;2");
    expect(out[1].name).toBe("b.csv");
  });

  it("entpackt ein ZIP im ZIP (eine Ebene), lehnt zwei Ebenen ab", () => {
    const inner = buildZip([{ path: "patients_export_2026-01-15.csv", data: "a" }]);
    const outer = buildZip([{ path: "standort2.zip", data: inner }]);
    expect(unzip(outer).map((e) => e.path)).toEqual(["standort2.zip/patients_export_2026-01-15.csv"]);
    const deeper = buildZip([{ path: "aussen.zip", data: outer }]);
    expect(() => unzip(deeper)).toThrow(/eine Ebene/);
  });

  it.each(["../boese.csv", "a/../../boese.csv", "/etc/passwd", "C:/Windows/x.csv", "..\\..\\x.csv"])("lehnt Pfad „%s“ ab", (path) => {
    expect(() => unzip(buildZip([{ path, data: "x" }]))).toThrow(ZipError);
  });

  it("safeEntryPath normalisiert harmlose Pfade", () => {
    expect(safeEntryPath("./ordner//datei.csv")).toBe("ordner/datei.csv");
    expect(() => safeEntryPath("a\u0000b")).toThrow(ZipError);
  });

  it("begrenzt die Anzahl der Einträge", () => {
    const z = buildZip(Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.csv`, data: "x" })));
    expect(() => unzip(z, { limits: { maxEntries: 5 } })).toThrow(/Zu viele Dateien/);
  });

  it("Zip-Bomb: zu hohes Kompressionsverhältnis wird abgelehnt", () => {
    const z = buildZip([{ path: "bombe.csv", data: new Uint8Array(5 * 1024 * 1024) }]);
    expect(() => unzip(z)).toThrow(/ungewöhnlich stark gepackt/);
  });

  it("Zip-Bomb: falsch (zu klein) angegebene Größe wird beim Entpacken erkannt", () => {
    const z = buildZip([{ path: "a.csv", data: "x".repeat(10_000) }]);
    // entpackte Größe im Verzeichnis auf 100 Byte „lügen“ (Offset 24)
    expect(() => unzip(patchCentral(z, 24, 100, 4))).toThrow(ZipError);
  });

  it("begrenzt die Größe je Datei und insgesamt über mehrere Archive", () => {
    const z = buildZip([{ path: "a.csv", data: "y".repeat(2000) }]);
    expect(() => unzip(z, { limits: { maxEntryBytes: 1000 } })).toThrow(/zu groß/);
    const budget = { usedBytes: 0 };
    unzip(z, { limits: { maxTotalBytes: 3000 }, budget });
    expect(() => unzip(z, { limits: { maxTotalBytes: 3000 }, budget })).toThrow(/zusammen zu groß/);
  });

  it("falsche Prüfsumme, Verschlüsselung und beschädigte Archive werden abgelehnt", () => {
    const z = buildZip([{ path: "a.csv", data: "hallo" }]);
    expect(() => unzip(patchCentral(z, 16, 12345, 4))).toThrow(/Prüfsumme/);
    expect(() => unzip(patchCentral(z, 8, 0x801, 2))).toThrow(/verschlüsselt/);
    expect(() => unzip(z.subarray(0, z.length - 10))).toThrow(ZipError);
  });

  it("collectFiles: abgelehntes ZIP erscheint als Datei mit Grund, der Rest wird weiter geprüft", async () => {
    const bad = buildZip([{ path: "../x.csv", data: "x" }]);
    const files = await collectFiles([
      { name: "boese.zip", data: bad },
      { name: "leer.csv", data: new TextEncoder().encode("foo;bar\n1;2") },
    ]);
    expect(files[0]).toMatchObject({ name: "boese.zip", status: "rejected" });
    expect(files[0].note).toMatch(/außerhalb/);
    expect(files[1].status).toBe("rejected");
  });
});
