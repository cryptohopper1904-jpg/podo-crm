import "server-only";
import { and, eq, isNotNull, ne, notExists, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { documentArchive, invoices, organizations, paymentReceipts } from "@/db/schema";
import { log } from "@/lib/log";
import { reportToInbox } from "./document-archive";
import { ensureInvoiceArchived } from "./invoice-delivery";
import { archiveReceipt } from "./payment-receipts";

/**
 * Nachhol-Lauf für das Beleg-Archiv (Cron und vor dem Praxis-Export): Belege mit Momentaufnahme (ab Einführung des
 * Archivs) und Zahlungsbelege, deren PDF bei der Ausstellung bzw. Buchung nicht abgelegt werden konnte, werden aus
 * den festgeschriebenen Angaben erzeugt und archiviert. Altbelege ohne Momentaufnahme bleiben „Reproduktion“.
 * Je Beleg eigene Transaktion (idempotent, Advisory-Lock); Fehler werden protokolliert und einmal je Beleg gemeldet.
 */
export type CatchUpResult = { invoices: { ok: number; failed: number }; receipts: { ok: number; failed: number } };

export async function missingArchives(org: string, limit = 200) {
  return withOrg(org, async (tx) => {
    const inv = await tx
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, org),
          ne(invoices.status, "draft"),
          isNotNull(invoices.number),
          isNotNull(invoices.issuedSnapshot),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(documentArchive)
              .where(and(eq(documentArchive.organizationId, org), eq(documentArchive.invoiceId, invoices.id), eq(documentArchive.kind, "invoice"))),
          ),
        ),
      )
      .limit(limit);
    const rec = await tx
      .select({ id: paymentReceipts.id, number: paymentReceipts.number })
      .from(paymentReceipts)
      .where(
        and(
          eq(paymentReceipts.organizationId, org),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(documentArchive)
              .where(and(eq(documentArchive.organizationId, org), eq(documentArchive.paymentReceiptId, paymentReceipts.id), eq(documentArchive.kind, "payment_receipt"))),
          ),
        ),
      )
      .limit(limit);
    return { invoices: inv, receipts: rec };
  });
}

export async function catchUpArchives(opts: { organizationIds?: string[]; limitPerOrg?: number } = {}): Promise<CatchUpResult> {
  const out: CatchUpResult = { invoices: { ok: 0, failed: 0 }, receipts: { ok: 0, failed: 0 } };
  const orgs = opts.organizationIds?.map((id) => ({ id })) ?? (await db.select({ id: organizations.id }).from(organizations));
  for (const { id: org } of orgs) {
    const missing = await missingArchives(org, opts.limitPerOrg ?? 50);
    for (const i of missing.invoices) {
      try {
        if (await ensureInvoiceArchived(org, i.id)) out.invoices.ok++;
        else out.invoices.failed++;
      } catch (e) {
        out.invoices.failed++;
        log.error("archive.catchup_invoice_failed", { error: e, invoiceId: i.id });
        await reportToInbox(org, `beleg-archiv:${i.id}`, `Beleg ${i.number ?? ""}: PDF konnte nicht archiviert werden`, `Das PDF des Belegs ${i.number ?? ""} konnte auch im Nachhol-Lauf nicht archiviert werden. Bitte den Support kontaktieren.`);
      }
    }
    for (const r of missing.receipts) {
      try {
        if (await archiveReceipt(org, r.id, null)) out.receipts.ok++;
        else out.receipts.failed++;
      } catch (e) {
        out.receipts.failed++;
        log.error("archive.catchup_receipt_failed", { error: e, receipt: r.number });
        await reportToInbox(org, `zb-archiv:${r.id}`, `Zahlungsbeleg ${r.number}: PDF konnte nicht abgelegt werden`, `Das PDF des Zahlungsbelegs ${r.number} konnte auch im Nachhol-Lauf nicht archiviert werden. Bitte den Support kontaktieren.`);
      }
    }
  }
  return out;
}
