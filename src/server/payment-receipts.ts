import "server-only";
import { and, asc, eq, gte, inArray, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { archiveCatchupAttempts, billingContacts, fiscalTransactions, invoices, messages, organizations, patients, paymentReceipts, payments, vouchers } from "@/db/schema";
import { MailNotConfiguredError, MailSendError } from "@/integrations/mail/mail";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { INVOICE_DOC_LABEL } from "@/lib/invoice-labels";
import { buildInvoiceSnapshot, readInvoiceSnapshot } from "@/lib/invoice-snapshot";
import { invoiceRecipient, paidAtIssue } from "@/lib/invoice-view";
import { isRegisterMethod, REGISTER_METHODS } from "@/lib/kasse/model";
import { nextNumber } from "@/lib/numbering";
import {
  PAYMENT_RECEIPT_VERSION,
  PAYMENT_RECEIPTS_SINCE,
  paymentReceiptFilename,
  paymentReceiptTitle,
  readPaymentReceiptSnapshot,
  renderPaymentReceiptPdf,
  type PaymentReceiptSnapshot,
} from "@/lib/payment-receipt";
import { invoiceBookingLink, practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { log } from "@/lib/log";
import { ArchivePendingError, archivePdf, findReceiptArchives, readArchivedPdf, reportToInbox, withArchiveCleanup } from "./document-archive";
import { logSync } from "./integrations";
import { mailMessagingPort } from "./mail";
import { loadLogos } from "./practice-logos";

/**
 * Belege über Zahlungseingänge nach Ausstellung (§ 146a Abs. 2 AO, § 6 KassenSichV): Nach „Zahlung erfassen“ (bar,
 * Karte, Gutschein) und nach einer SumUp-Terminalzahlung entsteht je Kassenvorgang ein eigener Beleg mit laufender
 * Nummer („ZB2026-0001“), der auf die Rechnung verweist (kein neuer USt-Ausweis) und die TSE-Angaben aus
 * fiscal_transactions trägt. Angaben und PDF werden in derselben Transaktion wie die Zahlung festgeschrieben bzw.
 * archiviert (document_archive). Zahlungen beim Ausstellen stehen dagegen auf dem Beleg selbst (mit TSE-Angaben).
 */
export class PaymentReceiptError extends Error {}

/**
 * Legt für die angegebenen (eben gebuchten) Zahlungen einer ausgestellten Rechnung die Zahlungsbelege an – IN der
 * Buchungstransaktion, aber nur als Datenzeile (Nummer + festgeschriebene Angaben); kein Rendern, keine Datei.
 * So kann ein Ablage-/Schlüssel-/Renderfehler die Zahlung (und ihre TSE-Signatur) nie verhindern. Das PDF erzeugt
 * und archiviert danach `archivePaymentReceipts` (wiederholbar; Nachholen beim Abruf).
 * Nur Kassenvorgänge (Bar/Karte/Gutschein); Überweisung/Zahlungslink brauchen keinen Kassenbeleg.
 * Die Rechnung muss in der laufenden Transaktion bereits gesperrt und paid_cents aktualisiert sein.
 */
export async function recordPaymentReceipts(tx: Tx, org: string, invoiceId: string, paymentIds: string[], userId: string | null, opts: { belated?: boolean } = {}) {
  if (!paymentIds.length) return [];
  const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
  if (!inv?.number) return [];
  const pays = await tx
    .select({ payment: payments, voucherCode: vouchers.code, fiscal: fiscalTransactions })
    .from(payments)
    .leftJoin(vouchers, eq(vouchers.id, payments.voucherId))
    .leftJoin(fiscalTransactions, eq(fiscalTransactions.paymentId, payments.id))
    .where(and(eq(payments.organizationId, org), eq(payments.invoiceId, invoiceId), inArray(payments.id, paymentIds)));
  // Reihenfolge wie gebucht (paymentIds), nicht nach paid_at (in einer Transaktion gleich)
  pays.sort((a, b) => paymentIds.indexOf(a.payment.id) - paymentIds.indexOf(b.payment.id));
  const register = pays.filter((p) => isRegisterMethod(p.payment.method));
  if (!register.length) return [];

  const [o] = await tx.select().from(organizations).where(eq(organizations.id, org));
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const docSettings = readDocumentSettings(settings);
  // Praxisangaben wie heute (der Zahlungsbeleg ist ein neuer Beleg); Empfänger:in wie auf der Rechnung
  const orgSnap = buildInvoiceSnapshot({
    organization: o,
    letter: { website: practiceWebsite(settings), qualification: docSettings.qualification, whatsapp: docSettings.whatsapp },
    booking: invoiceBookingLink(settings, { slug: o.slug, publicUrl: process.env.PUBLIC_URL }),
    patient: null,
    billingContact: null,
  }).organization;
  const invSnap = readInvoiceSnapshot(inv.issuedSnapshot);
  // Steuerlicher Status (Kleinunternehmer) wie auf der Rechnung, nicht wie heute – der Zahlungsbeleg verweist auf sie
  const receiptOrg = { ...orgSnap, smallBusiness: invSnap ? invSnap.organization.smallBusiness : orgSnap.smallBusiness };
  const patient = invSnap?.patient ?? (inv.patientId ? (await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))))[0] ?? null : null);
  const billing = invSnap ? invSnap.billingContact : inv.billingContactId
    ? (await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))))[0] ?? null
    : null;
  const recipient = patient || billing ? { name: invoiceRecipient(patient, billing).name, patientNumber: patient?.number ?? null } : null;

  // Stand nach der jeweiligen Zahlung: vom aktuellen paid_cents rückwärts (alle eben gebuchten Zahlungen – auch
  // Überweisungen derselben Erfassung – sind bereits enthalten)
  const batchLaterSum = (id: string) => pays.slice(pays.findIndex((p) => p.payment.id === id) + 1).reduce((s, p) => s + p.payment.amountCents, 0);
  // nachträglich: Stand nach dieser Zahlung über ALLE Zahlungen der Rechnung (spätere Zahlungen herausrechnen)
  const all = opts.belated
    ? await tx.select({ id: payments.id, paidAt: payments.paidAt, amountCents: payments.amountCents }).from(payments).where(and(eq(payments.organizationId, org), eq(payments.invoiceId, invoiceId)))
    : [];
  const allLaterSum = (p: { id: string; paidAt: Date }) =>
    all.filter((x) => x.paidAt > p.paidAt || (x.paidAt.getTime() === p.paidAt.getTime() && x.id > p.id)).reduce((s, x) => s + x.amountCents, 0);
  const laterSum = (id: string) => {
    if (!opts.belated) return batchLaterSum(id);
    const p = all.find((x) => x.id === id);
    return p ? allLaterSum(p) : 0;
  };
  const out: { id: string; number: string }[] = [];
  for (const p of register) {
    const issuedAt = new Date();
    const number = await nextNumber(tx, org, "payment_receipt", Number(berlinDateIso(issuedAt).slice(0, 4)));
    const f = p.fiscal;
    const data: PaymentReceiptSnapshot = {
      v: PAYMENT_RECEIPT_VERSION,
      organization: receiptOrg,
      recipient,
      invoice: { id: inv.id, number: inv.number, kind: inv.kind, issuedAt: inv.issuedAt, totalCents: inv.totalCents },
      payment: { id: p.payment.id, paidAt: new Date(p.payment.paidAt).toISOString(), method: p.payment.method, amountCents: p.payment.amountCents, voucherCode: p.voucherCode ?? null },
      openAfterCents: inv.totalCents - (inv.paidCents - laterSum(p.payment.id)),
      fiscal: f
        ? {
            vendor: f.vendor,
            tssSerial: f.tssSerial,
            txNumber: f.txNumber,
            signatureCounter: f.signatureCounter,
            signature: f.signature,
            startedAt: f.startedAt.toISOString(),
            finishedAt: f.finishedAt.toISOString(),
            processType: f.processType,
            isTest: f.isTest,
          }
        : null,
      tseFailed: !f,
      ...(opts.belated ? { belatedAt: issuedAt.toISOString() } : {}),
    };
    const [row] = await tx
      .insert(paymentReceipts)
      .values({ organizationId: org, invoiceId: inv.id, paymentId: p.payment.id, number, issuedAt, amountCents: p.payment.amountCents, method: p.payment.method, data, createdBy: userId })
      .returning({ id: paymentReceipts.id });
    out.push({ id: row.id, number });
  }
  return out;
}

