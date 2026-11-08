import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { consents, invoices, messages, patients, billingContacts } from "@/db/schema";
import { getAdapter } from "@/integrations/registry";
import { describeError } from "@/integrations/test-connection";
import type { MessagingProvider, NormalizedWebhookEvent } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { money } from "@/lib/format";
import { adapterFor, loadConnection, logSync } from "./integrations";
import { InvoiceError } from "./invoices";
import { processSumupEvent } from "./webhooks";

/**
 * SumUp direkt aus der Rechnung: Kartenzahlung am Solo-Terminal und Zahlungslink.
 * Das Ergebnis kommt per Webhook (src/app/api/webhooks/[provider]) und wird über
 * processSumupEvent → recordProviderPayment idempotent gebucht. Beschreibung an SumUp: nur Rechnungsnummer.
 */

async function loadOpenInvoice(org: string, invoiceId: string) {
  const [inv] = await withOrg(org, (tx) => tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId))));
  if (!inv) throw new InvoiceError("Rechnung nicht gefunden.");
  if (inv.status !== "issued" && inv.status !== "partially_paid") throw new InvoiceError("Die Rechnung ist nicht offen.");
  const open = inv.totalCents - inv.paidCents;
  if (open <= 0) throw new InvoiceError("Kein offener Betrag.");
  return { inv, open };
}

async function sumupPort(org: string) {
  const conn = await loadConnection(org, "sumup");
  try {
    return { port: getAdapter("sumup", conn ?? { status: "disconnected" }), conn };
  } catch (e) {
    throw new InvoiceError(`SumUp ist nicht eingerichtet (Einstellungen → Schnittstellen). ${describeError(e)}`.slice(0, 300));
  }
}

