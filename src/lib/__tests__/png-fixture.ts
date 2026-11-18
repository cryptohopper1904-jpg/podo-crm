/** Test-PNGs (erfunden): gültige Unterschrift 900×300 RGBA bzw. gezielt fehlerhafte Varianten */
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer, badCrc = false) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(td) ^ (badCrc ? 1 : 0)) >>> 0);
  return Buffer.concat([len, td, crc]);
};

export function testPng(
  o: {
    width?: number;
    height?: number;
    bitDepth?: number;
    colorType?: number;
    extraChunks?: [string, Buffer][];
    rawBytes?: number;
    /** Bytes nach dem Ende des zlib-Stroms (im IDAT) */
    trailing?: Buffer;
    /** falsche CRC in diesem Chunk */
    badCrc?: "IHDR" | "IDAT" | "IEND";
    /** Filter-Byte der ersten Zeile (gültig 0–4) */
    filter?: number;
    /** IDAT auf zwei Chunks verteilen */
    splitIdat?: boolean;
  } = {},
): Buffer {
  const width = o.width ?? 900;
  const height = o.height ?? 300;
  const bitDepth = o.bitDepth ?? 8;
  const colorType = o.colorType ?? 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const bpp = (colorType === 6 ? 4 : colorType === 2 ? 3 : 1) * (bitDepth / 8);
  const raw = Buffer.alloc(o.rawBytes ?? (width * bpp + 1) * height, 0);
  // ein waagrechter Strich (schwarz, deckend) in Zeile 150
  if (colorType === 6 && bitDepth === 8 && raw.length >= (width * 4 + 1) * 151) for (let x = 50; x < width - 50; x++) raw[150 * (width * 4 + 1) + 1 + x * 4 + 3] = 255;
  if (o.filter !== undefined && raw.length) raw[0] = o.filter;
  const z = Buffer.concat([deflateSync(raw), o.trailing ?? Buffer.alloc(0)]);
  const half = Math.floor(z.length / 2);
  const idat = o.splitIdat ? [chunk("IDAT", z.subarray(0, half)), chunk("IDAT", z.subarray(half))] : [chunk("IDAT", z, o.badCrc === "IDAT")];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr, o.badCrc === "IHDR"),
    ...(o.extraChunks ?? []).map(([t, d]) => chunk(t, d)),
    ...idat,
    chunk("IEND", Buffer.alloc(0), o.badCrc === "IEND"),
  ]);
}

export const testPngDataUrl = (o?: Parameters<typeof testPng>[0]) => `data:image/png;base64,${testPng(o).toString("base64")}`;