/**
 * PDF eines Zahlungsbelegs erzeugen und archivieren (eigene Transaktion). Idempotent: schon archiviert → nichts zu
 * tun. Gegen gleichzeitiges Nachholen sperrt ein Advisory-Lock je Beleg (die Zeile selbst ist unveränderbar).
 * Gibt true zurück, wenn der Beleg danach archiviert ist.
 */
export async function archiveReceipt(org: string, receiptId: string, userId: string | null, opts: { catchUp?: boolean } = {}): Promise<boolean> {
  return withArchiveCleanup(org, (pending) =>
    withOrg(org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`zb-archiv:${receiptId}`}, 0))`);
      const [r] = await tx.select().from(paymentReceipts).where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.id, receiptId)));
      if (!r) return false;
      const done = (await findReceiptArchives(tx, org, r.invoiceId)).some((a) => a.paymentReceiptId === r.id);
      if (done) {
        await clearCatchupAttempt(tx, org, r.id);
        return true;
      }
      const data = readPaymentReceiptSnapshot(r.data);
      if (!data) return false;
      const bytes = await renderPaymentReceiptPdf({ number: r.number, issuedAt: r.issuedAt, data, logos: await loadLogos(org, tx), generatedAt: new Date() });
      const row = await archivePdf(tx, org, { kind: "payment_receipt", invoiceId: r.invoiceId, paymentReceiptId: r.id, bytes, filename: paymentReceiptFilename(r.number), userId }, pending);
      if (opts.catchUp) {
        // in derselben Transaktion: kein Archiv-PDF ohne Protokolleintrag (und umgekehrt)
        await audit({ organizationId: org, userId, action: "payment_receipt.archive_catchup", entity: "invoice", entityId: r.invoiceId, meta: { receipt: r.number, sha256: row.sha256 } }, tx);
      }
      await clearCatchupAttempt(tx, org, r.id);
      return true;
    }),
  );
}

/** Nachhol-Versuche (Cron-Backoff) eines nun archivierten Zahlungsbelegs entfernen – egal, welcher Weg archiviert hat */
async function clearCatchupAttempt(tx: Tx, org: string, receiptId: string) {
  await tx
    .delete(archiveCatchupAttempts)
    .where(and(eq(archiveCatchupAttempts.organizationId, org), eq(archiveCatchupAttempts.targetKind, "payment_receipt"), eq(archiveCatchupAttempts.targetId, receiptId)));
}

/**
 * Nach der Buchung (außerhalb ihrer Transaktion): PDFs der Zahlungsbelege erzeugen und archivieren. Wirft nie –
 * ein Fehler wird protokolliert und einmal je Beleg im Posteingang gemeldet; der Beleg wird beim nächsten Abruf
 * nachgeholt (paymentReceiptPdfForOrg).
 */
export async function archivePaymentReceipts(org: string, receipts: { id: string; number: string }[], userId: string | null) {
  const failed: string[] = [];
  for (const r of receipts) {
    let error: unknown = null;
    try {
      if (!(await archiveReceipt(org, r.id, userId))) error = new Error("Zahlungsbeleg nicht lesbar (Angaben fehlen oder unbekanntes Format)");
    } catch (e) {
      error = e;
    }
    if (error) {
      log.error("payment_receipt.archive_failed", { error, receipt: r.number });
      failed.push(r.number);
      await reportArchiveFailure(org, r);
    }
  }
  return { failed };
}

async function reportArchiveFailure(org: string, r: { id: string; number: string }) {
  await reportToInbox(
    org,
    `zb-archiv:${r.id}`,
    `Zahlungsbeleg ${r.number}: PDF konnte nicht abgelegt werden`,
    `Die Zahlung ist gebucht und der Zahlungsbeleg ${r.number} mit allen Angaben (inkl. TSE) gespeichert, aber das PDF konnte nicht im Beleg-Archiv abgelegt werden. Es wird automatisch nachgeholt (beim Öffnen des Belegs und im regelmäßigen Hintergrundlauf). Bleibt der Fehler bestehen, bitte den Support kontaktieren.`,
  );
}

/** Beleg-Zeile konnte bei der Buchung nicht angelegt werden (Zahlung und TSE-Signatur bleiben gebucht). */
export async function reportReceiptRecordFailure(org: string, inv: { id: string | null; number: string | null }, amountCents: number) {
  await reportToInbox(
    org,
    `zb-fehlt:${inv.id ?? "?"}:${amountCents}:${Date.now()}`,
    `Zahlungsbeleg zu Rechnung ${inv.number ?? "?"} konnte nicht angelegt werden`,
    [
      `Die Zahlung über ${money(amountCents)} zu Rechnung ${inv.number ?? "?"} ist gebucht (bei erreichbarer TSE auch signiert), der Beleg über den Zahlungseingang konnte aber nicht angelegt werden. Die Zahlung bitte NICHT erneut erfassen.`,
      `Nachholen: Rechnung ${inv.id ? `öffnen (/rechnungen/${inv.id})` : `${inv.number ?? ""} öffnen`} → Karte „Zahlungsbeleg fehlt“ → „Zahlungsbeleg nachträglich erstellen“ (Recht: Rechnungen bearbeiten). Bleibt der Fehler, bitte den Support bzw. die Praxisinhaber:in informieren.`,
    ].join("\n\n"),
  );
}

export type PaymentReceiptListItem = {
  id: string;
  number: string;
  paymentId: string;
  issuedAt: Date;
  amountCents: number;
  method: string;
  title: string;
  isTest: boolean;
  tseFailed: boolean;
  archived: boolean;
};

/** Zahlungsbelege einer Rechnung (für die Rechnungsdetailseite). */
export async function paymentReceiptsFor(tx: Tx, org: string, invoiceId: string): Promise<PaymentReceiptListItem[]> {
  const rows = await tx
    .select()
    .from(paymentReceipts)
    .where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.invoiceId, invoiceId)))
    .orderBy(asc(paymentReceipts.issuedAt), asc(paymentReceipts.number));
  const archived = new Set((await findReceiptArchives(tx, org, invoiceId)).map((a) => a.paymentReceiptId));
  return rows.map((r) => {
    const d = readPaymentReceiptSnapshot(r.data);
    return {
      id: r.id,
      number: r.number,
      paymentId: r.paymentId,
      issuedAt: r.issuedAt,
      amountCents: r.amountCents,
      method: r.method,
      title: d ? paymentReceiptTitle(d) : `Zahlungsbeleg ${r.number}`,
      isTest: !!d?.fiscal?.isTest,
      tseFailed: !!d?.tseFailed,
      archived: archived.has(r.id),
    };
  });
}

/**
 * PDF eines Zahlungsbelegs: das archivierte Original (byte-gleich). Fehlt es (Ablage nach der Buchung gescheitert),
 * wird es jetzt nachgeholt und archiviert; scheitert auch das, wird abgelehnt (ArchivePendingError) – keine
 * unarchivierte Fassung.
 */
export async function paymentReceiptPdfForOrg(org: string, invoiceId: string, receiptId: string, userId: string | null = null) {
  if (!z.uuid().safeParse(invoiceId).success || !z.uuid().safeParse(receiptId).success) return null;
  const found = await withOrg(org, async (tx) => {
    const [r] = await tx
      .select()
      .from(paymentReceipts)
      .where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.id, receiptId), eq(paymentReceipts.invoiceId, invoiceId)));
    if (!r) return null;
    return { r, archive: (await findReceiptArchives(tx, org, invoiceId)).find((a) => a.paymentReceiptId === r.id) ?? null };
  });
  if (!found) return null;
  const { r } = found;
  let archive = found.archive;
  const data = readPaymentReceiptSnapshot(r.data);
  if (!data) return null;
  if (!archive) {
    // Nachholen (z. B. Ablage nach der Buchung gescheitert)
    try {
      if (await archiveReceipt(org, r.id, userId, { catchUp: true })) {
        archive = await withOrg(org, async (tx) => (await findReceiptArchives(tx, org, invoiceId)).find((a) => a.paymentReceiptId === r.id) ?? null);
      }
    } catch (e) {
      log.error("payment_receipt.archive_retry_failed", { error: e, receipt: r.number });
    }
  }
  if (!archive) throw new ArchivePendingError();
  return { bytes: await readArchivedPdf(archive), filename: paymentReceiptFilename(r.number), receipt: r, data, variant: "archive" as const };
}

/**
 * Zahlungen der Rechnung, die einen Zahlungsbeleg haben müssten, aber keinen haben – einzige Quelle der Wahrheit für
 * die Anzeige („Zahlungsbeleg fehlt“) UND für das nachträgliche Erstellen (createMissingPaymentReceipt):
 *  - Kassenvorgänge (Bar/Karte/Gutschein) ohne payment_receipts-Zeile,
 *  - NACH dem Ausstellen (nicht `paidAtIssue` – Zahlungen beim Ausstellen stehen auf dem Beleg selbst; SumUp-Zahlungen
 *    gelten nie als beim Ausstellen erfasst),
 *  - in PodoHero ausgestellt (kein übernommener Altbestand) und bezahlt ab dem Stichtag PAYMENT_RECEIPTS_SINCE,
 *  - mit TSE-Signatur oder ohne (TSE-Ausfall, z. B. SumUp-Terminalzahlung bei gestörter TSE → `tseFailed`).
 */
export async function paymentsMissingReceipt(tx: Tx, org: string, invoiceId: string) {
  const [inv] = await tx
    .select({ createdAt: invoices.createdAt, source: invoices.source, status: invoices.status, number: invoices.number })
    .from(invoices)
    .where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
  if (!inv || inv.status === "draft" || !inv.number) return [];
  if (inv.source && inv.source !== "crm") return [];
  const rows = await tx
    .select({
      id: payments.id,
      paidAt: payments.paidAt,
      method: payments.method,
      amountCents: payments.amountCents,
      externalRef: payments.externalRef,
      fiscalId: fiscalTransactions.id,
    })
    .from(payments)
    .leftJoin(fiscalTransactions, and(eq(fiscalTransactions.organizationId, org), eq(fiscalTransactions.paymentId, payments.id)))
    .where(
      and(
        eq(payments.organizationId, org),
        eq(payments.invoiceId, invoiceId),
        inArray(payments.method, [...REGISTER_METHODS]),
        gte(payments.paidAt, PAYMENT_RECEIPTS_SINCE),
        notExists(tx.select({ one: sql`1` }).from(paymentReceipts).where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.paymentId, payments.id)))),
      ),
    )
    .orderBy(asc(payments.paidAt), asc(payments.id));
  return rows
    .filter((p) => !paidAtIssue(p, { createdAt: inv.createdAt, source: inv.source }))
    .map((p) => ({ id: p.id, paidAt: p.paidAt, method: p.method, amountCents: p.amountCents, tseFailed: !p.fiscalId }));
}

/**
 * Zahlungsbeleg für eine Kassenzahlung nachträglich anlegen (Anlegen bei der Buchung war gescheitert) – gezielt je
 * Zahlung, Recht invoices.write, idempotent (gibt den vorhandenen Beleg zurück). Erlaubt ist nur, was
 * `paymentsMissingReceipt` liefert (serverseitig, unter Rechnungssperre) – keine Altzahlungen, keine Zahlungen beim
 * Ausstellen, keine Überweisungen. Laufende Nummer im Nummernkreis ZB (Jahr der Erstellung), Vermerk „nachträglich
 * erstellt“; bei TSE-Ausfall mit dem Ausfallvermerk.
 */
export async function createMissingPaymentReceipt(auth: AuthContext, invoiceId: string, paymentId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  if (!z.uuid().safeParse(invoiceId).success || !z.uuid().safeParse(paymentId).success) throw new PaymentReceiptError("Zahlung nicht gefunden.");
  const res = await withOrg(org, async (tx) => {
    // Rechnung sperren: keine gleichzeitige Buchung/Nachholung auf derselben Rechnung
    const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId))).for("update");
    if (!inv) throw new PaymentReceiptError("Rechnung nicht gefunden.");
    const [existing] = await tx.select({ id: paymentReceipts.id, number: paymentReceipts.number }).from(paymentReceipts).where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.paymentId, paymentId)));
    if (existing) return { ...existing, created: false };
    const missing = (await paymentsMissingReceipt(tx, org, invoiceId)).find((m) => m.id === paymentId);
    if (!missing) {
      // nur für eine verständliche Meldung: was ist das für eine Zahlung?
      const [p] = await tx
        .select({ method: payments.method })
        .from(payments)
        .where(and(eq(payments.organizationId, org), eq(payments.invoiceId, invoiceId), eq(payments.id, paymentId)));
      if (!p) throw new PaymentReceiptError("Zahlung nicht gefunden.");
      if (!isRegisterMethod(p.method)) throw new PaymentReceiptError("Für Überweisungen und Zahlungslinks gibt es keinen Kassenbeleg.");
      throw new PaymentReceiptError(
        "Für diese Zahlung wird kein nachträglicher Zahlungsbeleg erstellt: sie wurde beim Ausstellen erfasst (steht auf dem Beleg selbst) oder vor Einführung der Zahlungsbelege gebucht.",
      );
    }
    const [r] = await recordPaymentReceipts(tx, org, invoiceId, [paymentId], auth.user.id, { belated: true });
    if (!r) throw new PaymentReceiptError("Zahlungsbeleg konnte nicht angelegt werden.");
    await audit(
      { organizationId: org, userId: auth.user.id, action: "payment_receipt.create_belated", entity: "invoice", entityId: invoiceId, meta: { receipt: r.number, paymentId, tseFailed: missing.tseFailed } },
      tx,
    );
    return { ...r, created: true };
  });
  if (res.created) await archivePaymentReceipts(org, [{ id: res.id, number: res.number }], auth.user.id);
  return res;
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Zahlungsbeleg per E-Mail an den Rechnungsempfänger bzw. die Person (wie sendInvoiceEmail). */
export async function sendPaymentReceiptEmail(auth: AuthContext, invoiceId: string, receiptId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const pdf = await paymentReceiptPdfForOrg(org, invoiceId, receiptId, auth.user.id);
  if (!pdf) throw new PaymentReceiptError("Zahlungsbeleg nicht gefunden.");
  const contact = await withOrg(org, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
    if (!inv) return null;
    const p = inv.patientId ? (await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))))[0] : null;
    const b = inv.billingContactId ? (await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))))[0] : null;
    return { to: (b?.email || p?.email || "").trim(), patientId: inv.patientId };
  });
  if (!contact) throw new PaymentReceiptError("Rechnung nicht gefunden.");
  const to = contact.to;
  if (!to) throw new PaymentReceiptError("Keine E-Mail-Adresse beim Rechnungsempfänger bzw. in der Patientenakte hinterlegt.");
  if (!EMAIL_RE.test(to)) throw new PaymentReceiptError("Die hinterlegte E-Mail-Adresse ist ungültig.");
  const d = pdf.data;
  const doc = INVOICE_DOC_LABEL[d.invoice.kind] ?? "Rechnung";
  const subject = `Zahlungsbeleg ${pdf.receipt.number} zu ${doc} ${d.invoice.number} – ${d.organization.name}`;
  const body = [
    "Guten Tag,",
    "",
    `anbei erhalten Sie den Beleg ${pdf.receipt.number} über Ihre ${d.payment.amountCents < 0 ? "Erstattung" : "Zahlung"} von ${money(Math.abs(d.payment.amountCents))} zu ${doc} ${d.invoice.number} vom ${dateDe(d.invoice.issuedAt)} als PDF.`,
    "",
    "Mit freundlichen Grüßen",
    d.organization.legalName ?? d.organization.name,
  ].join("\n");
  let externalId: string;
  let mock = false;
  try {
    const port = await mailMessagingPort(org, { purpose: "invoice", userId: auth.user.id, entity: "invoice", entityId: invoiceId });
    mock = port.isMock;
    externalId = (await port.send({ to, subject, body, attachments: [{ filename: pdf.filename, contentType: "application/pdf", data: pdf.bytes }] })).externalId;
  } catch (e) {
    await logSync(org, "email_imap", { direction: "out", ok: false, message: `Zahlungsbeleg ${pdf.receipt.number}: ${describeError(e)}`, entity: "invoice", entityId: invoiceId });
    throw new PaymentReceiptError(`E-Mail-Versand fehlgeschlagen: ${e instanceof MailSendError || e instanceof MailNotConfiguredError ? e.message : "Details im Synchronisationsprotokoll."}`);
  }
  await withOrg(org, (tx) =>
    tx.insert(messages).values({
      organizationId: org,
      patientId: contact.patientId,
      channel: "email",
      direction: "outbound",
      toAddress: to,
      subject,
      body: `${body}\n\n[Anhang: ${pdf.filename}]`,
      status: "answered",
      externalId,
      threadKey: to,
    }),
  );
  await logSync(org, "email_imap", { direction: "out", ok: true, message: `Zahlungsbeleg ${pdf.receipt.number}: ${mock ? "Testmodus – nicht wirklich versendet" : "versendet"}`, entity: "invoice", entityId: invoiceId });
  await audit({ organizationId: org, userId: auth.user.id, action: "payment_receipt.send_email", entity: "invoice", entityId: invoiceId, meta: { receipt: pdf.receipt.number, mock } });
  return { to, mock };
}
