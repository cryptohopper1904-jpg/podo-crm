import "server-only";
import { count, desc, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { salesBlocklist, salesSuppressions } from "@/db/schema";
import { log } from "@/lib/log";
import { blocklistHash, hashedEmailSet, normalizeBlockEmail } from "@/lib/vertrieb/blocklist";

/**
 * Sperrliste des Vertriebs (Abmeldungen, Widersprüche): nur Prüfwerte (HMAC, src/lib/vertrieb/blocklist.ts),
 * keine Adressen. Rechtsgrundlage Art. 6 Abs. 1 lit. f DSGVO (Widerspruch dauerhaft beachten); gelöscht wird die
 * Sperrliste, wenn keine Vertriebs-E-Mails mehr versendet werden.
 * Altbestand (sales_suppressions mit Klartext-Adressen, bis Migration 0038) wird beim ersten Zugriff in Prüfwerte
 * überführt und der Klartext gelöscht (idempotent; der Schlüssel liegt nur in der App, nicht in der Datenbank).
 */

let legacyDone = false;

export async function migrateLegacySuppressions(): Promise<number> {
  if (legacyDone) return 0;
  let moved = 0;
  for (;;) {
    const rows = await db.select().from(salesSuppressions).limit(500);
    if (!rows.length) break;
    await db.transaction(async (tx) => {
      await tx
        .insert(salesBlocklist)
        .values(rows.map((r) => ({ hash: blocklistHash(r.email), reason: r.reason, createdAt: r.createdAt })))
        .onConflictDoNothing();
      await tx.delete(salesSuppressions).where(inArray(salesSuppressions.email, rows.map((r) => r.email)));
    });
    moved += rows.length;
  }
  if (moved) log.info("vertrieb.blocklist_migrated", { moved });
  legacyDone = true;
  return moved;
}

type Exec = Tx | typeof db;

/** Welche der Adressen stehen auf der Sperrliste? (normalisierte Adressen) */
export async function blockedEmails(emails: string[], exec: Exec = db): Promise<Set<string>> {
  await migrateLegacySuppressions();
  const list = [...new Set(emails.map(normalizeBlockEmail).filter(Boolean))];
  if (!list.length) return new Set();
  const byHash = new Map(list.map((e) => [blocklistHash(e), e]));
  const rows = await exec.select({ h: salesBlocklist.hash }).from(salesBlocklist).where(inArray(salesBlocklist.hash, [...byHash.keys()]));
  return new Set(rows.map((r) => byHash.get(r.h)!));
}

export async function isBlocked(email: string, exec: Exec = db): Promise<boolean> {
  return (await blockedEmails([email], exec)).size > 0;
}

export async function addToBlocklist(exec: Exec, email: string, reason: string) {
  await migrateLegacySuppressions();
  await exec.insert(salesBlocklist).values({ hash: blocklistHash(email), reason }).onConflictDoNothing();
}

/** Abgleich-Menge über alle Prüfwerte (Praxissuche: neue Adressen gegen die Sperrliste prüfen) */
export async function blocklistMatcher(): Promise<{ has(email: string): boolean }> {
  await migrateLegacySuppressions();
  const rows = await db.select({ h: salesBlocklist.hash }).from(salesBlocklist);
  return hashedEmailSet(rows.map((r) => r.h));
}

/** Für die Konsole: Anzahl und letzte Einträge (nur Grund und Datum – Adressen sind nicht gespeichert) */
export async function blocklistOverview() {
  await migrateLegacySuppressions();
  const [{ n }] = await db.select({ n: count() }).from(salesBlocklist);
  const recent = await db.select({ reason: salesBlocklist.reason, createdAt: salesBlocklist.createdAt }).from(salesBlocklist).orderBy(desc(salesBlocklist.createdAt)).limit(50);
  return { count: Number(n), recent };
}
