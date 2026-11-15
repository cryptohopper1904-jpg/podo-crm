/**
 * Sicheres Entpacken von ZIP-Archiven für den Übernahme-Assistenten – nur im Arbeitsspeicher, nie auf die Platte.
 *
 * Schutz gegen präparierte Archive:
 *  - Größen- und Dateizahl-Grenzen (je Eintrag, gesamt über alle Archive eines Uploads, Anzahl Einträge)
 *  - Zip-Bomb: Entpacken mit harter Ausgabegrenze (zlib maxOutputLength), Kompressionsverhältnis begrenzt,
 *    angegebene Größe und CRC-32 müssen exakt zur entpackten Datei passen
 *  - Pfade: keine absoluten Pfade, keine „..“-Segmente, keine Laufwerksbuchstaben, keine Steuerzeichen
 *    (wir schreiben nichts auf die Platte, lehnen solche Archive aber trotzdem ab – sie sind nie ein echter Export)
 *  - Verschachtelte ZIPs nur eine Ebene tief; verschlüsselte Einträge, ZIP64 und unbekannte Kompression werden abgelehnt
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  /** höchstens so viele Einträge je Archiv */
  maxEntries: number;
  /** höchstens so groß (entpackt) je Datei */
  maxEntryBytes: number;
  /** höchstens so viel entpackt über alle Archive eines Uploads */
  maxTotalBytes: number;
  /** höchstes Verhältnis entpackt/gepackt (ab 1 MB entpackt geprüft) */
  maxRatio: number;
  /** wie tief ZIPs in ZIPs entpackt werden (1 = ZIP im ZIP erlaubt, darin kein weiteres) */
  maxDepth: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  // je Datei wie ein einzelner Upload (PDF/Excel); Textdateien prüft analyzeFile zusätzlich (10 MB)
  maxEntryBytes: 25 * 1024 * 1024,
  // entpackt über alle Archive eines Laufs (AppSec B1, Code-Review CR6)
  maxTotalBytes: 80 * 1024 * 1024,
  maxRatio: 200,
  maxDepth: 1,
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Pfad im Archiv (normalisiert mit „/“) */
  path: string;
  /** Dateiname ohne Ordner */
  name: string;
  data: Uint8Array;
}

/** Budget über alle Archive eines Uploads (Gesamtgröße entpackt). */
export interface ZipBudget {
  usedBytes: number;
}

export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05) && (data[3] === 0x04 || data[3] === 0x06);
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

/** Prüft einen Pfad im Archiv; liefert den normalisierten Pfad oder wirft. */
export function safeEntryPath(raw: string): string {
  if (!raw || raw.length > 512) throw new ZipError("Ungültiger Dateiname im ZIP.");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ZipError("Ungültiger Dateiname im ZIP (Steuerzeichen).");
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) throw new ZipError(`Unzulässiger Pfad im ZIP: „${raw}“ (absoluter Pfad).`);
  const parts = p.split("/");
  if (parts.some((s) => s === "..")) throw new ZipError(`Unzulässiger Pfad im ZIP: „${raw}“ (verweist außerhalb des Archivs).`);
  return parts.filter((s) => s !== "" && s !== ".").join("/") + (p.endsWith("/") ? "/" : "");
}

