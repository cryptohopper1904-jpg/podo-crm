import "server-only";
import { and, eq, isNotNull, ne, notExists, sql, type SQL } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { archiveCatchupAttempts, documentArchive, invoices, organizations, paymentReceipts } from "@/db/schema";
import { log } from "@/lib/log";
import { reportToInbox } from "./document-archive";
import { ensureInvoiceArchived } from "./invoice-delivery";
import { archiveReceipt } from "./payment-receipts";

/**
 * Nachhol-Lauf für das Beleg-Archiv (Cron und vor dem Praxis-Export): Belege mit Momentaufnahme (ab Einführung des
 * Archivs) und Zahlungsbelege, deren PDF bei der Ausstellung bzw. Buchung nicht abgelegt werden konnte, werden aus
 * den festgeschriebenen Angaben erzeugt und archiviert. Altbelege ohne Momentaufnahme bleiben „Reproduktion“.
 *
 * - je Beleg eigene Transaktion (idempotent, Advisory-Lock), je Praxis eigener Fehlerpfad
 * - Zeitbudget je Lauf (Cron); was nicht mehr passt, kommt im nächsten Lauf dran
 * - Fehlversuche in archive_catchup_attempts: Backoff (2^Versuche Minuten, höchstens 24 h), ältester Versuch zuerst;
 *   nach Erfolg wird der Eintrag gelöscht. Fehler werden protokolliert und einmal je Beleg gemeldet.
 */
export type CatchUpResult = {
  invoices: { ok: number; failed: number };
  receipts: { ok: number; failed: number };
  /** Praxen, deren Lauf mit einem Fehler abbrach */
  orgErrors: number;
  /** Zeitbudget erschöpft – Rest im nächsten Lauf */
  truncated: boolean;
};

type Target = { kind: "invoice" | "payment_receipt"; id: string; number: string | null };

/** Backoff-Bedingung: noch kein Versuch, oder der letzte liegt lange genug zurück */
const dueAfterBackoff = (): SQL =>
  sql`(${archiveCatchupAttempts.lastAttemptAt} is null or ${archiveCatchupAttempts.lastAttemptAt} + least(interval '1 minute' * power(2, least(${archiveCatchupAttempts.attempts}, 12)), interval '24 hours') <= now())`;

/**
 * Fehlende Archiv-PDFs einer Praxis (ältester Nachhol-Versuch zuerst). `respectBackoff`: nur fällige (Cron).
 */
export async function missingArchives(org: string, limit = 200, opts: { respectBackoff?: boolean } = {}) {
  return withOrg(org, async (tx) => {
    const attemptJoin = (kind: string, idCol: typeof invoices.id | typeof paymentReceipts.id) =>
      and(eq(archiveCatchupAttempts.organizationId, org), eq(archiveCatchupAttempts.targetKind, kind), eq(archiveCatchupAttempts.targetId, idCol));
    const order = sql`${archiveCatchupAttempts.lastAttemptAt} asc nulls first`;
    const inv = await tx
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .leftJoin(archiveCatchupAttempts, attemptJoin("invoice", invoices.id))
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
          opts.respectBackoff ? dueAfterBackoff() : undefined,
        ),
      )
      .orderBy(order, invoices.createdAt)
      .limit(limit);
    const rec = await tx
      .select({ id: paymentReceipts.id, number: paymentReceipts.number })
      .from(paymentReceipts)
      .leftJoin(archiveCatchupAttempts, attemptJoin("payment_receipt", paymentReceipts.id))
      .where(
        and(
          eq(paymentReceipts.organizationId, org),
          notExists(
            tx
              .select({ x: sql`1` })
              .from(documentArchive)
              .where(and(eq(documentArchive.organizationId, org), eq(documentArchive.paymentReceiptId, paymentReceipts.id), eq(documentArchive.kind, "payment_receipt"))),
          ),
          opts.respectBackoff ? dueAfterBackoff() : undefined,
        ),
      )
      .orderBy(order, paymentReceipts.createdAt)
      .limit(limit);
    return { invoices: inv, receipts: rec };
  });
}

