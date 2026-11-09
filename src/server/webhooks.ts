import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { invoiceLines, invoices, messages, organizations, payments, webhookEvents } from "@/db/schema";
import { handleLexofficeWebhook, handleSmsWebhook, handleSumupWebhook, handleWhatsAppWebhook } from "@/integrations/webhooks";
import type { InboundMessage, NormalizedWebhookEvent, PaymentPort, ProviderId } from "@/integrations/types";
import { statusFromPayments } from "@/lib/invoice-math";
import { FiscalSignError, needsSignature, signRegisterPayment, storeSignature, type SignedPayment } from "./fiscal";
import { adapterFor, logSync } from "./integrations";
import { matchPatientByAddress } from "./messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | null | undefined): v is string => !!v && UUID.test(v);
export const bodyHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/**
 * Dauerhafte Webhook-Verarbeitung (Gesamt-Review H4/H7): erst speichern, dann verarbeiten, bei Fehler oder Absturz
 * per Cron mit Backoff erneut versuchen.
 *
 *   pending ──lease──▶ processing ──ok──▶ done (payload := NULL)
 *                          │ Fehler
 *                          ▼
 *                       failed ──Backoff──▶ processing … ──nach WEBHOOK_MAX_ATTEMPTS──▶ dead (+ Posteingang)
 *
 * - Ein Absturz während der Verarbeitung (z. B. Neustart durch update.sh) hinterlässt „processing“ mit abgelaufener
 *   Lease → der Cron übernimmt.
 * - Rohdaten (payload) nur bis zur erfolgreichen Verarbeitung, Zeilen höchstens WEBHOOK_RETENTION_DAYS Tage.
 * - Tabelle unter RLS (tenant_isolation) – jeder Zugriff mit Praxis-Kontext (withOrg).
 */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_LEASE_MS = 5 * 60_000;
export const WEBHOOK_RETENTION_DAYS = 30;
/** Ereignisse, die frisch eingegangen sind, verarbeitet die Anfrage selbst (after()) – der Cron wartet so lange. */
const FRESH_GRACE_MS = 2 * 60_000;

/** 5, 10, 20, 40, 80 … Minuten, höchstens 12 h */
export function webhookBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** Math.max(0, attempts - 1), 12 * 3600_000);
}

export type WebhookProvider = "sumup" | "lexoffice" | "whatsapp" | "sms";

/**
 * Speichert ein Ereignis (erst NACH erfolgreicher Signatur-/Token-Prüfung aufrufen).
 * - neu → angelegt (pending)
 * - schon vorhanden und fehlgeschlagen/aufgegeben → erneute Zustellung des Anbieters: sofort wieder „pending“
 * - sonst (verarbeitet oder in Arbeit) → null = Duplikat
 */
export async function storeWebhookEvent(provider: WebhookProvider, organizationId: string, externalId: string, payload: unknown, payloadHash: string): Promise<{ id: string; retry: boolean } | null> {
  const ext = externalId.slice(0, 300);
  return withOrg(organizationId, async (t) => {
    const rows = await t
      .insert(webhookEvents)
      .values({ provider, organizationId, externalId: ext, payload: payload as object, payloadHash, status: "pending" })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.organizationId, webhookEvents.externalId] })
      .returning({ id: webhookEvents.id });
    if (rows[0]) return { id: rows[0].id, retry: false };
    const again = await t
      .update(webhookEvents)
      .set({ status: "pending", nextAttemptAt: null, payload: payload as object, payloadHash })
      .where(
        and(
          eq(webhookEvents.provider, provider),
          eq(webhookEvents.externalId, ext),
          eq(webhookEvents.organizationId, organizationId),
          inArray(webhookEvents.status, ["failed", "dead"]),
        ),
      )
      .returning({ id: webhookEvents.id });
    return again[0] ? { id: again[0].id, retry: true } : null;
  });
}

/** Fachliche Verarbeitung je Anbieter. Rückgabe: Hinweis (verarbeitet, aber z. B. Zahlung nicht zugeordnet). */
export async function dispatchWebhook(provider: WebhookProvider, organizationId: string, payload: unknown, deps: { port?: PaymentPort } = {}): Promise<string | undefined> {
  if (provider === "sumup") {
    const r = await processSumupEvent(organizationId, handleSumupWebhook(payload, {}), deps);
    return r.startsWith("nicht zugeordnet") ? r : undefined;
  }
  if (provider === "whatsapp") await storeInboundMessages(organizationId, handleWhatsAppWebhook(payload));
  else if (provider === "sms") await storeInboundMessages(organizationId, handleSmsWebhook(payload));
  else if (provider === "lexoffice") {
    // TODO: Zahlungsstatus per getPaymentStatus nachladen und Rechnung abgleichen
    await logSync(organizationId, "lexoffice", { direction: "in", ok: true, message: `Ereignis ${handleLexofficeWebhook(payload).type ?? "unbekannt"}` });
  }
  return undefined;
}