const webhookUrl = (org: string) => (process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/webhooks/sumup?org=${org}` : undefined);

export async function startTerminalPayment(auth: AuthContext, invoiceId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const { inv, open } = await loadOpenInvoice(org, invoiceId);
  const { port, conn } = await sumupPort(org);
  const configured = typeof conn?.config?.readerId === "string" ? (conn.config.readerId as string).trim() : "";
  const readerId = configured || (port.isMock ? "mock-reader" : "");
  if (!readerId) throw new InvoiceError("Bitte die Reader-ID des Solo-Terminals unter Einstellungen → Schnittstellen → SumUp hinterlegen.");
  let clientTransactionId: string;
  try {
    ({ clientTransactionId } = await port.startTerminalPayment({
      readerId,
      amountCents: open,
      description: `Rechnung ${inv.number}`,
      reference: inv.id,
      returnUrl: webhookUrl(org),
    }));
  } catch (e) {
    await logSync(org, "sumup", { direction: "out", ok: false, message: `Terminal: ${describeError(e)}`, entity: "invoice", entityId: inv.id });
    throw new InvoiceError("Terminal-Zahlung konnte nicht gestartet werden (Details im Synchronisationsprotokoll).");
  }
  await withOrg(org, (tx) => tx.update(invoices).set({ checkoutRef: `reader:${clientTransactionId}` }).where(and(eq(invoices.organizationId, org), eq(invoices.id, inv.id))));
  await logSync(org, "sumup", { direction: "out", ok: true, message: `Terminal-Zahlung ${money(open)} gestartet${port.isMock ? " (Testmodus)" : ""}`, entity: "invoice", entityId: inv.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.terminal_start", entity: "invoice", entityId: inv.id, meta: { amountCents: open, mock: port.isMock } });
  return { mock: port.isMock, amountCents: open };
}

export async function createPaymentLink(auth: AuthContext, invoiceId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const { inv, open } = await loadOpenInvoice(org, invoiceId);
  const { port } = await sumupPort(org);
  // SumUp verlangt eindeutige checkout_reference → Rechnungs-ID + Zufallssuffix (Zuordnung über die ersten 36 Zeichen)
  const reference = `${inv.id}.${randomBytes(4).toString("hex")}`;
  let res: Awaited<ReturnType<typeof port.createCheckout>>;
  try {
    res = await port.createCheckout({ reference, amountCents: open, description: `Rechnung ${inv.number}`, returnUrl: webhookUrl(org) });
  } catch (e) {
    await logSync(org, "sumup", { direction: "out", ok: false, message: `Zahlungslink: ${describeError(e)}`, entity: "invoice", entityId: inv.id });
    throw new InvoiceError("Zahlungslink konnte nicht erzeugt werden (Details im Synchronisationsprotokoll).");
  }
  if (!res.url) throw new InvoiceError("SumUp hat keinen Zahlungslink geliefert (Hosted Checkout im SumUp-Konto aktivieren).");
  if (!isAllowedPaymentUrl(res.url, port.isMock)) {
    await logSync(org, "sumup", { direction: "out", ok: false, message: "Zahlungslink mit unerwarteter Adresse verworfen", entity: "invoice", entityId: inv.id });
    throw new InvoiceError("SumUp hat einen ungültigen Zahlungslink geliefert.");
  }
  await withOrg(org, (tx) =>
    tx.update(invoices).set({ paymentLinkUrl: res.url, checkoutRef: `checkout:${res.checkoutId}` }).where(and(eq(invoices.organizationId, org), eq(invoices.id, inv.id))),
  );
  await logSync(org, "sumup", { direction: "out", ok: true, message: `Zahlungslink über ${money(open)} erzeugt${port.isMock ? " (Testmodus)" : ""}`, entity: "invoice", entityId: inv.id });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.payment_link", entity: "invoice", entityId: inv.id, meta: { amountCents: open, mock: port.isMock } });
  return { url: res.url, mock: port.isMock };
}

/** Nur https-Links von SumUp (bzw. der Mock-Domain im Testmodus) speichern und ausliefern. */
export function isAllowedPaymentUrl(url: string, mock: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === "sumup.com" || host.endsWith(".sumup.com")) return true;
  return mock && host === "pay.example.invalid";
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const validPhone = (p: string) => /^\+?[\d\s()/-]{6,25}$/.test(p) && p.replace(/\D/g, "").length >= 7 && p.replace(/\D/g, "").length <= 15;

const PROVIDER: Record<"email" | "sms" | "whatsapp", MessagingProvider> = { email: "email_imap", sms: "sms", whatsapp: "whatsapp" };

/** Zahlungslink versenden – Text nur mit Rechnungsnummer und Betrag, keine Leistungen. */
export async function sendPaymentLink(auth: AuthContext, invoiceId: string, channel: "email" | "sms" | "whatsapp") {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [inv] = await tx.select().from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)));
    if (!inv) return null;
    const [p] = inv.patientId ? await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, inv.patientId))) : [];
    const [b] = inv.billingContactId ? await tx.select().from(billingContacts).where(and(eq(billingContacts.organizationId, org), eq(billingContacts.id, inv.billingContactId))) : [];
    let whatsappOk = false;
    if (p && channel === "whatsapp") {
      const [c] = await tx
        .select({ granted: consents.granted })
        .from(consents)
        .where(and(eq(consents.organizationId, org), eq(consents.patientId, p.id), eq(consents.type, "whatsapp")))
        .orderBy(desc(consents.recordedAt))
        .limit(1);
      whatsappOk = c?.granted === true;
    }
    return { inv, p: p ?? null, b: b ?? null, whatsappOk };
  });
  if (!data) throw new InvoiceError("Rechnung nicht gefunden.");
  const { inv, p, b } = data;
  if (!inv.paymentLinkUrl) throw new InvoiceError("Bitte zuerst einen Zahlungslink erzeugen.");
  if (inv.status !== "issued" && inv.status !== "partially_paid") throw new InvoiceError("Die Rechnung ist nicht offen.");
  let to: string | null = null;
  if (channel === "email") to = b?.email || p?.email || null;
  else {
    if (!p) throw new InvoiceError("SMS/WhatsApp nur an die Person selbst – bitte per E-Mail senden.");
    if (channel === "whatsapp" && !data.whatsappOk) throw new InvoiceError("Keine WhatsApp-Einwilligung hinterlegt.");
    to = p.phoneMobile;
  }
  to = to?.trim() || null;
  if (!to) throw new InvoiceError(channel === "email" ? "Keine E-Mail-Adresse hinterlegt." : "Keine Mobilnummer hinterlegt.");
  if (channel === "email" ? !EMAIL_RE.test(to) : !validPhone(to)) throw new InvoiceError("Die hinterlegte Empfängeradresse ist ungültig.");
  if (!isAllowedPaymentUrl(inv.paymentLinkUrl, true)) throw new InvoiceError("Der gespeicherte Zahlungslink ist ungültig – bitte neu erzeugen.");
  const open = inv.totalCents - inv.paidCents;
  const body = `Zahlungslink für Rechnung ${inv.number} über ${money(open)} (${auth.organization.name}): ${inv.paymentLinkUrl}`;
  const subject = `Zahlungslink zu Rechnung ${inv.number}`;
  let externalId: string;
  let mock = false;
  try {
    const port = await adapterFor(org, PROVIDER[channel]);
    mock = port.isMock;
    externalId = (await port.send({ to, body, subject: channel === "email" ? subject : undefined })).externalId;
  } catch (e) {
    await logSync(org, PROVIDER[channel], { direction: "out", ok: false, message: describeError(e), entity: "invoice", entityId: inv.id });
    throw new InvoiceError("Versand fehlgeschlagen (Details im Synchronisationsprotokoll).");
  }
  await withOrg(org, (tx) =>
    tx.insert(messages).values({
      organizationId: org,
      patientId: p?.id ?? null,
      channel,
      direction: "outbound",
      toAddress: to,
      subject: channel === "email" ? subject : null,
      body,
      status: "answered",
      externalId,
      threadKey: to,
    }),
  );
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.payment_link_send", entity: "invoice", entityId: inv.id, meta: { channel, mock } });
  return { mock };
}

/**
 * Nur im Testmodus: simuliert die erfolgreiche Zahlung und läuft dabei durch denselben Code wie
 * ein echter SumUp-Webhook (processSumupEvent → getTransaction → recordProviderPayment).
 */
export async function simulateTestPayment(auth: AuthContext, invoiceId: string) {
  assertCan(auth, "invoices.write");
  const org = auth.organization.id;
  const { port } = await sumupPort(org);
  if (!port.isMock) throw new InvoiceError("Testzahlungen sind nur im Testmodus möglich.");
  // Testbuchungen landen in payments (external_ref „sumup:mock_…“) – in Produktion nur mit ausdrücklicher Freigabe
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_TEST_PAYMENTS !== "true") {
    throw new InvoiceError("Testzahlungen sind in Produktion deaktiviert (ALLOW_TEST_PAYMENTS=true für eine Testpraxis).");
  }
  const { inv } = await loadOpenInvoice(org, invoiceId);
  let ref = inv.checkoutRef;
  if (!ref) {
    await createPaymentLink(auth, invoiceId);
    ref = (await withOrg(org, (tx) => tx.select({ r: invoices.checkoutRef }).from(invoices).where(and(eq(invoices.organizationId, org), eq(invoices.id, invoiceId)))))[0]?.r ?? null;
  }
  if (!ref) throw new InvoiceError("Kein Checkout vorhanden.");
  const [kind, ...rest] = ref.split(":");
  const objectId = rest.join(":");
  const ev: NormalizedWebhookEvent = {
    provider: "sumup",
    externalId: `simulated:${ref}`,
    type: kind === "reader" ? "solo.transaction.updated" : "CHECKOUT_STATUS_CHANGED",
    objectId,
    status: null,
    needsFetch: true,
    raw: { simulated: true },
  };
  const result = await processSumupEvent(org, ev, { port });
  await audit({ organizationId: org, userId: auth.user.id, action: "invoice.simulate_payment", entity: "invoice", entityId: inv.id, meta: { result } });
  return result;
}
