import { inflateSync } from "node:zlib";

/** Bildmaße aus dem Dateikopf (PNG: IHDR, JPEG: SOF-Marker) – ohne Bildbibliothek. null = nicht lesbar. */
export function imageSize(buf: Uint8Array, mime: string): { width: number; height: number } | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (mime === "image/png") {
    if (b.length < 24 || b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
    return positive(b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // SOF0–SOF15 außer DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return positive(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

const positive = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (PNG/zlib) – Tabelle einmalig */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Kanäle je Farbtyp und erlaubte Bittiefen (PNG-Spezifikation; 16 Bit bewusst nicht – unnötig groß für Logos) */
const PNG_COLOR: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8] },
  2: { channels: 3, depths: [8] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8] },
  6: { channels: 4, depths: [8] },
};
/** Obergrenze der entpackten Bilddaten (Schutz vor Speicher-/CPU-Last) */
const PNG_MAX_RAW = 32 * 1024 * 1024;

/**
 * Vollständige, unbeschädigte Datei? Schützt den PDF-Baustein (pdf-lib), der bei abgeschnittenen oder präparierten
 * PNG-Dateien in eine Endlosschleife gerät (blockiert den ganzen Server). PNG: Signatur, IHDR zuerst (Farbtyp,
 * Bittiefe, kein Interlacing), alle Blöcke in den Grenzen mit korrekter Prüfsumme, PLTE bei Palettenbildern,
 * IEND am Ende – und die IDAT-Daten müssen sich mit zlib vollständig auf exakt die erwartete Länge entpacken lassen.
 * JPEG: SOI am Anfang, EOI am Ende, Maße lesbar.
 */
export function imageStructureOk(buf: Uint8Array, mime: string): boolean {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (mime === "image/png") {
    if (b.length < 8 + 25 + 12 || !b.subarray(0, 8).equals(PNG_SIG)) return false;
    let i = 8;
    let first = true;
    let plte = false;
    const idat: Buffer[] = [];
    let hdr: { w: number; h: number; depth: number; color: number } | null = null;
    while (i + 12 <= b.length) {
      const len = b.readUInt32BE(i);
      const type = b.subarray(i + 4, i + 8).toString("latin1");
      if (len > b.length - i - 12 || !/^[A-Za-z]{4}$/.test(type)) return false;
      if (first && (type !== "IHDR" || len !== 13)) return false;
      first = false;
      const data = b.subarray(i + 8, i + 8 + len);
      if (b.readUInt32BE(i + 8 + len) !== crc32(b.subarray(i + 4, i + 8 + len))) return false;
      if (type === "IHDR") {
        const [depth, color, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
        const spec = PNG_COLOR[color];
        if (!spec || !spec.depths.includes(depth) || compression !== 0 || filter !== 0 || interlace !== 0) return false;
        hdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth, color };
        if (!hdr.w || !hdr.h) return false;
      }
      if (type === "PLTE") plte = true;
      if (type === "IDAT") idat.push(data);
      i += 12 + len;
      if (type === "IEND") {
        if (!hdr || !idat.length || i !== b.length || (hdr.color === 3 && !plte)) return false;
        const bitsPerPixel = PNG_COLOR[hdr.color].channels * hdr.depth;
        const expected = (Math.ceil((hdr.w * bitsPerPixel) / 8) + 1) * hdr.h; // +1 Filterbyte je Zeile
        if (expected > PNG_MAX_RAW) return false;
        try {
          const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
          return raw.length === expected;
        } catch {
          return false; // abgeschnitten, beschädigt oder zu groß
        }
      }
    }
    return false;
  }
  if (mime === "image/jpeg") {
    return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 && imageSize(b, mime) !== null;
  }
  return false;
}
