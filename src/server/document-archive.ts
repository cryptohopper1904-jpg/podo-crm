import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { documentArchive } from "@/db/schema";
import { log } from "@/lib/log";
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";

/**
 * Beleg-Archiv (GoBD, § 14b UStG): Das beim Ausstellen erzeugte PDF wird verschlüsselt in der Dateiablage gespeichert
 * (src/lib/storage.ts, AES-256-GCM je Praxis) und in document_archive mit SHA-256 des Klartexts verzeichnet – in der
 * Transaktion des Ausstellens. Die Datei wird VOR dem Eintrag geschrieben; scheitert die Transaktion danach, räumt
 * `withArchiveCleanup` nur die Dateien weg, die nachweislich NICHT in document_archive verzeichnet sind (eigene
 * Abfrage nach dem Fehler – z. B. bei einem Fehler erst beim COMMIT bleibt eine verzeichnete Datei erhalten). Was
 * dabei übrig bleibt (Abfrage scheitert, Prozessabbruch), findet scripts/archive-orphans.ts.
 * Die Aufbewahrungsfrist wird zur Laufzeit berechnet (src/lib/retention.ts), nicht gespeichert.
 * Abruf prüft die Prüfsumme – ein beschädigtes Archiv wird nie stillschweigend durch eine Neuerzeugung ersetzt.
 */
export class ArchiveIntegrityError extends Error {}

export type ArchiveKind = "invoice" | "payment_receipt";
export type ArchiveRow = typeof documentArchive.$inferSelect;

/** Sammelt die in einer Transaktion geschriebenen Dateien, um sie bei einem Fehler wieder zu entfernen. */
export type PendingFiles = string[];

export async function withArchiveCleanup<T>(org: string, fn: (pending: PendingFiles) => Promise<T>): Promise<T> {
  const pending: PendingFiles = [];
  try {
    return await fn(pending);
  } catch (e) {
    if (pending.length) await discardUnreferenced(org, pending);
    throw e;
  }
}

/** Entfernt nur Dateien, die in document_archive nicht verzeichnet sind; im Zweifel (Abfrage scheitert) bleibt alles. */
async function discardUnreferenced(org: string, keys: string[]) {
  try {
    const referenced = new Set(
      (
        await withOrg(org, (tx) =>
          tx
            .select({ key: documentArchive.storageKey })
            .from(documentArchive)
            .where(and(eq(documentArchive.organizationId, org), inArray(documentArchive.storageKey, keys))),
        )
      ).map((r) => r.key),
    );
    await Promise.all(keys.filter((k) => !referenced.has(k)).map((k) => discardStored(k).catch(() => undefined)));
  } catch (e) {
    log.warn("archive.cleanup_skipped", { error: e, files: keys.length });
  }
}

/** Speicherschlüssel liegt im Ablagebereich der Praxis („<org>/…“) – wie der DB-Constraint, zusätzlich beim Lesen. */
export const keyBelongsTo = (storageKey: string, org: string) => storageKey.startsWith(`${org}/`) && !storageKey.includes("..");

export async function archivePdf(
  tx: Tx,
  org: string,
  entry: {
    kind: ArchiveKind;
    invoiceId: string;
    paymentReceiptId?: string | null;
    bytes: Uint8Array;
    filename: string;
    userId: string | null;
  },
  pending: PendingFiles,
): Promise<ArchiveRow> {
  const stored = await storeEncrypted(org, Buffer.from(entry.bytes));
  pending.push(stored.storageKey);
  const [row] = await tx
    .insert(documentArchive)
    .values({
      organizationId: org,
      kind: entry.kind,
      invoiceId: entry.invoiceId,
      paymentReceiptId: entry.paymentReceiptId ?? null,
      storageKey: stored.storageKey,
      mime: "application/pdf",
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      filename: entry.filename,
      createdBy: entry.userId,
    })
    .returning();
  return row;
}

export async function findInvoiceArchive(tx: Tx, org: string, invoiceId: string): Promise<ArchiveRow | null> {
  const [row] = await tx
    .select()
    .from(documentArchive)
    .where(and(eq(documentArchive.organizationId, org), eq(documentArchive.invoiceId, invoiceId), eq(documentArchive.kind, "invoice")));
  return row ?? null;
}

export async function findReceiptArchives(tx: Tx, org: string, invoiceId: string): Promise<ArchiveRow[]> {
  return tx
    .select()
    .from(documentArchive)
    .where(and(eq(documentArchive.organizationId, org), eq(documentArchive.invoiceId, invoiceId), eq(documentArchive.kind, "payment_receipt")))
    .orderBy(asc(documentArchive.createdAt));
}

/** Liest das archivierte PDF und prüft Größe und SHA-256 (byte-gleich wie beim Ausstellen). */
export async function readArchivedPdf(row: Pick<ArchiveRow, "id" | "storageKey" | "sha256" | "sizeBytes" | "organizationId">): Promise<Uint8Array> {
  if (!keyBelongsTo(row.storageKey, row.organizationId)) {
    log.error("archive.foreign_key", { archiveId: row.id });
    throw new ArchiveIntegrityError("Der archivierte Beleg ist ungültig verzeichnet. Bitte den Support kontaktieren.");
  }
  let buf: Buffer;
  try {
    buf = await readDecrypted(row.storageKey);
  } catch (e) {
    log.error("archive.read_failed", { error: e, archiveId: row.id });
    throw new ArchiveIntegrityError("Der archivierte Beleg kann nicht gelesen werden. Bitte den Support kontaktieren.");
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== row.sha256 || buf.length !== row.sizeBytes) {
    log.error("archive.checksum_mismatch", { archiveId: row.id });
    throw new ArchiveIntegrityError("Der archivierte Beleg ist beschädigt (Prüfsumme stimmt nicht). Bitte den Support kontaktieren.");
  }
  return new Uint8Array(buf);
}
