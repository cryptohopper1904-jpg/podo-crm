/**
 * Sperrliste des Vertriebs (Abmeldungen/Widersprüche) als nicht umkehrbarer Prüfwert: HMAC-SHA256 der
 * kleingeschriebenen Adresse mit einem aus APP_ENCRYPTION_KEY abgeleiteten Schlüssel (eigener Zweck). Gespeichert wird
 * nur der Prüfwert – ein Abgleich ist möglich („steht diese Adresse auf der Sperrliste?“), eine Liste der Adressen nicht.
 */
import { createHmac } from "node:crypto";
import { loadKey } from "../crypto";

const derive = (key: Buffer) => createHmac("sha256", key).update("podo:vertrieb:sperrliste:v1").digest();

export const normalizeBlockEmail = (email: string) => email.trim().toLowerCase();

/** Prüfwert „v1:<64 hex>“ einer E-Mail-Adresse */
export function blocklistHash(email: string, key: Buffer = loadKey()): string {
  return `v1:${createHmac("sha256", derive(key)).update(normalizeBlockEmail(email)).digest("hex")}`;
}

/** Menge, die Adressen über ihren Prüfwert abgleicht (für Dubletten-/Sperrprüfungen mit has(email)) */
export function hashedEmailSet(hashes: Iterable<string>, key?: Buffer): { has(email: string): boolean } {
  const set = new Set(hashes);
  return { has: (email: string) => set.has(blocklistHash(email, key)) };
}
