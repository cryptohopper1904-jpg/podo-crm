import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { runReminders } from "@/server/reminders";
import { retryDueWebhooks } from "@/server/webhooks";
import { runPromoTrialReturns } from "@/server/promo-codes";
import { catchUpArchives } from "@/server/archive-catchup";

/** Zeitbudget je Lauf für das Nachholen des Beleg-Archivs (der Rest folgt im nächsten Lauf) */
const ARCHIVE_CATCHUP_BUDGET_MS = 20_000;
import { runPendingWaitlistOffers } from "@/server/calendar-status";

/**
 * Erinnerungs-Lauf (alle 15 Minuten): POST /api/cron/reminders mit `Authorization: Bearer ${CRON_SECRET}`.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed)
 * - falsches/fehlendes Token → 401 (zeitkonstanter Vergleich)
 * GET wird ebenfalls akzeptiert (Vercel Cron ruft per GET mit demselben Header auf).
 * Zusätzlich: Wiederholung fehlgeschlagener/liegengebliebener Webhook-Ereignisse mit Backoff und Löschung alter
 * Ereignisse (Gesamt-Review H4/H7) – eigener Fehlerpfad, damit Erinnerungen davon unabhängig laufen.
 * Zusätzlich: abgelaufene Aktionscode-Testphasen aus dem Kostenlos-Tarif zurückstellen (runPromoTrialReturns, eigener
 * Fehlerpfad; läuft auch im nächtlichen Cron – die Hinweise versprechen „spätestens in der folgenden Nacht“).
 * Zusätzlich (nach den Erinnerungen): Beleg-Archiv nachholen (PDFs von Belegen/Zahlungsbelegen, deren Ablage
 * gescheitert war) – eigener Fehlerpfad, je Praxis abgesichert, Zeitbudget, Backoff nach Fehlversuchen.
 * Zusätzlich: Wartelisten-Angebote für Absagen aus dem Kalender nachholen, deren verzögerter Versand (Frist für
 * „Rückgängig“) nicht gelaufen ist (runPendingWaitlistOffers, nur letzte 24 h, eigener Fehlerpfad).
 * Antwort enthält nur Zähler, keine Personendaten.
 */

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  let webhooks: Awaited<ReturnType<typeof retryDueWebhooks>> | null = null;
  try {
    webhooks = await retryDueWebhooks();
  } catch (e) {
    log.error("cron.webhooks.failed", { error: e });
  }
  let promoReturns: Awaited<ReturnType<typeof runPromoTrialReturns>> | null = null;
  try {
    promoReturns = await runPromoTrialReturns();
  } catch (e) {
    log.error("cron.promo_return_free.failed", { error: e });
  }
  let waitlistOffers: Awaited<ReturnType<typeof runPendingWaitlistOffers>> | null = null;
  try {
    waitlistOffers = await runPendingWaitlistOffers();
  } catch (e) {
    log.error("cron.waitlist_pending.failed", { error: e });
  }
  let result: Awaited<ReturnType<typeof runReminders>> | null = null;
  try {
    result = await runReminders();
  } catch (e) {
    log.error("cron.reminders.failed", { error: e });
  }
  // Beleg-Archiv nachholen NACH den Erinnerungen (die sind zeitkritisch), mit Zeitbudget und Backoff – läuft auch,
  // wenn die Erinnerungen fehlschlagen
  let archives: Awaited<ReturnType<typeof catchUpArchives>> | null = null;
  try {
    archives = await catchUpArchives({ budgetMs: ARCHIVE_CATCHUP_BUDGET_MS, respectBackoff: true });
  } catch (e) {
    log.error("cron.archive_catchup.failed", { error: e });
  }
  if (!result) return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  if (!webhooks) return NextResponse.json({ error: "Webhook-Wiederholung fehlgeschlagen", ...result }, { status: 500 });
  return NextResponse.json({ ok: true, ...result, webhooks, promoReturns, archives, waitlistOffers }, { headers: { "Cache-Control": "no-store" } });
}

export const POST = handle;
export const GET = handle;
