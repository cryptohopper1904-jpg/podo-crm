import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
