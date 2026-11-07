/**
 * SumUp – echter Adapter (PLAN 6.3).
 *
 * Doku: https://developer.sumup.com/api
 * - Basis: https://api.sumup.com
 * - Auth:  `Authorization: Bearer <API-Key oder OAuth-Access-Token>`
 * - Zahlungslink/Online-Checkout: POST /v0.1/checkouts (hosted_checkout aktiviert → hosted_checkout_url)
 * - Solo-Reader (Cloud API): POST /v0.1/merchants/{merchant_code}/readers/{reader_id}/checkout
 * - Transaktionen: GET /v2.1/merchants/{merchant_code}/transactions?id=… bzw. ?client_transaction_id=…
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { IntegrationNotConfiguredError } from "../errors";
import { requestJson } from "../http";
import type {
  CheckoutInput,
  CheckoutResult,
  FetchLike,
  NormalizedWebhookEvent,
  PaymentPort,
  PaymentTransaction,
  PaymentTxStatus,
  TerminalPaymentInput,
} from "../types";

export const SUMUP_BASE_URL = "https://api.sumup.com";
const DOCS = "https://developer.sumup.com/api";

export interface SumupOptions {
  /** API-Key (sup_sk_…) oder OAuth-Access-Token */
  accessToken?: string | null;
  merchantCode?: string | null;
  /** Geheimnis zur Prüfung der Webhook-Signatur */
  webhookSecret?: string | null;
  /** Header-Name der Signatur (Standard: x-payload-signature) – TODO mit aktueller SumUp-Doku abgleichen */
  signatureHeader?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export function mapSumupStatus(s: string | undefined | null): PaymentTxStatus {
  switch ((s ?? "").toUpperCase()) {
    case "PAID":
    case "SUCCESSFUL":
    case "SUCCESS":
      return "paid";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    case "REFUNDED":
    case "CHARGE_BACK":
      return "refunded";
    default:
      return "unknown";
  }
}

/**
 * HMAC-SHA256-Prüfung des rohen Request-Bodys (zeitkonstanter Vergleich).
 * Akzeptiert hex oder base64, optional mit Präfix „sha256=“.
 */
export function verifyHmacSignature(rawBody: string, signature: string | undefined | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const sig = signature.trim().replace(/^sha256=/i, "");
  const mac = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const candidates = [Buffer.from(sig, "hex"), Buffer.from(sig, "base64")];
  return candidates.some((c) => c.length === mac.length && timingSafeEqual(c, mac));
}

