import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { invoices, messages, payments, webhookEvents } from "@/db/schema";
import type { InboundMessage, NormalizedWebhookEvent, ProviderId } from "@/integrations/types";
import { adapterFor, logSync } from "./integrations";
import { matchPatientByAddress } from "./messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);
export const bodyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Speichert ein Ereignis idempotent. Gibt null zurück, wenn es schon verarbeitet/empfangen wurde. */
export async function storeWebhookEvent(provider: ProviderId, organizationId: string, externalId: string, payload: unknown): Promise<string | null> {
  const rows = await db
    .insert(webhookEvents)
    .values({ provider, organizationId, externalId: externalId.slice(0, 300), payload: payload as object })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalId] })
    .returning({ id: webhookEvents.id });
  return rows[0]?.id ?? null;
}

export async function finishWebhookEvent(id: string, error?: string) {
  await db.update(webhookEvents).set({ processedAt: new Date(), error: error?.slice(0, 500) ?? null }).where(eq(webhookEvents.id, id));
}

/**
 * SumUp: Status immer per API nachladen. Ist die Referenz (checkout_reference bzw. foreign_transaction_id)
 * eine Rechnungs-ID, wird die Zahlung gebucht (idempotent über payments.external_ref = Transaktions-ID).
 */
export async function processSumupEvent(organizationId: string, ev: NormalizedWebhookEvent) {
  if (!ev.objectId) return "ohne Objekt-ID";
  const sumup = await adapterFor(organizationId, "sumup");
  const isReader = ev.type.startsWith("solo.");
  const tx = await sumup.getTransaction(ev.objectId, isReader ? "client_transaction_id" : "checkout");
  if (tx.status !== "paid") return `Status ${tx.status}`;
  if (!isUuid(tx.reference)) return "Referenz ist keine Rechnung";
  const invoiceId = tx.reference;
  const result = await withOrg(organizationId, async (t) => {
    const [inv] = await t.select().from(invoices).where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)));
    if (!inv) return "Rechnung nicht gefunden";
    if (inv.status === "draft" || inv.status === "cancelled") return `Rechnung im Status ${inv.status}`;
    const [dup] = await t
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.externalRef, `sumup:${tx.id}`)));
    if (dup) return "bereits gebucht";
    await t.insert(payments).values({
      organizationId,
      invoiceId,
      method: isReader ? "card" : "payment_link",
      amountCents: tx.amountCents,
      paidAt: tx.paidAt ? new Date(tx.paidAt) : new Date(),
      externalRef: `sumup:${tx.id}`,
    });
    const [sum] = await t
      .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.invoiceId, invoiceId)));
    const paid = Number(sum?.paid ?? 0);
    await t
      .update(invoices)
      .set({ paidCents: paid, status: paid >= inv.totalCents ? "paid" : "partially_paid" })
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)));
    return "gebucht";
  });
  await logSync(organizationId, "sumup", { direction: "in", ok: result === "gebucht" || result === "bereits gebucht", message: `Zahlung ${tx.id}: ${result}`, entity: "invoice", entityId: invoiceId });
  return result;
}

/** Eingehende Nachrichten (WhatsApp/SMS) speichern und – falls eindeutig – einer Person zuordnen. */
export async function storeInboundMessages(organizationId: string, list: InboundMessage[]) {
  for (const m of list) {
    const patientId = await matchPatientByAddress(organizationId, m.from);
    await withOrg(organizationId, async (t) => {
      const [exists] = await t
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.organizationId, organizationId), eq(messages.channel, m.channel), eq(messages.externalId, m.externalId)));
      if (exists) return;
      await t.insert(messages).values({
        organizationId,
        patientId,
        channel: m.channel,
        direction: "inbound",
        fromAddress: m.from,
        toAddress: m.to ?? null,
        subject: m.subject ?? null,
        body: m.body,
        externalId: m.externalId,
        threadKey: m.threadKey ?? m.from,
        receivedAt: new Date(m.receivedAt),
      });
    });
  }
}
