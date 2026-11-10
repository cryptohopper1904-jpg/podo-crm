/**
 * Abmeldelink der Vertriebsmails: /abmelden/<token>, token = base64url(16 Byte Lead-UUID) + "." + HMAC-SHA256 (gekürzt).
 * Enthält keine Kontaktdaten (nur die zufällige Lead-ID), Schlüssel aus APP_ENCRYPTION_KEY abgeleitet (eigener Zweck).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadKey } from "../crypto";

const derive = (key: Buffer) => createHmac("sha256", key).update("podo:vertrieb:unsubscribe:v1").digest();
const mac = (id: Buffer, key: Buffer) => createHmac("sha256", derive(key)).update(id).digest().subarray(0, 16);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function unsubscribeToken(leadId: string, key: Buffer = loadKey()): string {
  if (!UUID_RE.test(leadId)) throw new Error("Ungültige Lead-ID");
  const id = Buffer.from(leadId.replace(/-/g, ""), "hex");
  return `${id.toString("base64url")}.${mac(id, key).toString("base64url")}`;
}

/** Lead-ID bei gültigem Token, sonst null. */
export function verifyUnsubscribeToken(token: string, key: Buffer = loadKey()): string | null {
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(token ?? "");
  if (!m) return null;
  const id = Buffer.from(m[1], "base64url");
  const given = Buffer.from(m[2], "base64url");
  if (id.length !== 16 || given.length !== 16) return null;
  // nur die kanonische Kodierung gilt (sonst gäbe es mehrere gültige Schreibweisen desselben Tokens)
  if (id.toString("base64url") !== m[1] || given.toString("base64url") !== m[2]) return null;
  if (!timingSafeEqual(given, mac(id, key))) return null;
  const hex = id.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function unsubscribeUrl(leadId: string, publicUrl: string | undefined = process.env.PUBLIC_URL, key?: Buffer): string {
  const base = (publicUrl || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/abmelden/${unsubscribeToken(leadId, key)}`;
}
