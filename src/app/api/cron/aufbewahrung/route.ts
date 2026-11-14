import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { purgeStaleOnlineRequestsAll } from "@/server/online-request-retention";

/**
 * Aufbewahrung (täglich): nicht in eine Akte übernommene Online-Terminanfragen 6 Monate nach Eingang löschen
 * (src/server/online-request-retention.ts). POST /api/cron/aufbewahrung mit `Authorization: Bearer ${CRON_SECRET}`.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed), falsches Token → 401
 * Antwort enthält nur Zähler, keine Personendaten.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  try {
    const result = await purgeStaleOnlineRequestsAll();
    // Einzelne Praxis fehlgeschlagen: 500 → der cron-Container schreibt keinen Zeitstempel, /api/health/deep
    // („cronAufbewahrung“) schlägt nach 26 h Alarm. Je Praxis: log.error „retention.online_requests.failed“.
    if (result.errors > 0) {
      log.error("cron.aufbewahrung.partial", { errors: result.errors, count: result.organizations });
      return NextResponse.json({ ok: false, ...result }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
    log.info("cron.aufbewahrung.done", { count: result.organizations, skipped: result.skipped, appointments: result.appointments, messages: result.messages });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("cron.aufbewahrung.failed", { error: e });
    return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
