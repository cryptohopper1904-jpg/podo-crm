import "server-only";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { evaluateMigrations, evaluateTimestamp, MAX_AGE_SECONDS, parseEpoch, type CheckResult } from "@/lib/ops-health";

/**
 * Betriebs-Zustand (Migrationsstand, Zeitstempel der Backup-/Cron-Läufe) – gemeinsam genutzt von
 * /api/health/deep und der Plattform-Konsole. Nur Zustände, Zeiten und Zähler, keine Personendaten.
 */

export function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function readStatus(dir: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch {
    return null;
  }
}

export async function checkMigrations(): Promise<CheckResult> {
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

/** Eindeutiger Index je SumUp-Transaktion (Migration 0048 legt ihn bei Dubletten nicht an) – fehlt er: warn. */
export async function checkPaymentRefIndex(): Promise<CheckResult> {
  try {
    const r = await withTimeout(db.execute(sql`select 1 from pg_indexes where schemaname = 'public' and indexname = 'payments_org_sumup_ref'`));
    return r.rows.length ? { status: "ok" } : { status: "warn", hint: "Index payments_org_sumup_ref fehlt (doppelte SumUp-Referenzen, siehe Deploy-Log)" };
  } catch {
    return { status: "fail", hint: "Index-Status nicht lesbar" };
  }
}

/** Alter des letzten Backups und der Cron-Läufe (Zeitstempel-Dateien in STATUS_DIR). */
export async function checkTimestamps(): Promise<Record<"backup" | "cronReminders" | "cronKim" | "cronAufbewahrung", CheckResult>> {
  const dir = process.env.STATUS_DIR;
  if (!dir) {
    const skipped: CheckResult = { status: "skipped", hint: "STATUS_DIR nicht gesetzt" };
    return { backup: skipped, cronReminders: skipped, cronKim: skipped, cronAufbewahrung: skipped };
  }
  const now = Date.now();
  const [backup, reminders, kim, retention, retentionFirst] = await Promise.all([
    readStatus(dir, "backup.last"),
    readStatus(dir, "cron-reminders.last"),
    readStatus(dir, "cron-kim.last"),
    readStatus(dir, "cron-aufbewahrung.last"),
    // vom cron-Container beim ersten Start geschrieben (deploy/docker-compose.yml)
    readStatus(dir, "cron-aufbewahrung.first"),
  ]);
  return {
    backup: evaluateTimestamp(parseEpoch(backup), MAX_AGE_SECONDS.backup, now, "noch kein Backup erfasst"),
    cronReminders: evaluateTimestamp(parseEpoch(reminders), MAX_AGE_SECONDS.cron, now),
    cronKim: evaluateTimestamp(parseEpoch(kim), MAX_AGE_SECONDS.cron, now),
    // täglicher Löschlauf Online-Anfragen (/api/cron/aufbewahrung); Fehlschlag einer Praxis → kein Zeitstempel → fail.
    // Noch nie erfolgreich: warn bis 26 h nach dem ersten Start des cron-Containers, danach fail (nicht dauerhaft warn)
    cronAufbewahrung: evaluateTimestamp(parseEpoch(retention), MAX_AGE_SECONDS.dailyCron, now, "noch kein Lauf erfasst", parseEpoch(retentionFirst)),
  };
}
