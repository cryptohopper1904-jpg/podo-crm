/**
 * Kurzlebige Portal-Sitzung (Cookie `podo_portal`) statt des Tokens in der URL.
 * Wert: `<linkId>.<exp>.<HMAC-SHA256(APP_ENCRYPTION_KEY, "portal-session|linkId|exp")>` (base64url).
 * Die Sitzung trägt nur die Link-ID; bei jedem Aufruf wird zusätzlich geprüft, dass der Link noch gültig
 * (nicht abgelaufen/widerrufen) ist – ein Widerruf beendet also auch laufende Sitzungen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadKey } from "./crypto";

export const PORTAL_COOKIE = "podo_portal";
export const PORTAL_SESSION_SECONDS = 2 * 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mac = (linkId: string, exp: number, key: Buffer) => createHmac("sha256", key).update(`portal-session|${linkId}|${exp}`).digest("base64url");

/** Sitzung ausstellen; läuft spätestens mit dem Link ab. */
export function signPortalSession(linkId: string, linkExpiresAt: Date, opts: { now?: number; key?: Buffer } = {}) {
  const now = opts.now ?? Date.now();
  const exp = Math.floor(Math.min(now + PORTAL_SESSION_SECONDS * 1000, linkExpiresAt.getTime()) / 1000);
  return { value: `${linkId}.${exp}.${mac(linkId, exp, opts.key ?? loadKey())}`, expires: new Date(exp * 1000) };
}

/** Prüft Signatur und Ablauf (zeitkonstant). Gibt die Link-ID zurück oder null. */
export function verifyPortalSession(value: string | null | undefined, opts: { now?: number; key?: Buffer } = {}): string | null {
  if (!value || value.length > 200) return null;
  const [linkId, expStr, sig, ...rest] = value.split(".");
  if (rest.length || !linkId || !UUID.test(linkId) || !/^\d{1,12}$/.test(expStr ?? "") || !sig) return null;
  const exp = Number(expStr);
  if (exp * 1000 <= (opts.now ?? Date.now())) return null;
  const expected = Buffer.from(mac(linkId, exp, opts.key ?? loadKey()));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return linkId;
}

export function portalCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/portal",
    expires,
  };
}
