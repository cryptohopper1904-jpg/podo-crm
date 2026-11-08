import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { numberSequences } from "@/db/schema";

const PREFIX: Record<string, string> = {
  invoice: "R",
  receipt: "Q",
  collective: "SR",
  credit_note: "GS",
  no_show_fee: "R",
  voucher: "G",
};

/**
 * Lückenloser, fortlaufender Nummernkreis je Praxis, Art und Jahr (GoBD).
 * Atomar per UPSERT … RETURNING innerhalb der laufenden Transaktion.
 * Format: R2026-0001
 */
export async function nextNumber(tx: Tx, organizationId: string, kind: keyof typeof PREFIX, year: number) {
  const key = kind === "no_show_fee" ? "invoice" : kind;
  const rows = await tx
    .insert(numberSequences)
    .values({ organizationId, key, year, next: 2 })
    .onConflictDoUpdate({
      target: [numberSequences.organizationId, numberSequences.key, numberSequences.year],
      set: { next: sql`${numberSequences.next} + 1` },
    })
    .returning({ next: numberSequences.next });
  const n = rows[0].next - 1;
  return `${PREFIX[kind]}${year}-${String(n).padStart(4, "0")}`;
}

/** Setzt den Zähler mindestens auf `min` (z. B. nach Import alter Nummern). */
export async function ensureSequenceAtLeast(tx: Tx, organizationId: string, key: string, year: number, min: number) {
  const [row] = await tx
    .select()
    .from(numberSequences)
    .where(and(eq(numberSequences.organizationId, organizationId), eq(numberSequences.key, key), eq(numberSequences.year, year)));
  if (!row) await tx.insert(numberSequences).values({ organizationId, key, year, next: min });
  else if (row.next < min) await tx.update(numberSequences).set({ next: min }).where(eq(numberSequences.id, row.id));
}
