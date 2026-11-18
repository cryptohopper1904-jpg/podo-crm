/** Test-PNGs (erfunden): gültige Unterschrift 900×300 RGBA bzw. gezielt fehlerhafte Varianten */
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};

export function testPng(o: { width?: number; height?: number; bitDepth?: number; colorType?: number; extraChunks?: [string, Buffer][]; rawBytes?: number } = {}): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(o.extraChunks ?? []).map(([t, d]) => chunk(t, d)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const testPngDataUrl = (o?: Parameters<typeof testPng>[0]) => `data:image/png;base64,${testPng(o).toString("base64")}`;
