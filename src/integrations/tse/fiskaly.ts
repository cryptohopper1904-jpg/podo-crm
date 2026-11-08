/**
 * fiskaly SIGN DE (Cloud-TSE) – Adapter-GERÜST, ungetestet gegen die echte API.
 *
 * Doku: https://developer.fiskaly.com/api/kassensichv/v2
 * Basis: https://kassensichv-middleware.fiskaly.com/api/v2
 *  - Auth:          POST /auth                                   { api_key, api_secret } → { access_token, … }
 *  - TSS anlegen:   PUT  /tss/{tss_id}                           (einmalig bei der Einrichtung, danach Zustand INITIALIZED)
 *  - Client:        PUT  /tss/{tss_id}/client/{client_id}        { serial_number } (= Kasse/Arbeitsplatz)
 *  - Transaktion:   PUT  /tss/{tss_id}/tx/{tx_id}?tx_revision=1  { state: "ACTIVE", client_id }
 *  - Abschluss:     PUT  /tss/{tss_id}/tx/{tx_id}?tx_revision=2  { state: "FINISHED", client_id, schema: { standard_v1: { receipt: { receipt_type: "RECEIPT",
 *                        amounts_per_vat_rate: [{ vat_rate: "NORMAL"|"REDUCED_1"|"NULL", amount: "12.34" }],
 *                        amounts_per_payment_type: [{ payment_type: "CASH"|"NON_CASH", amount: "12.34" }] } } } }
 *                    → { number, signature: { value, counter }, time_start, time_end, tss_serial_number, … }
 *  - TSE-Export:    PUT  /tss/{tss_id}/export/{export_id}        (TAR nach BSI TR-03153)
 * DSFinV-K: https://developer.fiskaly.com/api/dsfinvk/v1 – Basis https://dsfinvk.fiskaly.com/api/v1
 *  - Kassenabschluss: PUT /cash_point_closings/{closing_id}
 *  - Export:          PUT /exports/{export_id}  { start_date, end_date }  → GET /exports/{export_id}/download
 *
 * Voraussetzungen (Praxis): Vertrag mit fiskaly, TSS + Client angelegt, PIN/PUK sicher verwahrt,
 * Meldung der Kasse ans Finanzamt (§ 146a Abs. 4 AO), Verfahrensdokumentation.
 */
import { randomUUID } from "node:crypto";
import { FiscalNotConfiguredError, type FiscalExportInput, type FiscalFinishInput, type FiscalPort, type FiscalSignature } from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FiskalyOptions {
  apiKey?: string | null;
  apiSecret?: string | null;
  tssId?: string | null;
  clientId?: string | null;
  baseUrl?: string;
  dsfinvkBaseUrl?: string;
  fetch?: FetchLike;
}

const VAT: Record<number, string> = { 19: "NORMAL", 7: "REDUCED_1", 0: "NULL" };
const euro = (cents: number) => (cents / 100).toFixed(2);

export class FiskalyAdapter implements FiscalPort {
  readonly vendor = "fiskaly" as const;
  readonly isMock = false;
  private token: { value: string; until: number } | null = null;
  private readonly fetchFn: FetchLike;
  private readonly base: string;
  private readonly dsfinvkBase: string;

  constructor(private readonly opts: FiskalyOptions) {
    if (!opts.apiKey || !opts.apiSecret) throw new FiscalNotConfiguredError("fiskaly API-Key/Secret fehlen");
    if (!opts.tssId || !opts.clientId) throw new FiscalNotConfiguredError("fiskaly TSS-ID/Client-ID fehlen");
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.base = opts.baseUrl ?? "https://kassensichv-middleware.fiskaly.com/api/v2";
    this.dsfinvkBase = opts.dsfinvkBaseUrl ?? "https://dsfinvk.fiskaly.com/api/v1";
  }

  private async call<T>(base: string, method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) headers.Authorization = `Bearer ${await this.accessToken()}`;
    const res = await this.fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
    if (!res.ok) throw new Error(`fiskaly: ${method} ${path} fehlgeschlagen (HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 30_000) return this.token.value;
    const r = await this.call<{ access_token: string; access_token_expires_in?: number }>(
      this.base,
      "POST",
      "/auth",
      { api_key: this.opts.apiKey, api_secret: this.opts.apiSecret },
      false,
    );
    this.token = { value: r.access_token, until: Date.now() + (r.access_token_expires_in ?? 300) * 1000 };
    return r.access_token;
  }

  async startTransaction() {
    const txId = randomUUID();
    const r = await this.call<{ time_start?: number }>(this.base, "PUT", `/tss/${this.opts.tssId}/tx/${txId}?tx_revision=1`, {
      state: "ACTIVE",
      client_id: this.opts.clientId,
    });
    return { transactionId: txId, startedAt: r.time_start ? new Date(r.time_start * 1000).toISOString() : new Date().toISOString() };
  }

  async finishTransaction(input: FiscalFinishInput): Promise<FiscalSignature> {
    const r = await this.call<{
      number: number;
      time_start: number;
      time_end: number;
      tss_serial_number: string;
      signature: { value: string; counter: number };
    }>(this.base, "PUT", `/tss/${this.opts.tssId}/tx/${input.transactionId}?tx_revision=2`, {
      state: "FINISHED",
      client_id: this.opts.clientId,
      schema: {
        standard_v1: {
          receipt: {
            receipt_type: "RECEIPT",
            amounts_per_vat_rate: input.amounts.map((a) => ({ vat_rate: VAT[a.vatRate] ?? "NORMAL", amount: euro(a.grossCents) })),
            amounts_per_payment_type: [{ payment_type: input.paymentType === "cash" ? "CASH" : "NON_CASH", amount: euro(input.paymentCents) }],
          },
        },
      },
    });
    return {
      transactionId: input.transactionId,
      number: r.number,
      signatureCounter: r.signature.counter,
      signature: r.signature.value,
      startedAt: new Date(r.time_start * 1000).toISOString(),
      finishedAt: new Date(r.time_end * 1000).toISOString(),
      tssSerial: r.tss_serial_number,
      isTest: false,
    };
  }

  async exportDsfinvk(input: FiscalExportInput) {
    // TODO: Kassenabschlüsse (cash_point_closings) müssen vorher täglich übertragen werden.
    const exportId = randomUUID();
    await this.call(this.dsfinvkBase, "PUT", `/exports/${exportId}`, { start_date: input.from, end_date: input.to });
    return { exportId, status: "pending" as const, downloadUrl: `${this.dsfinvkBase}/exports/${exportId}/download` };
  }
}
