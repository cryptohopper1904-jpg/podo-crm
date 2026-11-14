import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { evaluateCalendarFeeds, overallStatus, type CheckResult } from "@/lib/ops-health";
import { checkMigrations, checkOverdueDeletions, checkPaymentRefIndex, checkStripeCustomerIndex, checkTimestamps, withTimeout } from "@/server/ops-status";
import { webhookBacklog } from "@/server/webhooks";
import { calendarFeedHealth } from "@/server/calendar-feeds";

export const dynamic = "force-dynamic";

/**
 * Ausführlicher Betriebs-Check für Monitoring (z. B. Uptime Kuma, alle 5 min):
 *   GET /api/health/deep  mit  Authorization: Bearer ${HEALTH_TOKEN}  (eigenes Token, kein Rückgriff auf CRON_SECRET)
 * - kein Token konfiguriert → 503 (fail closed), falsches Token → 401 (zeitkonstanter Vergleich)
 * - Prüfungen: Datenbank, Migrationsstand, Dateiablage beschreibbar, Alter des letzten Backups,
 *   letzte Cron-Läufe (Zeitstempel-Dateien in STATUS_DIR, geschrieben von backup-/cron-Container),
 *   Kalender-Abo (Alter des letzten erfolgreichen Abrufs, „kalender_abo“), eindeutiger SumUp-Index („zahlungen_index“),
 *   überfällige Löschanträge („loeschantraege“, nur Anzahl)
 * - Antwort: Zustand je Prüfung, nur Zeiten/Zähler, keine Personendaten, keine Fehlertexte der DB
 * - HTTP 200 bei ok/warn, 503 bei mindestens einem „fail“
 * Das öffentliche /api/health bleibt minimal ({ ok: true }) für Container-Healthchecks.
 */

async function checkDb(): Promise<CheckResult> {
  const t = Date.now();
  try {
    await withTimeout(db.execute(sql`select 1`));
    return { status: "ok", ms: Date.now() - t };
  } catch {
    return { status: "fail", hint: "Datenbank nicht erreichbar" };
  }
}

async function checkStorage(): Promise<CheckResult> {
  const dir = process.env.STORAGE_DIR;
  if (!dir) return { status: "skipped", hint: "STORAGE_DIR nicht gesetzt" };
  const f = path.join(dir, `.healthcheck-${randomUUID()}`);
  try {
    await withTimeout(writeFile(f, "ok", { flag: "wx", mode: 0o600 }));
    await rm(f, { force: true });
    return { status: "ok" };
  } catch {
    await rm(f, { force: true }).catch(() => {});
    return { status: "fail", hint: "Dateiablage nicht beschreibbar" };
  }
}

/** Gesamt-Review H7: Webhook-Ereignisse, die seit über 1 h unverarbeitet bzw. endgültig fehlgeschlagen sind (nur Zähler). */
async function checkWebhooks(): Promise<CheckResult> {
  try {
    const { open, dead } = await withTimeout(webhookBacklog(3600_000), 5000);
    if (open > 0) return { status: "fail", open, dead, hint: "Webhook-Ereignisse seit über 1 h unverarbeitet" };
    if (dead > 0) return { status: "warn", open, dead, hint: "endgültig fehlgeschlagene Webhook-Ereignisse (Posteingang der Praxis)" };
    return { status: "ok", open, dead };
  } catch {
    return { status: "fail", hint: "Webhook-Status nicht lesbar" };
  }
}

/** Kalender-Abo: Alter des letzten erfolgreichen Abrufs (nur Zähler/Zeiten). */
async function checkCalendarFeeds(): Promise<CheckResult> {
  try {
    return evaluateCalendarFeeds(await withTimeout(calendarFeedHealth(30), 5000));
  } catch {
    return { status: "fail", hint: "Kalender-Abo-Status nicht lesbar" };
  }
}

export async function GET(req: NextRequest) {
  // nur ein eigenes Token – kein Rückgriff auf CRON_SECRET (getrennte Geheimnisse für Monitoring und Cron)
  const secret = process.env.HEALTH_TOKEN;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Health-Token nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });

  const [database, migrations, storage, stamps, webhooks, kalender_abo, zahlungen_index, stripe_kunde_index, loeschantraege] = await Promise.all([
    checkDb(),
    checkMigrations(),
    checkStorage(),
    checkTimestamps(),
    checkWebhooks(),
    checkCalendarFeeds(),
    checkPaymentRefIndex(),
    checkStripeCustomerIndex(),
    checkOverdueDeletions(),
  ]);
  const checks: Record<string, CheckResult> = { database, migrations, storage, ...stamps, webhooks, kalender_abo, zahlungen_index, stripe_kunde_index, loeschantraege };
  const status = overallStatus(checks);
  if (status !== "ok") {
    log.warn("health.deep", { status, failed: Object.entries(checks).filter(([, c]) => c.status === "fail").map(([k]) => k).join(",") || null });
  }
  return NextResponse.json(
    { ok: status !== "fail", status, checkedAt: new Date().toISOString(), checks },
    { status: status === "fail" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
