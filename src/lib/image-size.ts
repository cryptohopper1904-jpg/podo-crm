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

/**
 * Vollständige, unbeschädigte Dateistruktur? Schützt den PDF-Baustein (pdf-lib), der bei abgeschnittenen
 * PNG-Dateien in eine Endlosschleife gerät. PNG: Signatur, IHDR zuerst, alle Blöcke in den Grenzen mit
 * korrekter Prüfsumme, mindestens ein IDAT, IEND am Ende. JPEG: SOI am Anfang, EOI am Ende, Maße lesbar.
 */
export function imageStructureOk(buf: Uint8Array, mime: string): boolean {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (mime === "image/png") {
    if (b.length < 8 + 25 + 12 || !b.subarray(0, 8).equals(PNG_SIG)) return false;
    let i = 8;
    let first = true;
    let idat = false;
    while (i + 12 <= b.length) {
      const len = b.readUInt32BE(i);
      const type = b.subarray(i + 4, i + 8).toString("latin1");
      if (len > b.length - i - 12 || !/^[A-Za-z]{4}$/.test(type)) return false;
      if (first && (type !== "IHDR" || len !== 13)) return false;
      first = false;
      if (b.readUInt32BE(i + 8 + len) !== crc32(b.subarray(i + 4, i + 8 + len))) return false;
      if (type === "IDAT") idat = true;
      i += 12 + len;
      if (type === "IEND") return idat && i === b.length;
    }
    return false;
  }
  if (mime === "image/jpeg") {
    return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 && imageSize(b, mime) !== null;
  }
  return false;
}