function lowerHeaders(h: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

export class SumupAdapter implements PaymentPort {
  readonly provider = "sumup" as const;
  readonly isMock = false;
  private readonly token: string;
  private readonly merchantCode: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: SumupOptions) {
    if (!opts.accessToken) throw new IntegrationNotConfiguredError("sumup", "API-Key/Access-Token fehlt", DOCS);
    if (!opts.merchantCode) throw new IntegrationNotConfiguredError("sumup", "merchant_code fehlt", DOCS);
    this.token = opts.accessToken;
    this.merchantCode = opts.merchantCode;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>({
      provider: "sumup",
      fetch: this.fetchFn,
      baseUrl: this.opts.baseUrl ?? SUMUP_BASE_URL,
      method,
      path,
      body,
      headers: { Authorization: `Bearer ${this.token}` },
      sleep: this.opts.sleep,
    });
  }

  /** Verbindungstest: GET /v0.1/me (Händlerprofil). */
  async ping(): Promise<string> {
    const me = await this.req<{ merchant_profile?: { merchant_code?: string; company_name?: string } }>("GET", "/v0.1/me");
    return me?.merchant_profile?.company_name ?? me?.merchant_profile?.merchant_code ?? "SumUp";
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const res = await this.req<{ id: string; status?: string; hosted_checkout_url?: string }>("POST", "/v0.1/checkouts", {
      checkout_reference: input.reference,
      amount: input.amountCents / 100,
      currency: input.currency ?? "EUR",
      merchant_code: this.merchantCode,
      description: input.description,
      return_url: input.returnUrl,
      redirect_url: input.redirectUrl,
      hosted_checkout: { enabled: true },
    });
    return { checkoutId: res.id, url: res.hosted_checkout_url ?? null, status: mapSumupStatus(res.status) };
  }

  async startTerminalPayment(input: TerminalPaymentInput): Promise<{ clientTransactionId: string }> {
    const path = `/v0.1/merchants/${encodeURIComponent(this.merchantCode)}/readers/${encodeURIComponent(input.readerId)}/checkout`;
    const res = await this.req<{ data?: { client_transaction_id?: string } }>("POST", path, {
      total_amount: { value: input.amountCents, currency: input.currency ?? "EUR", minor_unit: 2 },
      description: input.description,
      return_url: input.returnUrl,
    });
    const id = res?.data?.client_transaction_id;
    if (!id) throw new Error("SumUp: Antwort ohne client_transaction_id.");
    return { clientTransactionId: id };
  }

  async getTransaction(id: string, by: "id" | "client_transaction_id" | "checkout" = "id"): Promise<PaymentTransaction> {
    if (by === "checkout") {
      const c = await this.req<{
        id: string;
        status?: string;
        amount?: number;
        currency?: string;
        checkout_reference?: string;
        date?: string;
        transactions?: { id: string; status?: string; timestamp?: string }[];
      }>("GET", `/v0.1/checkouts/${encodeURIComponent(id)}`);
      return {
        id: c.id,
        status: mapSumupStatus(c.status),
        amountCents: Math.round((c.amount ?? 0) * 100),
        currency: c.currency ?? "EUR",
        reference: c.checkout_reference ?? null,
        paidAt: c.transactions?.find((t) => mapSumupStatus(t.status) === "paid")?.timestamp ?? null,
        raw: c,
      };
    }
    const q = `${by}=${encodeURIComponent(id)}`;
    const t = await this.req<{
      id: string;
      status?: string;
      amount?: number;
      currency?: string;
      foreign_transaction_id?: string;
      timestamp?: string;
      card?: { type?: string };
    }>("GET", `/v2.1/merchants/${encodeURIComponent(this.merchantCode)}/transactions?${q}`);
    return {
      id: t.id,
      status: mapSumupStatus(t.status),
      amountCents: Math.round((t.amount ?? 0) * 100),
      currency: t.currency ?? "EUR",
      reference: t.foreign_transaction_id ?? null,
      paidAt: t.timestamp ?? null,
      cardType: t.card?.type ?? null,
      raw: t,
    };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean {
    if (!this.opts.webhookSecret) return false;
    const h = lowerHeaders(headers);
    return verifyHmacSignature(rawBody, h[(this.opts.signatureHeader ?? "x-payload-signature").toLowerCase()], this.opts.webhookSecret);
  }
}

/**
 * Normalisiert einen SumUp-Webhook. Der Payload ist NICHT autoritativ – der Zahlungsstatus muss
 * immer per getTransaction nachgeladen werden (needsFetch = true).
 *
 * Bekannte Formen:
 *  - Online-Checkout:  { event_type: "CHECKOUT_STATUS_CHANGED", id: "<checkout-id>" }
 *  - Solo-Reader:      { id, event_type: "solo.transaction.updated", payload: { client_transaction_id, status }, timestamp }
 *
 * @param verify optionale Signaturprüfung (z. B. `adapter.verifyWebhook`); bei false wird ein Fehler geworfen.
 */
export function handleSumupWebhook(
  payload: unknown,
  headers: Record<string, string | undefined> = {},
  verify?: (rawBody: string, headers: Record<string, string | undefined>) => boolean,
): NormalizedWebhookEvent {
  const rawBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (verify && !verify(rawBody, headers)) throw new Error("SumUp-Webhook: Signatur ungültig.");
  const p = (typeof payload === "string" ? JSON.parse(payload) : payload ?? {}) as {
    id?: string;
    event_type?: string;
    timestamp?: string;
    payload?: { client_transaction_id?: string; transaction_id?: string; status?: string };
  };
  const type = p.event_type ?? "unknown";
  if (p.payload?.client_transaction_id) {
    return {
      provider: "sumup",
      externalId: p.id ?? `${type}:${p.payload.client_transaction_id}:${p.timestamp ?? ""}`,
      type,
      objectId: p.payload.client_transaction_id,
      status: mapSumupStatus(p.payload.status),
      needsFetch: true,
      raw: payload,
    };
  }
  return {
    provider: "sumup",
    externalId: `${type}:${p.id ?? "?"}:${p.timestamp ?? ""}`,
    type,
    objectId: p.id ?? null,
    status: null,
    needsFetch: true,
    raw: payload,
  };
}
