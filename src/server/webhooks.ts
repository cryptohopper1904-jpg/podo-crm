import "server-only";
import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { invoices, messages, payments, webhookEvents } from "@/db/schema";
import type { InboundMessage, NormalizedWebhookEvent, PaymentPort, ProviderId } from "@/integrations/types";
import { statusFromPayments } from "@/lib/invoice-math";
import { adapterFor, logSync } from "./integrations";
import { matchPatientByAddress } from "./messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);
export const bodyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/**
 * Reserviert ein Ereignis zur Verarbeitung (erst NACH erfolgreicher Signatur-/Token-Prüfung aufrufen).
 * - neu → wird angelegt
 * - schon vorhanden, aber fehlgeschlagen (error gesetzt, processed_at leer) → atomar erneut reserviert
 * - sonst (erfolgreich verarbeitet oder gerade in Arbeit) → null = Duplikat
 */
export async function claimWebhookEvent(provider: ProviderId, organizationId: string, externalId: string, payload: unknown): Promise<{ id: string; retry: boolean } | null> {
  const ext = externalId.slice(0, 300);
  const rows = await db
    .insert(webhookEvents)
    .values({ provider, organizationId, externalId: ext, payload: payload as object })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.organizationId, webhookEvents.externalId] })
    .returning({ id: webhookEvents.id });
  if (rows[0]) return { id: rows[0].id, retry: false };
  const again = await db
    .update(webhookEvents)
    .set({ error: null, receivedAt: new Date() })
    .where(
      and(
        eq(webhookEvents.provider, provider),
        eq(webhookEvents.externalId, ext),
        eq(webhookEvents.organizationId, organizationId),
        isNotNull(webhookEvents.error),
        isNull(webhookEvents.processedAt),
      ),
    )
    .returning({ id: webhookEvents.id });
  return again[0] ? { id: again[0].id, retry: true } : null;
}

/**
 * Erfolg → processed_at setzen. Fehler → nur error setzen (processed_at bleibt leer, damit eine erneute
 * Zustellung neu verarbeitet). `note` = verarbeitet, aber mit Hinweis (z. B. Zahlung nicht zugeordnet) –
 * wird NICHT erneut verarbeitet.
 */
export async function finishWebhookEvent(id: string, error?: string, note?: string) {
  await db
    .update(webhookEvents)
    .set(error ? { error: error.slice(0, 500), processedAt: null } : { processedAt: new Date(), error: note ? note.slice(0, 500) : null })
    .where(eq(webhookEvents.id, id));
}

/** Rechnungs-ID aus einer SumUp-Referenz: „<uuid>“ oder „<uuid>.<suffix>“ (Zahlungslinks brauchen eindeutige Referenzen). */
export function invoiceIdFromReference(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const head = ref.slice(0, 36);
  return isUuid(head) && (ref.length === 36 || ref[36] === ".") ? head : null;
}

export type ProviderPaymentInput = {
  /** Rechnungs-ID (aus der Referenz), falls bekannt */
  invoiceId?: string | null;
  /** invoices.checkout_ref, z. B. „reader:<client_transaction_id>“ oder „checkout:<id>“ */
  checkoutRef?: string | null;
  /** Idempotenz-Schlüssel, z. B. „sumup:<transaktions-id>“ (payments.external_ref) */
  externalRef: string;
  amountCents: number;
  method: "card" | "payment_link";
  paidAt?: Date | null;
};

export const UNASSIGNED_PAYMENT_SUBJECT = "Zahlung konnte nicht zugeordnet werden (Überzahlung/storniert) – bitte prüfen";

export type ProviderPaymentResult = {
  status: "gebucht" | "bereits gebucht" | "nicht zugeordnet";
  invoiceId: string | null;
  /** Grund, wenn nicht gebucht */
  reason?: string;
};

/**
 * Bucht eine bestätigte Kartenzahlung/Zahlungslink-Zahlung idempotent:
 * Rechnung wird gesperrt (FOR UPDATE) → parallele Zustellungen desselben Ereignisses laufen nacheinander,
 * die zweite findet die Zahlung über external_ref und bucht nicht erneut.
 *
 * Gebucht wird nur, wenn die Rechnung offen ist und der Betrag den offenen Betrag nicht übersteigt.
 * Sonst (storniert, schon bezahlt, Überzahlung, Rechnung unbekannt) wird NICHT gebucht, sondern eine
 * Nachricht im Posteingang angelegt („bitte prüfen“) – das Geld ist ja bei SumUp eingegangen.
 */