function findEocd(b: Uint8Array): number {
  const min = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

/** Ordner, Mac-Ressourcen und versteckte Dateien sind kein Inhalt. */
function ignored(path: string): boolean {
  if (path.endsWith("/")) return true;
  const segs = path.split("/");
  return segs.includes("__MACOSX") || segs[segs.length - 1].startsWith(".");
}

/**
 * Entpackt ein ZIP vollständig in den Speicher. `depth` = aktuelle Verschachtelungstiefe (0 = hochgeladene Datei).
 * Verschachtelte ZIPs werden bis `limits.maxDepth` mit entpackt (ihr Inhalt erscheint mit Pfad „innen.zip/…“).
 */
export function unzip(data: Uint8Array, opts: { limits?: Partial<ZipLimits>; budget?: ZipBudget; depth?: number } = {}): ZipEntry[] {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...opts.limits };
  const budget = opts.budget ?? { usedBytes: 0 };
  const depth = opts.depth ?? 0;
  const b = data;
  const eocd = findEocd(b);
  if (eocd < 0) throw new ZipError("Die ZIP-Datei ist beschädigt oder unvollständig.");
  const total = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64-Archive werden nicht unterstützt – bitte kleinere Exporte (z. B. je Jahr) hochladen.");
  if (total > limits.maxEntries) throw new ZipError(`Zu viele Dateien im ZIP (${total}, erlaubt sind ${limits.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw new ZipError("Die ZIP-Datei ist beschädigt (Inhaltsverzeichnis).");

  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new ZipError("Die ZIP-Datei ist beschädigt (Eintrag).");
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOffset = u32(b, p + 42);
    if (p + 46 + nameLen > b.length) throw new ZipError("Die ZIP-Datei ist beschädigt (Dateiname).");
    const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
    const rawName = flags & 0x800 ? new TextDecoder("utf-8").decode(nameBytes) : new TextDecoder("latin1").decode(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;

    const path = safeEntryPath(rawName);
    if (ignored(path)) continue;
    if (flags & 0x1) throw new ZipError(`„${path}“ ist verschlüsselt – bitte ohne Passwort exportieren.`);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64-Archive werden nicht unterstützt.");
    if (method !== 0 && method !== 8) throw new ZipError(`„${path}“ ist mit einem nicht unterstützten Verfahren gepackt.`);
    if (size > limits.maxEntryBytes) throw new ZipError(`„${path}“ ist entpackt zu groß (max. ${Math.round(limits.maxEntryBytes / 1024 / 1024)} MB).`);
    if (size > 1024 * 1024 && compSize > 0 && size / compSize > limits.maxRatio) throw new ZipError(`„${path}“ ist ungewöhnlich stark gepackt – Verdacht auf ein manipuliertes Archiv.`);
    if (budget.usedBytes + size > limits.maxTotalBytes) throw new ZipError(`Die ZIP-Inhalte sind zusammen zu groß (max. ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB entpackt).`);

    if (localOffset + 30 > b.length || u32(b, localOffset) !== 0x04034b50) throw new ZipError("Die ZIP-Datei ist beschädigt (lokaler Kopf).");
    const start = localOffset + 30 + u16(b, localOffset + 26) + u16(b, localOffset + 28);
    if (start + compSize > b.length) throw new ZipError("Die ZIP-Datei ist beschädigt (Daten abgeschnitten).");
    const packed = b.subarray(start, start + compSize);
    let content: Uint8Array;
    if (method === 0) {
      if (compSize !== size) throw new ZipError("Die ZIP-Datei ist beschädigt (Größe).");
      content = packed;
    } else {
      try {
        // harte Grenze: nie mehr als die angegebene Größe (+1, um Lügen zu erkennen) entpacken
        content = inflateRawSync(packed, { maxOutputLength: Math.max(1, size + 1) });
      } catch {
        throw new ZipError(`„${path}“ ließ sich nicht entpacken (beschädigt oder größer als angegeben).`);
      }
    }
    if (content.length !== size) throw new ZipError(`„${path}“: angegebene und tatsächliche Größe weichen ab – Archiv abgelehnt.`);
    if ((crc32(content) >>> 0) !== crc) throw new ZipError(`„${path}“: Prüfsumme falsch – Archiv beschädigt.`);
    budget.usedBytes += size;

    if (isZip(content) && /\.zip$/i.test(path)) {
      if (depth + 1 > limits.maxDepth) throw new ZipError(`„${path}“: ZIP-Dateien sind höchstens eine Ebene tief verschachtelt erlaubt.`);
      for (const inner of unzip(content, { limits, budget, depth: depth + 1 })) out.push({ ...inner, path: `${path}/${inner.path}` });
      continue;
    }
    out.push({ path, name: path.split("/").pop() ?? path, data: content });
  }
  return out;
}

// ───────────── ZIP schreiben (nur für Tests und Testdaten; „stored“ oder „deflate“) ─────────────
export function buildZip(files: { path: string; data: Uint8Array | string; store?: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.path);
    const packed = f.store ? data : deflateRawSync(data);
    const method = f.store ? 0 : 8;
    const crc = crc32(data) >>> 0;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, packed);
    centrals.push(ch);
    offset += lh.length + packed.length;
  }
  const cdSize = centrals.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, eocd];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const part of all) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
