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
export async function GET() {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  let migrations: "ok" | "ausstehend" | "unbekannt" = "unbekannt";
  try {
    const m = await checkMigrations();
    migrations = m.status === "ok" ? "ok" : m.status === "fail" ? "ausstehend" : "unbekannt";
  } catch {
    migrations = "unbekannt";
  }
  return NextResponse.json({ ok: true, version: process.env.APP_COMMIT || "unknown", migrations });
}
