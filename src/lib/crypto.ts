/**
 * Symmetrische Verschlüsselung für Zugangsdaten (API-Keys, OAuth-Tokens, TOTP-Secrets).
 *
 * Verfahren: AES-256-GCM, 12-Byte-IV, 16-Byte-Auth-Tag.
 * Format:    `v1:<iv>:<tag>:<cipher>` – alle Teile base64.
 * Schlüssel: env `APP_ENCRYPTION_KEY` = 32 Byte, base64-kodiert
 *            (erzeugen z. B. mit `openssl rand -base64 32`).
 *
 * Hinweis (PLAN 14.4): Langfristig gehört der Schlüssel in ein KMS/Vault mit Rotation.
 * Das Versionspräfix `v1` erlaubt eine spätere Schlüssel-/Verfahrensrotation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoConfigError";
  }
}

/** Liest und prüft den Schlüssel. `keyB64` überschreibt die Umgebungsvariable (für Tests). */
export function loadKey(keyB64: string | undefined = process.env.APP_ENCRYPTION_KEY): Buffer {
  if (!keyB64) throw new CryptoConfigError("APP_ENCRYPTION_KEY ist nicht gesetzt.");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new CryptoConfigError(`APP_ENCRYPTION_KEY muss 32 Byte (base64) lang sein, ist aber ${key.length} Byte.`);
  }
  return key;
}

/** Verschlüsselt einen Klartext. `aad` (optional) bindet den Geheimtext an einen Kontext, z. B. die Mandanten-ID. */
export function encrypt(plaintext: string, opts: { key?: Buffer; aad?: string } = {}): string {
  const key = opts.key ?? loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  if (opts.aad) cipher.setAAD(Buffer.from(opts.aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** Entschlüsselt; wirft bei falschem Schlüssel, manipuliertem Geheimtext oder unbekanntem Format. */
export function decrypt(payload: string, opts: { key?: Buffer; aad?: string } = {}): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Unbekanntes Format des verschlüsselten Werts.");
  }
  const [, ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("Ungültige IV- oder Tag-Länge.");
  }
  const key = opts.key ?? loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  if (opts.aad) decipher.setAAD(Buffer.from(opts.aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Entschlüsselung fehlgeschlagen (falscher Schlüssel oder manipulierte Daten).");
  }
}

/** Komfortfunktionen für JSON-Geheimnisse (z. B. `{ apiKey, merchantCode }`). */
export function encryptJson(value: unknown, opts?: { key?: Buffer; aad?: string }): string {
  return encrypt(JSON.stringify(value), opts);
}
export function decryptJson<T = unknown>(payload: string, opts?: { key?: Buffer; aad?: string }): T {
  return JSON.parse(decrypt(payload, opts)) as T;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}:`) && value.split(":").length === 4;
}