export async function recordProviderPayment(organizationId: string, input: ProviderPaymentInput): Promise<ProviderPaymentResult> {
  const res = await withOrg(organizationId, async (t): Promise<ProviderPaymentResult & { number?: string | null; patientId?: string | null }> => {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) return { status: "nicht zugeordnet", invoiceId: null, reason: "Betrag ungültig" };
    const byId = isUuid(input.invoiceId)
      ? await t.select().from(invoices).where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, input.invoiceId))).for("update")
      : [];
    const byRef = !byId[0] && input.checkoutRef
      ? await t.select().from(invoices).where(and(eq(invoices.organizationId, organizationId), eq(invoices.checkoutRef, input.checkoutRef))).limit(1).for("update")
      : [];
    const inv = byId[0] ?? byRef[0];
    if (!inv) return { status: "nicht zugeordnet", invoiceId: null, reason: "Rechnung nicht gefunden" };
    const [dup] = await t
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.externalRef, input.externalRef)));
    if (dup) return { status: "bereits gebucht", invoiceId: inv.id };
    const base = { status: "nicht zugeordnet" as const, invoiceId: inv.id, number: inv.number, patientId: inv.patientId };
    if (inv.status === "cancelled") return { ...base, reason: "Rechnung storniert" };
    if (inv.status !== "issued" && inv.status !== "partially_paid") return { ...base, reason: `Rechnung im Status ${inv.status}` };
    const open = inv.totalCents - inv.paidCents;
    if (input.amountCents > open) return { ...base, reason: `Überzahlung: ${(input.amountCents / 100).toFixed(2)} € bei offen ${(open / 100).toFixed(2)} €` };
    await t.insert(payments).values({
      organizationId,
      invoiceId: inv.id,
      method: input.method,
      amountCents: input.amountCents,
      paidAt: input.paidAt ?? new Date(),
      externalRef: input.externalRef,
    });
    const [sum] = await t
      .select({ paid: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.organizationId, organizationId), eq(payments.invoiceId, inv.id)));
    const paid = Number(sum?.paid ?? 0);
    await t
      .update(invoices)
      .set({ paidCents: paid, status: statusFromPayments(inv.totalCents, paid) })
      .where(and(eq(invoices.organizationId, organizationId), eq(invoices.id, inv.id)));
    return { status: "gebucht", invoiceId: inv.id };
  });
  if (res.status === "nicht zugeordnet") await reportUnassignedPayment(organizationId, input, res);
  return { status: res.status, invoiceId: res.invoiceId, reason: res.reason };
}

/** Nicht gebuchte Provider-Zahlung: Synchronisationsprotokoll + Posteingang (einmal je Transaktion). */
async function reportUnassignedPayment(
  organizationId: string,
  input: ProviderPaymentInput,
  res: { invoiceId: string | null; reason?: string; number?: string | null; patientId?: string | null },
) {
  const threadKey = `payment:${input.externalRef}`.slice(0, 300);
  await withOrg(organizationId, async (t) => {
    const [exists] = await t
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.threadKey, threadKey)))
      .limit(1);
    if (exists) return;
    await t.insert(messages).values({
      organizationId,
      patientId: res.patientId ?? null,
      channel: "none",
      direction: "inbound",
      subject: UNASSIGNED_PAYMENT_SUBJECT,
      body: [
        `Eine Zahlung über ${(input.amountCents / 100).toFixed(2).replace(".", ",")} € (${input.method === "card" ? "Karte" : "Zahlungslink"}) wurde nicht gebucht.`,
        `Grund: ${res.reason ?? "unbekannt"}.`,
        res.number ? `Rechnung: ${res.number}` : "Rechnung: nicht gefunden",
        `Referenz: ${input.externalRef}`,
        "Bitte im SumUp-Konto prüfen und ggf. erstatten oder manuell zuordnen.",
      ].join("\n"),
      status: "new",
      threadKey,
    });
  });
  await logSync(organizationId, "sumup", {
    direction: "in",
    ok: false,
    message: `Zahlung ${input.externalRef} nicht gebucht: ${res.reason ?? "unbekannt"}`,
    entity: "invoice",
    entityId: res.invoiceId ?? undefined,
  });
}

/**
 * SumUp: Status immer per API nachladen (Payload ist nicht autoritativ). Zuordnung zur Rechnung über
 * die Referenz (Rechnungs-ID) oder – beim Solo-Terminal, das keine Referenz kennt – über invoices.checkout_ref.
 * Gebucht wird idempotent über payments.external_ref = „sumup:<Transaktions-ID>“.
 */
export async function processSumupEvent(organizationId: string, ev: NormalizedWebhookEvent, deps: { port?: PaymentPort } = {}) {
  if (!ev.objectId) return "ohne Objekt-ID";
  const sumup = deps.port ?? (await adapterFor(organizationId, "sumup"));
  const isReader = ev.type.startsWith("solo.");
  const tx = await sumup.getTransaction(ev.objectId, isReader ? "client_transaction_id" : "checkout");
  if (tx.status !== "paid") return `Status ${tx.status}`;
  const res = await recordProviderPayment(organizationId, {
    invoiceId: invoiceIdFromReference(tx.reference),
    checkoutRef: `${isReader ? "reader" : "checkout"}:${ev.objectId}`,
    externalRef: `sumup:${tx.id}`,
    amountCents: tx.amountCents,
    method: isReader ? "card" : "payment_link",
    paidAt: tx.paidAt ? new Date(tx.paidAt) : null,
  });
  if (res.status !== "nicht zugeordnet") {
    await logSync(organizationId, "sumup", { direction: "in", ok: true, message: `Zahlung ${tx.id}: ${res.status}`, entity: "invoice", entityId: res.invoiceId ?? undefined });
  }
  return res.status === "nicht zugeordnet" ? `nicht zugeordnet: ${res.reason}` : res.status;
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
