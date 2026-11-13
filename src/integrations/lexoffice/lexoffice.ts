/**
 * lexoffice / Lexware Office – echter Adapter (PLAN 6.1, 14.4).
 *
 * Doku: https://developers.lexoffice.io/docs/
 * - Basis: https://api.lexoffice.io/v1 (neu auch https://api.lexware.io/v1 – über config.baseUrl umstellbar)
 * - Auth:  `Authorization: Bearer <API-Key>` (Key pro Mandant, verschlüsselt in integration_connections)
 * - Rate-Limit: ca. 2 Anfragen/s → Limiter mit 500 ms Abstand + Retry bei HTTP 429
 *
 * Grundsatz: Das CRM ist führend für Rechnungsnummern, Mischzahlungen und Gutscheine.
 * lexoffice erhält nur Buchungsbelege über die Voucher-API (`POST /vouchers`, taxType "gross"),
 * ohne medizinische Inhalte (Diagnosen, Befunde) – nur Beträge, Steuersätze, Nummer, Datum.
 */
import { IntegrationNotConfiguredError } from "../errors";
import { RateLimiter, requestJson } from "../http";
import { dateToLexofficeTimestamp } from "../time";
import type {
  AccountingContactInput,
  AccountingPaymentStatus,
  AccountingPort,
  AccountingVoucherInput,
  FetchLike,
} from "../types";

export const LEXOFFICE_DEFAULT_BASE_URL = "https://api.lexoffice.io/v1";
/** lexoffice-Buchungskategorie „Einnahmen“ (Standard). Für steuerfreie Heilbehandlung ggf. andere Kategorie konfigurieren. */
export const LEXOFFICE_CATEGORY_REVENUE = "8f8664a8-fd86-11e1-a21f-0800200c9a66";
const DOCS = "https://developers.lexoffice.io/docs/";

/** Ein Limiter pro API-Key (prozessweit), damit parallele Requests das Limit nicht reißen. */
const limiters = new Map<string, RateLimiter>();
function limiterFor(key: string): RateLimiter {
  let l = limiters.get(key);
  if (!l) {
    l = new RateLimiter(500);
    limiters.set(key, l);
  }
  return l;
}

export interface LexofficeOptions {
  apiKey?: string | null;
  baseUrl?: string;
  /** Kategorie für steuerfreie Positionen (0 %) */
  categoryIdTaxFree?: string;
  /** Kategorie für steuerpflichtige Positionen (7/19 %) */
  categoryIdTaxable?: string;
  fetch?: FetchLike;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
}

type LexContact = {
  id: string;
  version: number;
  roles?: Record<string, unknown>;
  person?: { salutation?: string; firstName?: string; lastName: string };
  [k: string]: unknown;
};

const euro = (cents: number) => Math.round(cents) / 100;

function mapKind(kind: AccountingVoucherInput["kind"]): "salesinvoice" | "salescreditnote" {
  return kind === "credit_note" ? "salescreditnote" : "salesinvoice";
}

function mapPaymentStatus(raw: { openAmount?: number; paymentStatus?: string; voucherStatus?: string }, totalKnown?: number): AccountingPaymentStatus {
  const vs = raw.voucherStatus;
  if (vs === "voided") return "voided";
  if (vs === "paid" || vs === "paidoff" || raw.paymentStatus === "balanced") return "paid";
  if (typeof raw.openAmount === "number" && totalKnown !== undefined && raw.openAmount > 0 && raw.openAmount < totalKnown) {
    return "partially_paid";
  }
  if (vs === "open" || vs === "overdue" || raw.paymentStatus === "openRevenue") return "open";
  return "unknown";
}