export type WebhookOutcome = "done" | "failed" | "dead" | "skipped";

/**
 * Verarbeitet EIN Ereignis mit Lease (parallel laufende Verarbeiter – after() und Cron – schließen sich aus).
 * Fehler werfen nicht, sondern führen zu „failed“ (mit nächstem Versuch) bzw. „dead“.
 */
export async function processWebhookEvent(organizationId: string, id: string, deps: { dispatch?: typeof dispatchWebhook } = {}): Promise<WebhookOutcome> {
  const [ev] = await withOrg(organizationId, (t) =>
    t
      .update(webhookEvents)
      .set({ status: "processing", attempts: sql`${webhookEvents.attempts} + 1`, leaseUntil: new Date(Date.now() + WEBHOOK_LEASE_MS) })
      .where(
        and(
          eq(webhookEvents.organizationId, organizationId),
          eq(webhookEvents.id, id),
          or(inArray(webhookEvents.status, ["pending", "failed"]), and(eq(webhookEvents.status, "processing"), lt(webhookEvents.leaseUntil, new Date()))),
        ),
      )
      .returning(),
  );
  if (!ev) return "skipped";
  try {
    if (ev.payload === null) throw new Error("Rohdaten fehlen (bereits gelöscht)");
    const note = await (deps.dispatch ?? dispatchWebhook)(ev.provider as WebhookProvider, organizationId, ev.payload);
    await withOrg(organizationId, (t) =>
      t
        .update(webhookEvents)
        .set({ status: "done", processedAt: new Date(), payload: null, leaseUntil: null, nextAttemptAt: null, error: note ? note.slice(0, 500) : null })
        .where(and(eq(webhookEvents.organizationId, organizationId), eq(webhookEvents.id, id))),
    );
    return "done";
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const dead = ev.attempts >= WEBHOOK_MAX_ATTEMPTS;
    await withOrg(organizationId, async (t) => {
      await t
        .update(webhookEvents)
        .set({ status: dead ? "dead" : "failed", error: detail, leaseUntil: null, processedAt: null, nextAttemptAt: dead ? null : new Date(Date.now() + webhookBackoffMs(ev.attempts)) })
        .where(and(eq(webhookEvents.organizationId, organizationId), eq(webhookEvents.id, id)));
      if (dead) {
        await t.insert(messages).values({
          organizationId,
          patientId: null,
          channel: "none",
          direction: "inbound",
          subject: `Eingang von ${ev.provider} konnte nicht verarbeitet werden – bitte prüfen`,
          body: [
            `Ein Ereignis von ${ev.provider} (eingegangen ${ev.receivedAt.toISOString()}) ist nach ${ev.attempts} Versuchen endgültig fehlgeschlagen.`,
            `Fehler: ${detail}`,
            ev.provider === "sumup" ? "Bitte im SumUp-Konto prüfen, ob eine Zahlung eingegangen ist, und sie ggf. manuell buchen." : "Bitte beim Anbieter prüfen, ob eine Nachricht fehlt.",
            "Status: Einstellungen → Schnittstellen.",
          ].join("\n"),
          status: "new",
          threadKey: `webhook-dead:${id}`,
        });
      }
    });
    await logSync(organizationId, ev.provider as WebhookProvider, { direction: "in", ok: false, message: `Webhook-Verarbeitung fehlgeschlagen (Versuch ${ev.attempts}${dead ? ", aufgegeben" : ""}): ${detail}` }).catch(() => undefined);
    return dead ? "dead" : "failed";
  }
}

/**
 * Cron (alle 15 min, /api/cron/reminders): fällige Wiederholungen und liegengebliebene Ereignisse je Praxis
 * verarbeiten, danach alte Ereignisse löschen (Aufbewahrung WEBHOOK_RETENTION_DAYS).
 */
export async function retryDueWebhooks(opts: { now?: Date; limitPerOrg?: number; dispatch?: typeof dispatchWebhook; organizationIds?: string[] } = {}) {
  const now = opts.now ?? new Date();
  const out = { processed: 0, failed: 0, dead: 0, purged: 0 };
  const orgs = opts.organizationIds?.map((id) => ({ id })) ?? (await db.select({ id: organizations.id }).from(organizations));
  for (const { id: org } of orgs) {
    const due = await withOrg(org, async (t) => {
      const del = await t
        .delete(webhookEvents)
        .where(and(eq(webhookEvents.organizationId, org), lt(webhookEvents.receivedAt, new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * 86400_000)), inArray(webhookEvents.status, ["done", "dead"])))
        .returning({ id: webhookEvents.id });
      out.purged += del.length;
      return t
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.organizationId, org),
            or(
              and(eq(webhookEvents.status, "pending"), lt(webhookEvents.receivedAt, new Date(now.getTime() - FRESH_GRACE_MS))),
              and(eq(webhookEvents.status, "failed"), or(isNull(webhookEvents.nextAttemptAt), lte(webhookEvents.nextAttemptAt, now))),
              and(eq(webhookEvents.status, "processing"), lt(webhookEvents.leaseUntil, now)),
            ),
          ),
        )
        .orderBy(webhookEvents.receivedAt)
        .limit(opts.limitPerOrg ?? 50);
    });
    for (const ev of due) {
      const r = await processWebhookEvent(org, ev.id, { dispatch: opts.dispatch });
      if (r === "done") out.processed++;
      else if (r === "failed") out.failed++;
      else if (r === "dead") out.dead++;
    }
  }
  return out;
}

