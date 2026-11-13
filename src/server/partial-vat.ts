import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { invoiceLines, invoices } from "@/db/schema";
import { INTERNAL_NOTE_PREFIX } from "@/lib/invoice-labels";
import { computeTotals, remainingVatGroups } from "@/lib/invoice-math";

/**
 * Steuersätze für Zahlungen auf eine (Sammel-)Rechnung mit angerechneten Teilrechnungen (Anzahlungen/Quittungen).
 *
 * Die angerechneten Beträge sind schon bezahlt (und dort mit ihrer USt in Kasse/TSE gebucht). Eine Restzahlung auf die
 * Sammelrechnung darf deshalb nur auf den Rest je Steuersatz verteilt werden – nicht anteilig auf alle Positionen.
 * Dasselbe gilt (mit umgekehrtem Vorzeichen) für Erstattungen auf die Stornorechnung.
 *
 * Nach einem Storno ist die Verknüpfung (collective_invoice_id) wieder gelöst; damit Kassenbons beim Export später
 * gleich bleiben, steht in der Stornorechnung eine interne Notiz mit den Nummern der angerechneten Belege.
 */
export const STORNO_RECEIPTS_NOTE = "Angerechnete Quittungen: ";
export const STORNO_DEPOSITS_NOTE = "Angerechnete Anzahlungen: ";

/**
 * Nur die vom System geschriebenen Zeilen: Zeile 1 ist „Storno zu … Grund: …“ (Freitext, ohne Zeilenumbrüche – siehe
 * cancelInvoice), die internen Zeilen folgen danach; maßgeblich ist die letzte passende Zeile.
 */
function numbersFrom(notes: string | null, label: string): string[] {
  const line = (notes ?? "")
    .split("\n")
    .slice(1)
    .findLast((l) => l.startsWith(`${INTERNAL_NOTE_PREFIX}${label}`));
  if (!line) return [];
  return line
    .slice(INTERNAL_NOTE_PREFIX.length + label.length)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Nummern der in der stornierten Sammelrechnung angerechneten normalen Quittungen (interne Notiz der Stornorechnung) */
export const stornoReceiptNumbers = (notes: string | null) => numbersFrom(notes, STORNO_RECEIPTS_NOTE);
/** Nummern der in der stornierten Rechnung angerechneten Anzahlungen (interne Notiz der Stornorechnung) */
export const stornoDepositNumbers = (notes: string | null) => numbersFrom(notes, STORNO_DEPOSITS_NOTE);

type Group = { rate: number; grossCents: number };

/**
 * Bruttobeträge je Steuersatz, auf die sich Zahlungen der Rechnungen verteilen: eigene Positionen abzüglich
 * angerechneter Teilrechnungen. Rechnungen ohne Anrechnung: einfach ihre Positionen (wie bisher).
 */
export async function payableVatGroups(tx: Tx, org: string, invoiceIds: string[]): Promise<Map<string, Group[]>> {
  const out = new Map<string, Group[]>();
  const ids = [...new Set(invoiceIds)];
  if (!ids.length) return out;
  const own = await tx
    .select({ invoiceId: invoiceLines.invoiceId, totalCents: invoiceLines.totalCents, vatRate: invoiceLines.vatRate })
    .from(invoiceLines)
    .where(and(eq(invoiceLines.organizationId, org), inArray(invoiceLines.invoiceId, ids)));
  for (const id of ids) out.set(id, computeTotals(own.filter((l) => l.invoiceId === id)).groups.map((g) => ({ rate: g.rate, grossCents: g.grossCents })));

  const heads = await tx
    .select({ id: invoices.id, kind: invoices.kind, status: invoices.status, notes: invoices.notes })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), inArray(invoices.id, ids)));
  // Teilrechnung → (Rechnung, Vorzeichen)
  const credit: { partialId: string; target: string; sign: number }[] = [];
  const linked = await tx
    .select({ id: invoices.id, target: invoices.collectiveInvoiceId })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), inArray(invoices.collectiveInvoiceId, ids), inArray(invoices.kind, ["deposit", "receipt"])));
  for (const l of linked) credit.push({ partialId: l.id, target: l.target!, sign: 1 });

  // Storno: Nummern aus der Stornorechnung (für die Stornorechnung selbst und für die stornierte Rechnung)
  const byNumber: { number: string; target: string; sign: number }[] = [];
  const noteOf = (notes: string | null) => [...stornoReceiptNumbers(notes), ...stornoDepositNumbers(notes)];
  for (const h of heads.filter((x) => x.kind === "credit_note")) for (const n of noteOf(h.notes)) byNumber.push({ number: n, target: h.id, sign: -1 });
  const cancelledIds = heads.filter((h) => h.status === "cancelled" && !linked.some((l) => l.target === h.id)).map((h) => h.id);
  if (cancelledIds.length) {
    const cns = await tx
      .select({ cancels: invoices.cancelsInvoiceId, notes: invoices.notes })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), inArray(invoices.cancelsInvoiceId, cancelledIds)));
    for (const c of cns) for (const n of noteOf(c.notes)) byNumber.push({ number: n, target: c.cancels!, sign: 1 });
  }
  if (byNumber.length) {
    const rows = await tx
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.organizationId, org), inArray(invoices.kind, ["deposit", "receipt"]), inArray(invoices.number, [...new Set(byNumber.map((b) => b.number))])));
    for (const b of byNumber) {
      const r = rows.find((x) => x.number === b.number);
      if (r) credit.push({ partialId: r.id, target: b.target, sign: b.sign });
    }
  }
  if (!credit.length) return out;

  const partialLines = await tx
    .select({ invoiceId: invoiceLines.invoiceId, totalCents: invoiceLines.totalCents, vatRate: invoiceLines.vatRate })
    .from(invoiceLines)
    .where(and(eq(invoiceLines.organizationId, org), inArray(invoiceLines.invoiceId, [...new Set(credit.map((c) => c.partialId))])));
  for (const id of ids) {
    const mine = credit.filter((c) => c.target === id);
    if (!mine.length) continue;
    const credited = mine.flatMap((c) =>
      computeTotals(partialLines.filter((l) => l.invoiceId === c.partialId)).groups.map((g) => ({ rate: g.rate, grossCents: g.grossCents * c.sign })),
    );
    const rest = remainingVatGroups(out.get(id) ?? [], credited);
    const sign = Math.sign((out.get(id) ?? []).reduce((s, g) => s + g.grossCents, 0)) || 1;
    // Rest passt nicht zum Vorzeichen (Altbestand mit abweichenden Steuersätzen) → wie bisher über alle Positionen
    if (rest.length && rest.every((g) => Math.sign(g.grossCents) === sign)) out.set(id, rest);
  }
  return out;
}
