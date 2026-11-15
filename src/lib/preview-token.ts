/**
 * Server-signiertes Vorschau-Token für Importe: bindet den Import an genau die geprüfte Datei
 * (SHA-256), Praxis, Benutzer und Importart; gültig 15 Minuten. Ohne gültiges Token kein Import.
 */
import { createHmac } from "node:crypto";
import { loadKey } from "./crypto";
import { safeEqual } from "./safe-equal";

export interface PreviewBinding {
  hash: string;
  organizationId: string;
  userId: string;
  type: "excel" | "doctolib" | "uebernahme";
}

const TTL_MS = 15 * 60_000;

function mac(b: PreviewBinding, exp: number, key: Buffer) {
  return createHmac("sha256", key).update(`import-preview|${b.hash}|${b.organizationId}|${b.userId}|${b.type}|${exp}`).digest("base64url");
}

export function signPreviewToken(b: PreviewBinding, now = Date.now(), key: Buffer = loadKey()): string {
  const exp = now + TTL_MS;
  return `${exp}.${mac(b, exp, key)}`;
}

/**
 * Genau „<13 Ziffern>.<43 Zeichen base64url>“ (HMAC-SHA-256) – keine Varianten mit Zusatzteilen, Leerzeichen,
 * Vorzeichen oder Exponent, die dieselbe Signatur tragen (AppSec Runde 2 A-H1: Einmal-Token sonst mehrfach einlösbar).
 */
export const PREVIEW_TOKEN_RE = /^\d{13}\.[A-Za-z0-9_-]{43}$/;

export function verifyPreviewToken(token: string | null | undefined, b: PreviewBinding, now = Date.now(), key: Buffer = loadKey()): boolean {
  if (!token || !PREVIEW_TOKEN_RE.test(token)) return false;
  const [expRaw, sig] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < now) return false;
  return safeEqual(sig, mac(b, exp, key));
}

/** Kanonische Form eines gültigen Tokens (für den Einmal-Hash): `${exp}.${sig}` */
export function canonicalPreviewToken(token: string): string {
  const [expRaw, sig] = token.split(".");
  return `${Number(expRaw)}.${sig}`;
}