/** Übersicht für die Praxis (Einstellungen → Schnittstellen): Anzahl je Status und die letzten Probleme. */
export async function webhookStatus(organizationId: string) {
  return withOrg(organizationId, async (t) => {
    const counts = await t
      .select({ status: webhookEvents.status, n: sql<number>`count(*)::int` })
      .from(webhookEvents)
      .where(eq(webhookEvents.organizationId, organizationId))
      .groupBy(webhookEvents.status);
    const problems = await t
      .select({ id: webhookEvents.id, provider: webhookEvents.provider, status: webhookEvents.status, attempts: webhookEvents.attempts, error: webhookEvents.error, receivedAt: webhookEvents.receivedAt, nextAttemptAt: webhookEvents.nextAttemptAt })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.organizationId, organizationId), inArray(webhookEvents.status, ["failed", "dead", "processing", "pending"])))
      .orderBy(desc(webhookEvents.receivedAt))
      .limit(10);
    return { counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Record<string, number>, problems };
  });
}

/** Health-Check: Anzahl Ereignisse, die seit über `olderThanMs` unverarbeitet sind (über alle Praxen, nur Zähler). */
export async function webhookBacklog(olderThanMs = 3600_000, organizationIds?: string[]): Promise<{ open: number; dead: number }> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const orgs = organizationIds?.map((id) => ({ id })) ?? (await db.select({ id: organizations.id }).from(organizations));
  let open = 0;
  let dead = 0;
  for (const { id: org } of orgs) {
    const rows = await withOrg(org, (t) =>
      t
        .select({ status: webhookEvents.status, n: sql<number>`count(*)::int` })
        .from(webhookEvents)
        .where(and(eq(webhookEvents.organizationId, org), inArray(webhookEvents.status, ["pending", "processing", "failed", "dead"]), lt(webhookEvents.receivedAt, cutoff)))
        .groupBy(webhookEvents.status),
    );
    for (const r of rows) {
      if (r.status === "dead") dead += Number(r.n);
      else open += Number(r.n);
    }
  }
  return { open, dead };
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
    // Kartenzahlung am Terminal ist ein Kassenvorgang → TSE-Signatur (KassenSichV). Fällt die TSE aus, wird die Zahlung
    // trotzdem gebucht (das Geld ist eingegangen) und der Ausfall im Posteingang gemeldet (TSE-Ausfall dokumentieren).
    let signed: SignedPayment | null = null;
    let signFailed = false;
    if (needsSignature(input.method)) {
      const vat = await t
        .select({ rate: invoiceLines.vatRate, gross: sql<number>`coalesce(sum(${invoiceLines.totalCents}), 0)::int` })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.organizationId, organizationId), eq(invoiceLines.invoiceId, inv.id)))
        .groupBy(invoiceLines.vatRate);
      try {
        signed = await signRegisterPayment({ reference: inv.number ?? inv.id, method: input.method, amountCents: input.amountCents, vatGroups: vat.map((v) => ({ rate: v.rate, grossCents: Number(v.gross) })) });
      } catch (e) {
        if (!(e instanceof FiscalSignError)) throw e;
        signFailed = true;
      }
    }
    await t.insert(payments).values({
      ...(signed ? { id: signed.paymentId } : {}),
      organizationId,
      invoiceId: inv.id,
      method: input.method,
      amountCents: input.amountCents,
      paidAt: input.paidAt ?? new Date(),
      externalRef: input.externalRef,
    });
    if (signed) await storeSignature(t, organizationId, signed);
    if (signFailed)
      await t.insert(messages).values({
        organizationId,
        patientId: null,
        channel: "none",
        direction: "inbound",
        subject: "TSE-Ausfall: Kartenzahlung ohne Signatur gebucht",
        body: `Die Kartenzahlung zu Rechnung ${inv.number ?? "?"} (${(input.amountCents / 100).toFixed(2).replace(".", ",")} €) wurde gebucht, konnte aber nicht über die TSE signiert werden. Bitte den TSE-Ausfall dokumentieren (Steuerberatung) und die TSE-Verbindung prüfen.`,
        status: "new",
        threadKey: `tse-fail:${input.externalRef}`.slice(0, 300),
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
