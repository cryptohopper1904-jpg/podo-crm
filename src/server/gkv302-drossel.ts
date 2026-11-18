import "server-only";
import { createRateLimiter } from "@/lib/rate-limit";

/**
 * Drosselung der § 302-Testdatei je Praxis (Review-Runde 2, AppSec H3): höchstens eine Erzeugung gleichzeitig und
 * wenige je Minute – das Erzeugen hält eine Zeilensperre und baut ZIP/PDF im Speicher. Prozessspeicher genügt für eine
 * App-Instanz (wie src/lib/rate-limit.ts).
 */
export const TESTDATEI_JE_MINUTE = 5;
const limiter = createRateLimiter({ windowMs: 60_000, max: TESTDATEI_JE_MINUTE, maxKeys: 5_000 });
const laufend = new Set<string>();

export function testdateiStarten(org: string, now = Date.now()): { fertig: () => void } | { error: string } {
  if (laufend.has(org)) return { error: "Für diese Praxis läuft bereits eine Erzeugung der Testdatei. Bitte kurz warten." };
  if (limiter.limited(org, now)) return { error: "Zu viele Testdateien in kurzer Zeit. Bitte in einer Minute erneut versuchen." };
  laufend.add(org);
  return { fertig: () => void laufend.delete(org) };
}
