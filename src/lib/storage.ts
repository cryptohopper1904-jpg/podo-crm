import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function storeEncrypted(organizationId: string, data: Buffer) {
  const now = new Date();
  const key = `${organizationId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.bin`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  cipher.setAAD(Buffer.from(key));
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const payload = Buffer.concat([Buffer.from("PODO1"), iv, cipher.getAuthTag(), enc]);
  await getDriver().put(key, payload);
  return { storageKey: key, sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.length };
}

export async function readDecrypted(storageKey: string): Promise<Buffer> {
  const payload = await getDriver().get(storageKey);
  if (payload.subarray(0, 5).toString() !== "PODO1") throw new Error("Unbekanntes Dateiformat");
  const iv = payload.subarray(5, 17);
  const tag = payload.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
  decipher.setAAD(Buffer.from(storageKey));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
}
