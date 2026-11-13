import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { runLeadSearch } from "@/server/lead-search";
import { purgeStaleLeads } from "@/server/vertrieb";
import { runPromoTrialReturns } from "@/server/promo-codes";

/**
 * Nächtliche Praxissuche (Vertrieb): POST /api/cron/lead-search mit `Authorization: Bearer ${CRON_SECRET}`.
 * - CRON_SECRET nicht gesetzt → 503 (fail closed), falsches Token → 401
 * - Läuft nur, wenn die Suche in der Plattform-Konsole (Vertrieb → Einstellungen) eingeschaltet ist.
 * - Je Aufruf genau ein Ring (eine Overpass-Abfrage). Ein Overpass-/Netzfehler wird im Status gespeichert
 *   (200, Ring wird beim nächsten Lauf wiederholt) – so fragt der Cron in derselben Nacht nicht erneut an.
 * - Unabhängig von der Suche, je eigener Fehlerbehandlung: Leads ohne Kontakt seit 24 Monaten löschen (Datenschutzerklärung
 *   „Vertrieb“) und abgelaufene Aktionscode-Testphasen aus dem Kostenlos-Tarif zurückstellen (AGB § 3 Abs. 4).
 * Antwort enthält nur Zähler, keine Praxisdaten.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Cron nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });
  let purged: number | null = null;
  try {
    purged = await purgeStaleLeads();
  } catch (e) {
    log.error("cron.lead_purge.failed", { error: e });
  }
  let promoReturns: Awaited<ReturnType<typeof runPromoTrialReturns>> | null = null;
  try {
    promoReturns = await runPromoTrialReturns();
  } catch (e) {
    log.error("cron.promo_return_free.failed", { error: e });
  }
  try {
    const r = await runLeadSearch({ trigger: "cron" });
    const body =
      "run" in r
        ? { ok: true, status: r.status, ring: [r.run.innerKm, r.run.outerKm], found: r.run.found, added: r.run.added, withEmail: r.run.withEmail, purged, promoReturns }
        : { ok: true, status: r.status, purged, promoReturns };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    log.error("cron.lead_search.failed", { error: e });
    return NextResponse.json({ error: "Lauf fehlgeschlagen" }, { status: 500 });
  }
}

export const POST = handle;
