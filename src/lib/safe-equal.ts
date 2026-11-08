import { createHash, timingSafeEqual } from "node:crypto";

/** Zeitkonstanter Vergleich beliebig langer Strings (über SHA-256). Leere Werte sind nie gleich. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
