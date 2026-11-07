/**
 * Token für den persönlichen iCal-Feed: `<userId>.<HMAC-SHA256(userId)>` (base64url),
 * Schlüssel = APP_ENCRYPTION_KEY. Kein Login nötig (Kalender-Apps senden keine Cookies),
 * deshalb enthält der Feed keine Patientennamen.
 * Widerruf: derzeit nur über Schlüsselrotation – TODO: Token-Version pro Benutzer.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadKey } from "./crypto";

const sign = (userId: string, key: Buffer) => createHmac("sha256", key).update(`calendar:${userId}`).digest("base64url");

export function calendarToken(userId: string, key: Buffer = loadKey()): string {
  return `${userId}.${sign(userId, key)}`;
}

/** Gibt die userId zurück, wenn das Token gültig ist, sonst null. */
export function verifyCalendarToken(token: string, key: Buffer = loadKey()): string | null {
  const clean = token.replace(/\.ics$/i, "");
  const i = clean.lastIndexOf(".");
  if (i <= 0) return null;
  const userId = clean.slice(0, i);
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const given = Buffer.from(clean.slice(i + 1));
  const expected = Buffer.from(sign(userId, key));
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}
