import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { safeEqual } from "@/lib/safe-equal";
import { log } from "@/lib/log";
import { evaluateMigrations, evaluateTimestamp, MAX_AGE_SECONDS, overallStatus, parseEpoch, type CheckResult } from "@/lib/ops-health";

export const dynamic = "force-dynamic";

/**
 * Ausführlicher Betriebs-Check für Monitoring (z. B. Uptime Kuma, alle 5 min):
 *   GET /api/health/deep  mit  Authorization: Bearer ${HEALTH_TOKEN}  (eigenes Token, kein Rückgriff auf CRON_SECRET)
 * - kein Token konfiguriert → 503 (fail closed), falsches Token → 401 (zeitkonstanter Vergleich)
 * - Prüfungen: Datenbank, Migrationsstand, Dateiablage beschreibbar, Alter des letzten Backups,
 *   letzte Cron-Läufe (Zeitstempel-Dateien in STATUS_DIR, geschrieben von backup-/cron-Container)
 * - Antwort: Zustand je Prüfung, nur Zeiten/Zähler, keine Personendaten, keine Fehlertexte der DB
 * - HTTP 200 bei ok/warn, 503 bei mindestens einem „fail“
 * Das öffentliche /api/health bleibt minimal ({ ok: true }) für Container-Healthchecks.
 */

function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function readStatus(dir: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

async function checkDb(): Promise<CheckResult> {
  const t = Date.now();
  try {
    await withTimeout(db.execute(sql`select 1`));
    return { status: "ok", ms: Date.now() - t };
  } catch {
    return { status: "fail", hint: "Datenbank nicht erreichbar" };
  }
}

async function checkMigrations(): Promise<CheckResult> {
  let journal: { count: number; latestWhen: number | null; latestTag: string | null } | null = null;
  try {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries?: { when: number; tag: string }[] };
    const entries = raw.entries ?? [];
    const last = entries.at(-1);
    journal = { count: entries.length, latestWhen: last?.when ?? null, latestTag: last?.tag ?? null };
  } catch {
    journal = null;
  }
  let applied: { count: number; latestWhen: number | null } | null = null;
  try {
    const r = await withTimeout(db.execute<{ n: number; w: string | null }>(sql`select count(*)::int as n, max(created_at)::text as w from drizzle.__drizzle_migrations`));
    const row = r.rows[0];
    applied = { count: Number(row?.n ?? 0), latestWhen: row?.w ? Number(row.w) : null };
  } catch {
    applied = null;
  }
  return evaluateMigrations(applied, journal);
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

async function checkTimestamps(): Promise<Record<string, CheckResult>> {
  const dir = process.env.STATUS_DIR;
  if (!dir) {
    const skipped: CheckResult = { status: "skipped", hint: "STATUS_DIR nicht gesetzt" };
    return { backup: skipped, cronReminders: skipped, cronKim: skipped };
  }
  const now = Date.now();
  const [backup, reminders, kim] = await Promise.all([readStatus(dir, "backup.last"), readStatus(dir, "cron-reminders.last"), readStatus(dir, "cron-kim.last")]);
  return {
    backup: evaluateTimestamp(parseEpoch(backup), MAX_AGE_SECONDS.backup, now, "noch kein Backup erfasst"),
    cronReminders: evaluateTimestamp(parseEpoch(reminders), MAX_AGE_SECONDS.cron, now),
    cronKim: evaluateTimestamp(parseEpoch(kim), MAX_AGE_SECONDS.cron, now),
  };
}

export async function GET(req: NextRequest) {
  // nur ein eigenes Token – kein Rückgriff auf CRON_SECRET (getrennte Geheimnisse für Monitoring und Cron)
  const secret = process.env.HEALTH_TOKEN;
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Health-Token nicht eingerichtet" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!safeEqual(token, secret)) return NextResponse.json({ error: "Nicht autorisiert" }, { status: 401 });

  const [database, migrations, storage, stamps] = await Promise.all([checkDb(), checkMigrations(), checkStorage(), checkTimestamps()]);
  const checks: Record<string, CheckResult> = { database, migrations, storage, ...stamps };
  const status = overallStatus(checks);
  if (status !== "ok") {
    log.warn("health.deep", { status, failed: Object.entries(checks).filter(([, c]) => c.status === "fail").map(([k]) => k).join(",") || null });
  }
  return NextResponse.json(
    { ok: status !== "fail", status, checkedAt: new Date().toISOString(), checks },
    { status: status === "fail" ? 503 : 200, headers: { "Cache-Control": "no-store" } },
  );
}
