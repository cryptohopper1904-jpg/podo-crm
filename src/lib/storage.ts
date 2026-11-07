import "server-only";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadKey } from "./crypto";

/**
 * Verschlüsselte Dateiablage für Fotos, Audio und Dokumente.
 * - Jede Datei wird mit AES-256-GCM verschlüsselt (Schlüssel aus APP_ENCRYPTION_KEY,
 *   gebunden an Mandant + Speicherschlüssel als AAD), bevor sie die Festplatte erreicht.
 * - Standard: lokales Verzeichnis STORAGE_DIR (Docker-Volume). Für den SaaS-Betrieb kann
 *   ein S3-kompatibler Speicher (Hetzner Object Storage mit Object Lock) angebunden werden –
 *   die Schnittstelle bleibt gleich (siehe StorageDriver).
 * - Dateien werden nie überschrieben; der Pfad ist zufällig und enthält keine Namen.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** nur für das Aufräumen fehlgeschlagener Uploads (nie für dokumentierte Medien) */
  remove(key: string): Promise<void>;
}

class LocalDriver implements StorageDriver {
  constructor(private root: string) {}
  private file(key: string) {
    if (!/^[a-z0-9/-]+\.bin$/.test(key)) throw new Error("Ungültiger Speicherschlüssel");
    return path.join(this.root, key);
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data, { flag: "wx", mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.file(key));
  }
  async remove(key: string) {
    await rm(this.file(key), { force: true });
  }
}

let driver: StorageDriver | null = null;
function getDriver(): StorageDriver {
  driver ??= new LocalDriver(process.env.STORAGE_DIR ?? path.join(process.cwd(), "data", "storage"));
  return driver;
}

export function setStorageDriver(d: StorageDriver) {
  driver = d;
}

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-m4a",
  "application/pdf",
]);

/** Eigener Schlüssel je Praxis (HKDF aus dem Hauptschlüssel) – trennt Mandanten auch kryptografisch. */
function orgKey(organizationId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", loadKey(), Buffer.from(organizationId), Buffer.from("podo-media-v2"), 32));
}

export async function storeEncrypted(organizationId: string, data: Buffer) {
  const now = new Date();
  const key = `${organizationId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.bin`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", orgKey(organizationId), iv);
  cipher.setAAD(Buffer.from(key));
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const payload = Buffer.concat([Buffer.from("PODO2"), iv, cipher.getAuthTag(), enc]);
  await getDriver().put(key, payload);
  return { storageKey: key, sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.length };
}

export async function readDecrypted(storageKey: string): Promise<Buffer> {
  const payload = await getDriver().get(storageKey);
  const magic = payload.subarray(0, 5).toString();
  if (magic !== "PODO1" && magic !== "PODO2") throw new Error("Unbekanntes Dateiformat");
  const iv = payload.subarray(5, 17);
  const tag = payload.subarray(17, 33);
  const key = magic === "PODO2" ? orgKey(storageKey.split("/")[0]) : loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(storageKey));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
}

export async function discardStored(storageKey: string) {
  await getDriver().remove(storageKey);
}

/** Prüft den echten Dateityp anhand der ersten Bytes (Client-Angaben sind nicht vertrauenswürdig). */
export function sniffMime(buf: Buffer): string | null {
  const b = buf.subarray(0, 16);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE") return "audio/wav";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = b.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|hevc|mif1|msf1|heim|heis)/.test(brand)) return "image/heic";
    return "audio/mp4"; // M4A/MP4-Audio (iOS-Sprachaufnahme)
  }
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "audio/webm";
  if (b.subarray(0, 4).toString("latin1") === "OggS") return "audio/ogg";
  if (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}