async function recordAttempt(org: string, t: Target, ok: boolean, error?: unknown) {
  try {
    await withOrg(org, async (tx) => {
      if (ok) {
        await tx
          .delete(archiveCatchupAttempts)
          .where(and(eq(archiveCatchupAttempts.organizationId, org), eq(archiveCatchupAttempts.targetKind, t.kind), eq(archiveCatchupAttempts.targetId, t.id)));
        return;
      }
      const msg = (error instanceof Error ? error.message : String(error ?? "unbekannt")).slice(0, 300);
      await tx
        .insert(archiveCatchupAttempts)
        .values({ organizationId: org, targetKind: t.kind, targetId: t.id, attempts: 1, lastAttemptAt: new Date(), lastError: msg })
        .onConflictDoUpdate({
          target: [archiveCatchupAttempts.organizationId, archiveCatchupAttempts.targetKind, archiveCatchupAttempts.targetId],
          set: { attempts: sql`${archiveCatchupAttempts.attempts} + 1`, lastAttemptAt: new Date(), lastError: msg },
        });
    });
  } catch (e) {
    log.error("archive.catchup_attempt_record_failed", { error: e });
  }
}

async function catchUpOne(org: string, t: Target): Promise<boolean> {
  let error: unknown = null;
  try {
    const ok = t.kind === "invoice" ? await ensureInvoiceArchived(org, t.id) : await archiveReceipt(org, t.id, null, { catchUp: true });
    if (!ok) error = new Error("Beleg nicht archivierbar (Angaben fehlen)");
  } catch (e) {
    error = e;
  }
  await recordAttempt(org, t, !error, error);
  if (error) {
    log.error("archive.catchup_failed", { error, kind: t.kind, id: t.id });
    const label = t.kind === "invoice" ? `Beleg ${t.number ?? ""}` : `Zahlungsbeleg ${t.number ?? ""}`;
    await reportToInbox(
      org,
      `${t.kind === "invoice" ? "beleg-archiv" : "zb-archiv"}:${t.id}`,
      `${label}: PDF konnte nicht archiviert werden`,
      `Das PDF (${label}) konnte auch im Nachhol-Lauf nicht archiviert werden; es wird mit wachsendem Abstand erneut versucht. Bis dahin wird es nicht ausgehändigt. Bleibt der Fehler, bitte den Support kontaktieren.`,
    );
  }
  return !error;
}

export async function catchUpArchives(
  opts: {
    organizationIds?: string[];
    limitPerOrg?: number;
    budgetMs?: number;
    respectBackoff?: boolean;
    /**
     * Startposition in der Praxisliste (Cron: je Lauf zufällig), damit bei knappem Zeitbudget nicht immer dieselben
     * Praxen zuerst drankommen und spätere leer ausgehen. Ohne Angabe: von vorn.
     */
    startAt?: number;
  } = {},
): Promise<CatchUpResult> {
  const out: CatchUpResult = { invoices: { ok: 0, failed: 0 }, receipts: { ok: 0, failed: 0 }, orgErrors: 0, truncated: false };
  const started = Date.now();
  const overBudget = () => opts.budgetMs !== undefined && Date.now() - started > opts.budgetMs;
  const all = opts.organizationIds?.map((id) => ({ id })) ?? (await db.select({ id: organizations.id }).from(organizations).orderBy(organizations.id));
  const start = all.length && opts.startAt ? ((Math.trunc(opts.startAt) % all.length) + all.length) % all.length : 0;
  const orgs = [...all.slice(start), ...all.slice(0, start)];
  for (const { id: org } of orgs) {
    if (overBudget()) {
      out.truncated = true;
      break;
    }
    try {
      const missing = await missingArchives(org, opts.limitPerOrg ?? 50, { respectBackoff: opts.respectBackoff });
      const targets: Target[] = [
        ...missing.invoices.map((i) => ({ kind: "invoice" as const, id: i.id, number: i.number })),
        ...missing.receipts.map((r) => ({ kind: "payment_receipt" as const, id: r.id, number: r.number })),
      ];
      for (const t of targets) {
        if (overBudget()) {
          out.truncated = true;
          break;
        }
        const bucket = t.kind === "invoice" ? out.invoices : out.receipts;
        if (await catchUpOne(org, t)) bucket.ok++;
        else bucket.failed++;
      }
    } catch (e) {
      // eine Praxis bricht nicht den ganzen Lauf ab
      out.orgErrors++;
      log.error("archive.catchup_org_failed", { error: e, organizationId: org });
    }
  }
  return out;
}
