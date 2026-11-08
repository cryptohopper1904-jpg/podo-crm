/**
 * Hash-Kette der Kassenabschlüsse (Z-Bons) – ohne weitere Abhängigkeiten, damit auch scripts/verify-hash-chains.ts
 * (Wiederherstellungs-Test, deploy/Dockerfile.migrate) denselben Code verwendet wie die App.
 */
import { chainHash } from "../records";

/** Inhalt eines Abschlusses, der in die Hash-Kette eingeht (Reihenfolge egal – canonical sortiert die Schlüssel). */
export function closingHashContent(c: {
  id: string;
  organizationId: string;
  number: number;
  businessDate: string;
  closedAt: Date;
  createdAt: Date;
  openingCents: number;
  cashPaymentsCents: number;
  movementsCents: number;
  expectedCashCents: number;
  countedCashCents: number;
  differenceCents: number;
  denominations: Record<string, number>;
  totals: unknown;
  paymentCount: number;
  movementCount: number;
  firstBonNr: number;
  lastBonNr: number;
  itemsDigest: string;
  tse: unknown;
  differenceReason: string | null;
  note: string | null;
  createdBy: string | null;
  /** Snapshot der Bons (ab Migration 0016); bei Altbeständen nicht angeben (undefined), sonst ändert sich der Hash */
  bons?: unknown[] | null;
}): Record<string, unknown> {
  // JSON-Rundreise: identisch zu dem, was aus jsonb/timestamptz zurückkommt (undefined entfällt, Datum → ISO)
  return JSON.parse(JSON.stringify({ ...c, closedAt: c.closedAt.toISOString(), createdAt: c.createdAt.toISOString() })) as Record<string, unknown>;
}

/** Zeile aus cash_closings (Drizzle-Form) – nur die für die Hash-Kette nötigen Felder. */
export type ClosingChainRow = Parameters<typeof closingHashContent>[0] & { prevHash: string | null; hash: string };

export const closingRowContent = (r: ClosingChainRow) =>
  closingHashContent({
    id: r.id,
    organizationId: r.organizationId,
    number: r.number,
    businessDate: r.businessDate,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
    openingCents: r.openingCents,
    cashPaymentsCents: r.cashPaymentsCents,
    movementsCents: r.movementsCents,
    expectedCashCents: r.expectedCashCents,
    countedCashCents: r.countedCashCents,
    differenceCents: r.differenceCents,
    denominations: r.denominations,
    totals: r.totals,
    paymentCount: r.paymentCount,
    movementCount: r.movementCount,
    firstBonNr: r.firstBonNr,
    lastBonNr: r.lastBonNr,
    itemsDigest: r.itemsDigest,
    tse: r.tse,
    differenceReason: r.differenceReason,
    note: r.note,
    createdBy: r.createdBy,
    bons: r.bons ?? undefined,
  });

/**
 * Prüft die Kette der Abschlüsse EINER Praxis (nach Z-Nummer sortiert, ab Z 1): lückenlose Nummern, Verkettung,
 * Inhalts-Hash und fortlaufende Belegnummern. Index des ersten ungültigen Eintrags, -1 wenn alles stimmt.
 */
export function verifyClosingRows(rows: ClosingChainRow[]): number {
  let prev: string | null = null;
  let lastBon = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.number !== i + 1 || r.prevHash !== prev || chainHash(prev, closingRowContent(r)) !== r.hash) return i;
    if (r.firstBonNr !== lastBon + 1 || r.lastBonNr < r.firstBonNr - 1) return i;
    prev = r.hash;
    lastBon = r.lastBonNr;
  }
  return -1;
}
