import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { checkMigrations } from "@/server/ops-status";

export const dynamic = "force-dynamic";

/**
 * Öffentlicher Health-Check (Deploy-Warteschleifen, Uptime-Monitor): Datenbank erreichbar, Commit-Stand und – ohne
 * Zahlen, Namen oder Fehlertexte – ob die Datenbank auf dem Migrationsstand des Codes ist („ok“ / „ausstehend“ /
 * „unbekannt“). Der Migrationsstand ändert den HTTP-Status nicht (Deploy-Skripte warten nur auf 200); Details liefert
 * das geschützte /api/health/deep.
 */
type MigrationState = "ok" | "ausstehend" | "unbekannt";
// Migrationsstand ändert sich nur beim Deploy: Ergebnis kurz im Speicher halten und gleichzeitige Anfragen bündeln,
// damit eine Anfrageflut auf den öffentlichen Check die Datenbank nicht zusätzlich belastet (AppSec)
let cache: { at: number; v: MigrationState } | null = null;
let inflight: Promise<MigrationState> | null = null;
const TTL_MS = { ok: 60_000, ausstehend: 60_000, unbekannt: 10_000 } as const;

function migrationState(): Promise<MigrationState> {
  if (cache && Date.now() - cache.at < TTL_MS[cache.v]) return Promise.resolve(cache.v);
  inflight ??= checkMigrations()
    .then((m): MigrationState => (m.status === "ok" ? "ok" : m.status === "fail" ? "ausstehend" : "unbekannt"))
    .catch((): MigrationState => "unbekannt")
    .then((v) => {
      cache = { at: Date.now(), v };
      return v;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function GET() {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  const migrations = await migrationState();
  return NextResponse.json({ ok: true, version: process.env.APP_COMMIT || "unknown", migrations });
}
