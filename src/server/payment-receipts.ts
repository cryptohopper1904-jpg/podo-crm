import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import { billingContacts, fiscalTransactions, invoices, messages, organizations, patients, paymentReceipts, payments, vouchers } from "@/db/schema";
import { MailNotConfiguredError, MailSendError } from "@/integrations/mail/mail";
import { describeError } from "@/integrations/test-connection";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { berlinDateIso, dateDe, money } from "@/lib/format";
import { INVOICE_DOC_LABEL } from "@/lib/invoice-labels";
import { buildInvoiceSnapshot, readInvoiceSnapshot } from "@/lib/invoice-snapshot";
import { invoiceRecipient } from "@/lib/invoice-view";
import { isRegisterMethod } from "@/lib/kasse/model";
import { nextNumber } from "@/lib/numbering";
import {
  PAYMENT_RECEIPT_VERSION,
  paymentReceiptFilename,
  paymentReceiptTitle,
  readPaymentReceiptSnapshot,
  renderPaymentReceiptPdf,
  type PaymentReceiptSnapshot,
} from "@/lib/payment-receipt";
import { invoiceBookingLink, practiceWebsite, readDocumentSettings } from "@/lib/practice-documents";
import { log } from "@/lib/log";
import { archivePdf, findReceiptArchives, readArchivedPdf, withArchiveCleanup } from "./document-archive";
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
export async function recordPaymentReceipts(tx: Tx, org: string, invoiceId: string, paymentIds: string[], userId: string | null) {
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
  const patient = invSnap?.patient ?? (inv.patientId ? (await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))))[0] ?? null : null);
  const billing = invSnap ? invSnap.billingContact : inv.billingContactId
    ? (await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))))[0] ?? null
    : null;
  const recipient = patient || billing ? { name: invoiceRecipient(patient, billing).name, patientNumber: patient?.number ?? null } : null;

  // Stand nach der jeweiligen Zahlung: vom aktuellen paid_cents rückwärts (alle eben gebuchten Zahlungen – auch
  // Überweisungen derselben Erfassung – sind bereits enthalten)
  const laterSum = (id: string) => pays.slice(pays.findIndex((p) => p.payment.id === id) + 1).reduce((s, p) => s + p.payment.amountCents, 0);
  const out: { id: string; number: string }[] = [];
  for (const p of register) {
    const issuedAt = new Date();
    const number = await nextNumber(tx, org, "payment_receipt", Number(berlinDateIso(issuedAt).slice(0, 4)));
    const f = p.fiscal;
    const data: PaymentReceiptSnapshot = {
      v: PAYMENT_RECEIPT_VERSION,
      organization: orgSnap,
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
async function archiveReceipt(org: string, receiptId: string, userId: string | null): Promise<boolean> {
  return withArchiveCleanup(org, (pending) =>
    withOrg(org, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`zb-archiv:${receiptId}`}, 0))`);
      const [r] = await tx.select().from(paymentReceipts).where(and(eq(paymentReceipts.organizationId, org), eq(paymentReceipts.id, receiptId)));
      if (!r) return false;
      const done = (await findReceiptArchives(tx, org, r.invoiceId)).some((a) => a.paymentReceiptId === r.id);
      if (done) return true;
      const data = readPaymentReceiptSnapshot(r.data);
      if (!data) return false;
      const bytes = await renderPaymentReceiptPdf({ number: r.number, issuedAt: r.issuedAt, data, logos: await loadLogos(org, tx) });
      await archivePdf(tx, org, { kind: "payment_receipt", invoiceId: r.invoiceId, paymentReceiptId: r.id, bytes, filename: paymentReceiptFilename(r.number), userId }, pending);
      return true;
    }),
  );
}

/**
 * Nach der Buchung (außerhalb ihrer Transaktion): PDFs der Zahlungsbelege erzeugen und archivieren. Wirft nie –
 * ein Fehler wird protokolliert und einmal je Beleg im Posteingang gemeldet; der Beleg wird beim nächsten Abruf
 * nachgeholt (paymentReceiptPdfForOrg).
 */
export async function archivePaymentReceipts(org: string, receipts: { id: string; number: string }[], userId: string | null) {
  const failed: string[] = [];
  for (const r of receipts) {
    try {
      if (!(await archiveReceipt(org, r.id, userId))) failed.push(r.number);
    } catch (e) {
      log.error("payment_receipt.archive_failed", { error: e, receipt: r.number });
      failed.push(r.number);
      await reportArchiveFailure(org, r).catch(() => undefined);
    }
  }
  return { failed };
}

async function reportArchiveFailure(org: string, r: { id: string; number: string }) {
  const threadKey = `zb-archiv:${r.id}`;
  await withOrg(org, async (tx) => {
    const [exists] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.organizationId, org), eq(messages.threadKey, threadKey))).limit(1);
    if (exists) return;
    await tx.insert(messages).values({
      organizationId: org,
      patientId: null,
      channel: "none",
      direction: "inbound",
      subject: `Zahlungsbeleg ${r.number}: PDF konnte nicht abgelegt werden`,
      body: `Die Zahlung ist gebucht und der Zahlungsbeleg ${r.number} mit allen Angaben (inkl. TSE) gespeichert, aber das PDF konnte nicht im Beleg-Archiv abgelegt werden. Es wird beim nächsten Öffnen des Belegs automatisch nachgeholt. Bleibt der Fehler bestehen, bitte den Support kontaktieren.`,
      status: "new",
      threadKey,
    });
  });
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
 * wird es jetzt nachgeholt und archiviert; scheitert auch das, wird aus den festgeschriebenen Angaben neu erzeugt
 * und als „Reproduktion“ gekennzeichnet.
 */
export async function paymentReceiptPdfForOrg(org: string, invoiceId: string, receiptId: string) {
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
      if (await archiveReceipt(org, r.id, null)) {
        archive = await withOrg(org, async (tx) => (await findReceiptArchives(tx, org, invoiceId)).find((a) => a.paymentReceiptId === r.id) ?? null);
      }
    } catch (e) {
      log.error("payment_receipt.archive_retry_failed", { error: e, receipt: r.number });
    }
  }
  if (archive) return { bytes: await readArchivedPdf(archive), filename: paymentReceiptFilename(r.number), receipt: r, data, variant: "archive" as const };
  const logos = await loadLogos(org);
  const bytes = await renderPaymentReceiptPdf({ number: r.number, issuedAt: r.issuedAt, data, logos, reproduction: { generatedAt: new Date() } });
  return { bytes, filename: paymentReceiptFilename(r.number), receipt: r, data, variant: "reproduction" as const };
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Zahlungsbeleg per E-Mail an den Rechnungsempfänger bzw. die Person (wie sendInvoiceEmail). */
export async function sendPaymentReceiptEmail(auth: AuthContext, invoiceId: string, receiptId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const pdf = await paymentReceiptPdfForOrg(org, invoiceId, receiptId);
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
