/**
 * Prüfung der Unterschrift-PNG (nur Server, nutzt node:zlib): genau das Format der Zeichenfläche (SignatureField) –
 * 900×300, 8 Bit RGBA, ohne Interlace, nur IHDR/IDAT/IEND (plus kleine, harmlose Farbraum-Chunks, die manche Browser
 * schreiben), keine APNG-Animation. IDAT wird probeweise mit Obergrenze entpackt (Schutz vor Dekompressionsbomben,
 * die später beim Einbetten ins PDF Speicher fressen würden). Die Bytes stammen aus dem Browser und sind nicht
 * vertrauenswürdig.
 */
import { inflateSync } from "node:zlib";
import { MAX_SIGNATURE_BYTES, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "./signature";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Farbraum-/Auflösungsangaben fester Größe (Chrome/Firefox/Safari) – alles andere (tEXt, iCCP, acTL, fdAT …) wird abgelehnt */
const HARMLESS = new Set(["sRGB", "gAMA", "pHYs", "cHRM"]);
const BAD = "Die Unterschrift ist kein gültiges Bild (PNG).";

export function checkSignaturePng(bytes: Uint8Array): { ok: true; width: number; height: number } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "Unterschrift fehlt." };
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, error: "Die Unterschrift ist zu groß – bitte löschen und erneut unterschreiben." };
  if (bytes.length < 45 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) return { ok: false, error: BAD };
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let first = true;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) return { ok: false, error: BAD };
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (first) {
      if (type !== "IHDR" || len !== 13) return { ok: false, error: BAD };
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // Bittiefe 8, Farbtyp 6 (RGBA), Kompression 0, Filter 0, kein Interlace
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return { ok: false, error: "Die Unterschrift hat ein ungültiges Bildformat." };
      if (width !== SIGNATURE_WIDTH || height !== SIGNATURE_HEIGHT) return { ok: false, error: "Die Unterschrift hat ungültige Abmessungen." };
      first = false;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      ended = true;
      pos = end;
      break;
    } else if (!(HARMLESS.has(type) && len <= 32)) return { ok: false, error: BAD };
    pos = end;
  }
  if (first || !ended || pos !== buf.length || !idat.length) return { ok: false, error: BAD };
  const expected = (width * 4 + 1) * height;
  try {
    const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
    if (raw.length !== expected) return { ok: false, error: BAD };
  } catch {
    return { ok: false, error: BAD };
  }
  return { ok: true, width, height };
}
