import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { runReadonlyExpiry } from "@/server/readonly-expiry";

/**
 * Ende des Nur-Lesen-Modus (AGB § 9 Nr. 2, src/lib/readonly-expiry.ts): POST /api/cron/nur-lesen mit
 * `Authorization: Bearer ${CRON_SECRET}` (GET ebenso, für Vercel Cron). Der Container `cron` ruft ihn alle 6 Stunden auf.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed), falsches Token → 401 (zeitkonstanter Vergleich)
 * - kündigt die Löschung an (E-Mail an Inhaber:innen, Posteingang), stellt den automatischen Löschantrag und erinnert
 *   7 Tage vor dem Löschtermin; gelöscht wird weiterhin nur durch den Löschlauf (scripts/purge-organizations.ts).
 * Antwort enthält nur Zähler, keine Praxisdaten.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  try {
    const r = await runReadonlyExpiry();
    if (r.failed) log.warn("cron.readonly_expiry.partial", { failed: r.failed });
    return NextResponse.json({ ok: r.failed === 0, ...r }, { status: r.failed ? 500 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("cron.readonly_expiry.failed", { error: e });
    return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
