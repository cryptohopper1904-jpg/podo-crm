import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { documentArchive } from "@/db/schema";
import { retainUntilFor } from "@/lib/invoice-snapshot";
import { log } from "@/lib/log";
import { discardStored, readDecrypted, storeEncrypted } from "@/lib/storage";

/**
 * Beleg-Archiv (GoBD, § 14b UStG): Das beim Ausstellen erzeugte PDF wird verschlüsselt in der Dateiablage gespeichert
 * (src/lib/storage.ts, AES-256-GCM je Praxis) und in document_archive mit SHA-256 des Klartexts verzeichnet – in der
 * Transaktion des Ausstellens. Die Datei wird VOR dem Eintrag geschrieben; scheitert die Transaktion danach, räumt
 * `withArchiveCleanup` die nicht verzeichneten Dateien wieder weg (unverzeichnete Dateien wären harmlos, aber Ballast).
 * Abruf prüft die Prüfsumme – ein beschädigtes Archiv wird nie stillschweigend durch eine Neuerzeugung ersetzt.
 */
export class ArchiveIntegrityError extends Error {}

export type ArchiveKind = "invoice" | "payment_receipt";
export type ArchiveRow = typeof documentArchive.$inferSelect;

/** Sammelt die in einer Transaktion geschriebenen Dateien, um sie bei einem Fehler wieder zu entfernen. */
export type PendingFiles = string[];

export async function withArchiveCleanup<T>(fn: (pending: PendingFiles) => Promise<T>): Promise<T> {
  const pending: PendingFiles = [];
  try {
    return await fn(pending);
  } catch (e) {
    await Promise.all(pending.map((k) => discardStored(k).catch(() => undefined)));
    throw e;
  }
}

export async function archivePdf(
  tx: Tx,
  org: string,
  entry: {
    kind: ArchiveKind;
    invoiceId: string;
    paymentReceiptId?: string | null;
    bytes: Uint8Array;
    filename: string;
    /** Ausstellungstag (YYYY-MM-DD) – Grundlage der Aufbewahrungsfrist */
    issuedAt: string;
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
      retainUntil: retainUntilFor(entry.issuedAt),
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