export class LexofficeAdapter implements AccountingPort {
  readonly provider = "lexoffice" as const;
  readonly isMock = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: LexofficeOptions) {
    if (!opts.apiKey) throw new IntegrationNotConfiguredError("lexoffice", "API-Key fehlt", DOCS);
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? LEXOFFICE_DEFAULT_BASE_URL;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.limiter = opts.limiter ?? limiterFor(this.apiKey);
  }

  private req<T>(method: string, path: string, body?: unknown, rawBody?: BodyInit): Promise<T> {
    return requestJson<T>({
      provider: "lexoffice",
      fetch: this.fetchFn,
      baseUrl: this.baseUrl,
      method,
      path,
      body,
      rawBody,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      limiter: this.limiter,
      sleep: this.opts.sleep,
    });
  }

  /** Verbindungstest: GET /profile liefert Firmenname der lexoffice-Organisation. */
  async ping(): Promise<string> {
    const p = await this.req<{ companyName?: string; organizationId?: string }>("GET", "/profile");
    return p?.companyName ?? p?.organizationId ?? "lexoffice";
  }

  /** Baut den Kontakt-Body (Rolle Kunde, Person). */
  static contactBody(input: AccountingContactInput, version = 0): Record<string, unknown> {
    const salutation = input.salutation && ["Herr", "Frau"].includes(input.salutation) ? input.salutation : undefined;
    const body: Record<string, unknown> = {
      version,
      roles: { customer: {} },
      person: { salutation, firstName: input.firstName ?? undefined, lastName: input.lastName },
    };
    if (input.street || input.zip || input.city) {
      body.addresses = {
        billing: [{ street: input.street ?? undefined, zip: input.zip ?? undefined, city: input.city ?? undefined, countryCode: input.countryCode ?? "DE" }],
      };
    }
    if (input.email) body.emailAddresses = { private: [input.email] };
    if (input.phone) body.phoneNumbers = { private: [input.phone] };
    if (input.customerNumber !== undefined && input.customerNumber !== null) body.note = `PodoHero-Patientennr. ${input.customerNumber}`;
    return body;
  }

  async upsertContact(input: AccountingContactInput): Promise<{ externalId: string; version: number }> {
    if (input.externalId) {
      const existing = await this.req<LexContact>("GET", `/contacts/${encodeURIComponent(input.externalId)}`);
      const body = { ...LexofficeAdapter.contactBody(input, existing.version), roles: existing.roles ?? { customer: {} } };
      const res = await this.req<{ id: string; version: number }>("PUT", `/contacts/${encodeURIComponent(input.externalId)}`, body);
      return { externalId: res.id, version: res.version };
    }
    const res = await this.req<{ id: string; version: number }>("POST", "/contacts", LexofficeAdapter.contactBody(input));
    return { externalId: res.id, version: res.version };
  }

  /** Baut den Voucher-Body (Bruttobeträge in Euro, taxType "gross"). */
  voucherBody(input: AccountingVoucherInput): Record<string, unknown> {
    // Positionen nach Steuersatz zusammenfassen – lexoffice braucht keine Einzelleistungen
    const byRate = new Map<number, number>();
    for (const l of input.lines) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.grossCents);
    const voucherItems = [...byRate.entries()].map(([rate, gross]) => {
      const tax = Math.round((gross * rate) / (100 + rate));
      const explicit = input.lines.find((l) => l.vatRate === rate && l.categoryId)?.categoryId;
      return {
        amount: euro(gross),
        taxAmount: euro(tax),
        taxRatePercent: rate,
        categoryId:
          explicit ??
          (rate === 0 ? this.opts.categoryIdTaxFree : this.opts.categoryIdTaxable) ??
          LEXOFFICE_CATEGORY_REVENUE,
      };
    });
    return {
      type: mapKind(input.kind),
      voucherNumber: input.number,
      voucherDate: dateToLexofficeTimestamp(input.date),
      shippingDate: dateToLexofficeTimestamp(input.date),
      dueDate: dateToLexofficeTimestamp(input.dueDate ?? input.date),
      totalGrossAmount: euro(input.totalGrossCents),
      totalTaxAmount: euro(input.totalTaxCents),
      taxType: "gross",
      useCollectiveContact: !input.contactExternalId,
      contactId: input.contactExternalId ?? undefined,
      remark: input.remark ?? `${input.kind === "receipt" ? "Quittung" : "Rechnung"} ${input.number} (PodoHero)`,
      voucherItems,
    };
  }

  async pushVoucher(input: AccountingVoucherInput): Promise<{ externalId: string }> {
    const res = await this.req<{ id: string }>("POST", "/vouchers", this.voucherBody(input));
    if (input.pdf) {
      const form = new FormData();
      form.append("file", new Blob([input.pdf.data as BlobPart], { type: "application/pdf" }), input.pdf.filename);
      form.append("type", "voucher");
      await this.req("POST", `/vouchers/${encodeURIComponent(res.id)}/files`, undefined, form);
    }
    return { externalId: res.id };
  }

  async getPaymentStatus(externalId: string) {
    const raw = await this.req<{ openAmount?: number; paymentStatus?: string; voucherStatus?: string; paymentItems?: { amount: number }[] }>(
      "GET",
      `/payments/${encodeURIComponent(externalId)}`,
    );
    const paid = (raw.paymentItems ?? []).reduce((a, p) => a + Math.abs(p.amount ?? 0), 0);
    const total = typeof raw.openAmount === "number" ? raw.openAmount + paid : undefined;
    return {
      status: mapPaymentStatus(raw, total),
      openCents: Math.round((raw.openAmount ?? 0) * 100),
      raw,
    };
  }
}

/**
 * lexoffice-Event-Subscriptions (Webhooks) → normalisiertes Ereignis.
 * Payload: { organizationId, eventType: "voucher.changed" | "payment.changed" | …, resourceId, eventDate }.
 * Signatur: Header `X-Lxo-Signature` (RSA-SHA512, öffentlicher Schlüssel von lexoffice) – TODO prüfen,
 * siehe https://developers.lexoffice.io/docs/#event-subscriptions-endpoint-signature
 * Bis dahin: Payload nie vertrauen, sondern Status per API nachladen (needsFetch).
 */
export function handleLexofficeWebhook(payload: unknown) {
  const p = (payload ?? {}) as { eventType?: string; resourceId?: string; eventDate?: string };
  return {
    provider: "lexoffice" as const,
    externalId: `${p.eventType ?? "unknown"}:${p.resourceId ?? "?"}:${p.eventDate ?? ""}`,
    type: p.eventType ?? "unknown",
    objectId: p.resourceId ?? null,
    status: null,
    needsFetch: true,
    raw: payload,
  };
}
