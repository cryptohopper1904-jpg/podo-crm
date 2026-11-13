import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crc32 as zlibCrc32, deflateSync } from "node:zlib";
import { imageSize, imageStructureOk } from "./image-size";

describe("imageSize", () => {
  it("liest PNG-Maße", () => {
    const png = readFileSync(path.join(__dirname, "../../docs/kunden/kiehne/logo-kiehne-zeichen.png"));
    expect(imageSize(png, "image/png")).toEqual({ width: 223, height: 364 });
  });
  it("liest JPEG-Maße (SOF0 nach APP0)", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 64, height: 32 });
  });
  it("null bei kaputten Dateien", () => {
    expect(imageSize(Buffer.from("nope"), "image/png")).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg")).toBeNull();
  });
  it("Dateistruktur: vollständige PNG ja, abgeschnittene/manipulierte nein", () => {
    const png = readFileSync(path.join(__dirname, "../../docs/kunden/kiehne/logo-kiehne-zeichen.png"));
    expect(imageStructureOk(png, "image/png")).toBe(true);
    expect(imageStructureOk(png.subarray(0, 60), "image/png")).toBe(false);
    expect(imageStructureOk(png.subarray(0, png.length - 1), "image/png")).toBe(false);
    expect(imageStructureOk(Buffer.concat([png, Buffer.from("x")]), "image/png")).toBe(false);
    const flipped = Buffer.from(png);
    flipped[200] ^= 0xff;
    expect(imageStructureOk(flipped, "image/png")).toBe(false);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
    expect(imageStructureOk(jpeg, "image/jpeg")).toBe(true);
    expect(imageStructureOk(jpeg.subarray(0, 18), "image/jpeg")).toBe(false);
  });
});

describe("präparierte PNGs (Server-Hänger in pdf-lib, Security-Review)", () => {
  // Hilfsfunktionen: PNG mit korrekten Prüfsummen aus Bausteinen bauen
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlibCrc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = (w: number, h: number, depth: number, color: number, interlace = 0) => {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(w, 0);
    d.writeUInt32BE(h, 4);
    d[8] = depth;
    d[9] = color;
    d[12] = interlace;
    return chunk("IHDR", d);
  };
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const raw = (w: number, h: number, bpp: number) => Buffer.alloc((w * bpp + 1) * h, 0x7f).fill(0, 0, 1);
  const png = (parts: Buffer[]) => Buffer.concat([SIG, ...parts, chunk("IEND", Buffer.alloc(0))]);

  it("gültiges RGBA-PNG wird angenommen", () => {
    const ok = png([ihdr(100, 100, 8, 6), chunk("IDAT", deflateSync(raw(100, 100, 4)))]);
    expect(imageStructureOk(ok, "image/png")).toBe(true);
  });
  it("abgeschnittener zlib-Strom (ließ pdf-lib endlos laufen) wird abgewiesen", () => {
    const full = deflateSync(raw(100, 100, 4));
    const bad = png([ihdr(100, 100, 8, 6), chunk("IDAT", full.subarray(0, Math.floor(full.length / 2)))]);
    expect(imageStructureOk(bad, "image/png")).toBe(false);
  });
  it("falsche Datenlänge, Interlacing, 16 Bit, Palette ohne PLTE, unbekannter Farbtyp werden abgewiesen", () => {
    expect(imageStructureOk(png([ihdr(100, 100, 8, 6), chunk("IDAT", deflateSync(raw(100, 99, 4)))]), "image/png")).toBe(false);
    expect(imageStructureOk(png([ihdr(10, 10, 8, 6, 1), chunk("IDAT", deflateSync(raw(10, 10, 4)))]), "image/png")).toBe(false);
    expect(imageStructureOk(png([ihdr(10, 10, 16, 6), chunk("IDAT", deflateSync(raw(10, 10, 8)))]), "image/png")).toBe(false);
    expect(imageStructureOk(png([ihdr(10, 10, 8, 3), chunk("IDAT", deflateSync(raw(10, 10, 1)))]), "image/png")).toBe(false);
    expect(imageStructureOk(png([ihdr(10, 10, 8, 5), chunk("IDAT", deflateSync(raw(10, 10, 4)))]), "image/png")).toBe(false);
  });
  it("Palettenbild mit PLTE wird angenommen", () => {
    const pal = png([ihdr(10, 10, 8, 3), chunk("PLTE", Buffer.alloc(3, 0xff)), chunk("IDAT", deflateSync(raw(10, 10, 1)))]);
    expect(imageStructureOk(pal, "image/png")).toBe(true);
  });
});
