import { deflateSync, crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_SIGNATURE_BYTES, checkSignaturePng } from "./signature";

function png(width: number, height: number, extra = 0): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height + extra))), chunk("IEND", Buffer.alloc(0))]);
}

describe("Unterschrift (PNG) prüfen", () => {
  it("gültiges PNG mit Abmessungen", () => {
    expect(checkSignaturePng(png(900, 300))).toEqual({ ok: true, width: 900, height: 300 });
  });
  it("kein PNG, leere Datei, zu groß, unsinnige Abmessungen", () => {
    expect(checkSignaturePng(new Uint8Array())).toMatchObject({ ok: false });
    expect(checkSignaturePng(Buffer.from("<svg onload=alert(1)>"))).toMatchObject({ ok: false, error: expect.stringMatching(/kein gültiges Bild/) });
    expect(checkSignaturePng(new Uint8Array(MAX_SIGNATURE_BYTES + 1))).toMatchObject({ ok: false, error: expect.stringMatching(/zu groß/) });
    expect(checkSignaturePng(png(10, 10))).toMatchObject({ ok: false, error: expect.stringMatching(/Abmessungen/) });
    expect(checkSignaturePng(png(5000, 300))).toMatchObject({ ok: false, error: expect.stringMatching(/Abmessungen/) });
    const broken = png(900, 300);
    broken[12] = 0x58; // Chunk-Typ ≠ IHDR
    expect(checkSignaturePng(broken)).toMatchObject({ ok: false });
  });
});
