import "server-only";
import { count, desc, eq, inArray, isNull, and } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { salesBlocklist, salesSettings, salesSuppressions } from "@/db/schema";
import { log } from "@/lib/log";
import {
  BLOCKLIST_KEY_MISMATCH,
  blockEntriesForLead,
  blocklistHash,
  blocklistKeyCheck,
  hashedEmailSet,
  normalizeBlockEmail,
  type BlockMatcher,
} from "@/lib/vertrieb/blocklist";

/**
 * Sperrliste des Vertriebs (Abmeldungen, Widersprüche): nur Prüfwerte (HMAC, src/lib/vertrieb/blocklist.ts) für
 * E-Mail-Adresse, Website-Host und Name+PLZ – keine Adressen. Rechtsgrundlage Art. 6 Abs. 1 lit. f DSGVO
 * (Widerspruch dauerhaft beachten); gelöscht wird die Sperrliste, wenn keine Vertriebs-E-Mails mehr versendet werden.
 * Altbestand (sales_suppressions mit Klartext-Adressen) wird beim ersten Zugriff in Prüfwerte überführt und der
 * Klartext gelöscht (idempotent; der Schlüssel liegt nur in der App, nicht in der Datenbank).
 * Fail-closed: passt der Kanarienwert nicht zum Schlüssel (APP_ENCRYPTION_KEY getauscht), verweigern Versand, Import
 * und Praxissuche (assertBlocklistKey) – sonst wäre die Sperrliste unbemerkt wirkungslos.
 */

type Exec = Tx | typeof db;

export class BlocklistKeyError extends Error {
  constructor() {
    super(BLOCKLIST_KEY_MISMATCH);
    this.name = "BlocklistKeyError";
  }
}

/** Kanarienwert prüfen; beim ersten Aufruf setzen. Wirft BlocklistKeyError bei Abweichung. */
export async function assertBlocklistKey(exec: Exec = db): Promise<void> {
  const expected = blocklistKeyCheck();
  const [row] = await exec.select({ check: salesSettings.blocklistKeyCheck }).from(salesSettings).where(eq(salesSettings.id, 1));
  if (row?.check) {
    if (row.check !== expected) throw new BlocklistKeyError();
    return;
  }
  if (!row) await exec.insert(salesSettings).values({ id: 1, blocklistKeyCheck: expected }).onConflictDoNothing();
  else await exec.update(salesSettings).set({ blocklistKeyCheck: expected }).where(and(eq(salesSettings.id, 1), isNull(salesSettings.blocklistKeyCheck)));
  const [after] = await exec.select({ check: salesSettings.blocklistKeyCheck }).from(salesSettings).where(eq(salesSettings.id, 1));
  if (after?.check !== expected) throw new BlocklistKeyError();
}

/** Für Anzeigen (Vorschau, Konsole): null = in Ordnung, sonst Meldung */
export async function blocklistKeyProblem(): Promise<string | null> {
  try {
    await assertBlocklistKey();
    return null;
  } catch (e) {
    if (e instanceof BlocklistKeyError) return e.message;
    throw e;
  }
}

let legacyDone = false;

/** Klartext-Altbestand in Prüfwerte überführen – mit dem übergebenen Ausführer (Transaktion des Aufrufers). */
export async function migrateLegacySuppressions(exec: Exec = db): Promise<number> {
  if (legacyDone) return 0;
  let moved = 0;
  for (;;) {
    const rows = await exec.select().from(salesSuppressions).orderBy(salesSuppressions.email).limit(500);
    if (!rows.length) break;
    await exec
      .insert(salesBlocklist)
      .values(rows.map((r) => ({ hash: blocklistHash(r.email), kind: "email", reason: r.reason, createdAt: r.createdAt })))
      .onConflictDoNothing();
    await exec.delete(salesSuppressions).where(inArray(salesSuppressions.email, rows.map((r) => r.email)));
    moved += rows.length;
  }
  if (moved) log.info("vertrieb.blocklist_migrated", { moved });
  // nur außerhalb einer Transaktion als erledigt merken (ein Rollback würde die Überführung zurücknehmen)
  if (exec === db) legacyDone = true;
  return moved;
}

/** Welche der Adressen stehen auf der Sperrliste? (normalisierte Adressen) */
export async function blockedEmails(emails: string[], exec: Exec = db): Promise<Set<string>> {
  await migrateLegacySuppressions(exec);
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
  await migrateLegacySuppressions(exec);
  await exec.insert(salesBlocklist).values({ hash: blocklistHash(email), kind: "email", reason }).onConflictDoNothing();
}

/** Abmeldung einer Praxis: Adresse, Website-Host und Name+PLZ als Prüfwerte sperren. */
export async function addLeadToBlocklist(exec: Exec, lead: { email: string | null; website: string | null; name: string; zip: string | null }, reason: string) {
  await migrateLegacySuppressions(exec);
  const entries = blockEntriesForLead(lead);
  if (entries.length) await exec.insert(salesBlocklist).values(entries.map((e) => ({ ...e, reason }))).onConflictDoNothing();
}

/** Abgleich über alle Prüfwerte (Praxissuche, Import: Adresse, Website, Name+PLZ) */
export async function blocklistMatcher(exec: Exec = db): Promise<BlockMatcher> {
  await migrateLegacySuppressions(exec);
  const rows = await exec.select({ h: salesBlocklist.hash }).from(salesBlocklist);
  return hashedEmailSet(rows.map((r) => r.h));
}

/** Für die Konsole: Anzahl und letzte Einträge (nur Art, Grund und Datum – Adressen sind nicht gespeichert) */
export async function blocklistOverview() {
  await migrateLegacySuppressions();
  const [{ n }] = await db.select({ n: count() }).from(salesBlocklist).where(eq(salesBlocklist.kind, "email"));
  const recent = await db
    .select({ reason: salesBlocklist.reason, createdAt: salesBlocklist.createdAt })
    .from(salesBlocklist)
    .where(eq(salesBlocklist.kind, "email"))
    .orderBy(desc(salesBlocklist.createdAt))
    .limit(50);
  return { count: Number(n), recent };
}
