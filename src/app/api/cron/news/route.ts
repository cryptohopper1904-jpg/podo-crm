import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { refreshNews } from "@/server/news";

/**
 * Automatischer News-Abruf (z. B. alle 6 Stunden): POST /api/cron/news mit `Authorization: Bearer ${CRON_SECRET}`.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed), falsches Token → 401
 * - Ohne auslösende Praxis keine KI-Zusammenfassung: es wird der Anrisstext der Quelle gespeichert.
 * Öffentliche Daten; Antwort enthält nur Zähler.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  try {
    const r = await refreshNews(null);
    if (r.errors.length) log.warn("cron.news.partial", { errors: r.errors.length });
    revalidatePath("/news");
    return NextResponse.json({ ok: true, loaded: r.loaded, added: r.added, removed: r.removed }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("cron.news.failed", { error: e });
    return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
