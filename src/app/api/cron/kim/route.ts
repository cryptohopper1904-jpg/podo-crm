import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/safe-equal";
import { runKimSyncAll } from "@/server/kim";

/**
 * KIM-Abruf für alle Praxen mit aktiver KIM-Verbindung (z. B. alle 15 Minuten):
 * POST /api/cron/kim mit `Authorization: Bearer ${CRON_SECRET}`.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed), falsches Token → 401
 * - Nachrichten werden nie automatisch einer Person zugeordnet
 * Antwort enthält nur Zähler, keine Personendaten.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  try {
    const result = await runKimSyncAll();
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[cron/kim]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
