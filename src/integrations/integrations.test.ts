import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { encryptJson } from "@/lib/crypto";
import { IntegrationNotConfiguredError } from "./errors";
import { RateLimiter, requestJson } from "./http";
import { LexofficeAdapter } from "./lexoffice/lexoffice";
import { LlmMock } from "./llm/mock";
import { OpenAiCompatibleLlm, extractJson } from "./llm/openai-compatible";
import { getAdapter } from "./registry";
import { SumupAdapter, handleSumupWebhook, verifyHmacSignature } from "./sumup/sumup";
import { berlinLocalToIso, dateToLexofficeTimestamp } from "./time";
import type { FetchLike } from "./types";
import { handleWhatsAppWebhook } from "./webhooks";

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: (Response | (() => Response))[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)];
      return typeof r === "function" ? r() : r.clone();
    },
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

describe("Zeit", () => {
  it("berechnet Berliner Offset inkl. Sommerzeit", () => {
    expect(berlinLocalToIso(2026, 11, 9, 10, 30)).toBe("2026-11-09T10:30:00+01:00");
    expect(berlinLocalToIso(2026, 7, 1, 8, 0)).toBe("2026-07-01T08:00:00+02:00");
    expect(dateToLexofficeTimestamp("2026-03-02")).toBe("2026-03-02T00:00:00.000+01:00");
  });
});

describe("HTTP / Rate-Limit", () => {
  it("wiederholt bei 429 mit Retry-After", async () => {
    const { fetch, calls } = fakeFetch([json({ message: "too many" }, 429, { "retry-after": "1" }), json({ ok: true })]);
    const waits: number[] = [];
    const res = await requestJson<{ ok: boolean }>({
      provider: "lexoffice",
      fetch,
      baseUrl: "https://x.invalid",
      path: "/a",
      sleep: async (ms) => void waits.push(ms),
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("Limiter hält Mindestabstand ein", async () => {
    let now = 0;
    const waits: number[] = [];
    const l = new RateLimiter(500, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await Promise.all([1, 2, 3].map((n) => l.schedule(async () => n)));
    expect(waits).toEqual([500, 500]);
  });
});

describe("lexoffice", () => {
  it("legt Kontakt an und sendet Bruttobeleg", async () => {
    const { fetch, calls } = fakeFetch([json({ id: "c1", version: 0 }), json({ id: "v1", version: 0 })]);
    const lex = new LexofficeAdapter({ apiKey: "k", fetch, sleep: noSleep, limiter: new RateLimiter(0) });
    const c = await lex.upsertContact({ lastName: "Beispiel", firstName: "Erika", salutation: "Frau", city: "Musterstadt" });
    expect(c.externalId).toBe("c1");
    expect(calls[0].url).toBe("https://api.lexoffice.io/v1/contacts");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer k");

    const v = await lex.pushVoucher({
      invoiceId: "i1",
      number: "2026-0001",
      kind: "invoice",
      date: "2026-03-02",
      totalGrossCents: 8450,
      totalTaxCents: 311,
      lines: [
        { grossCents: 6500, vatRate: 0 },
        { grossCents: 1950, vatRate: 19 },
      ],
      contactExternalId: "c1",
    });
    expect(v.externalId).toBe("v1");
    const body = JSON.parse(String(calls[1].init?.body));
    expect(calls[1].url).toBe("https://api.lexoffice.io/v1/vouchers");
    expect(body).toMatchObject({
      type: "salesinvoice",
      voucherNumber: "2026-0001",
      taxType: "gross",
      totalGrossAmount: 84.5,
      contactId: "c1",
      useCollectiveContact: false,
    });
    expect(body.voucherItems).toEqual([
      expect.objectContaining({ amount: 65, taxAmount: 0, taxRatePercent: 0 }),
      expect.objectContaining({ amount: 19.5, taxAmount: 3.11, taxRatePercent: 19 }),
    ]);
  });

  it("liest Zahlungsstatus", async () => {
    const { fetch } = fakeFetch([json({ openAmount: 0, paymentStatus: "balanced", voucherStatus: "paid", paymentItems: [{ amount: 65 }] })]);
    const lex = new LexofficeAdapter({ apiKey: "k", fetch, limiter: new RateLimiter(0) });
    expect((await lex.getPaymentStatus("v1")).status).toBe("paid");
  });

  it("ohne API-Key: nicht konfiguriert", () => {
    expect(() => new LexofficeAdapter({})).toThrow(IntegrationNotConfiguredError);
  });
});

describe("SumUp", () => {
  it("erstellt Checkout und Reader-Zahlung", async () => {
    const { fetch, calls } = fakeFetch([
      json({ id: "chk1", status: "PENDING", hosted_checkout_url: "https://pay.sumup.com/x" }),
      json({ data: { client_transaction_id: "ctx1" } }, 201),
    ]);
    const s = new SumupAdapter({ accessToken: "t", merchantCode: "M123", fetch });
    const c = await s.createCheckout({ reference: "inv-1", amountCents: 6500, description: "Rechnung 2026-0001" });
    expect(c).toEqual({ checkoutId: "chk1", url: "https://pay.sumup.com/x", status: "pending" });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ amount: 65, currency: "EUR", merchant_code: "M123" });
    const r = await s.startTerminalPayment({ readerId: "rdr 1", amountCents: 6500 });
    expect(r.clientTransactionId).toBe("ctx1");
    expect(calls[1].url).toBe("https://api.sumup.com/v0.1/merchants/M123/readers/rdr%201/checkout");
    expect(JSON.parse(String(calls[1].init?.body)).total_amount).toEqual({ value: 6500, currency: "EUR", minor_unit: 2 });
  });

  it("prüft Webhook-Signatur und normalisiert Ereignis", () => {
    const secret = "whsec";
    const body = JSON.stringify({ id: "evt1", event_type: "solo.transaction.updated", payload: { client_transaction_id: "ctx1", status: "successful" } });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmacSignature(body, sig, secret)).toBe(true);
    expect(verifyHmacSignature(body, "00" + sig.slice(2), secret)).toBe(false);
    const adapter = new SumupAdapter({ accessToken: "t", merchantCode: "M", webhookSecret: secret });
    const ev = handleSumupWebhook(body, { "X-Payload-Signature": sig }, (b, h) => adapter.verifyWebhook(b, h));
    expect(ev).toMatchObject({ externalId: "evt1", objectId: "ctx1", status: "paid", needsFetch: true });
    expect(() => handleSumupWebhook(body, { "x-payload-signature": "bad" }, (b, h) => adapter.verifyWebhook(b, h))).toThrow();
    expect(handleSumupWebhook({ event_type: "CHECKOUT_STATUS_CHANGED", id: "chk1" }).objectId).toBe("chk1");
  });
});

describe("LLM", () => {
  it("redigiert vor dem Versand und stellt Namen danach wieder her", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        choices: [
          {
            message: {
              content:
                '```json\n{"findings":"[NAME_1]: Nagel D1 eingewachsen","services":"Nägel gekürzt","material":"Spange","reaction":"gut","recommendation":"Kontrolle"}\n```',
            },
          },
        ],
      }),
    ]);
    const llm = new OpenAiCompatibleLlm({ baseUrl: "https://llm.example.invalid/v1", apiKey: "k", model: "m", dataProcessingApproved: true, fetch });
    const r = await llm.structureReport("Erika Beispiel, Tel. 0171 1234567: Nagel D1 eingewachsen.", { knownNames: ["Erika Beispiel"] });
    const sent = String(calls[0].init?.body);
    expect(sent).not.toContain("Erika");
    expect(sent).not.toContain("0171");
    expect(r.findings).toBe("Erika Beispiel: Nagel D1 eingewachsen");
  });

  it("verweigert ohne Datenschutz-Freigabe", async () => {
    const llm = new OpenAiCompatibleLlm({ baseUrl: "https://x.invalid", apiKey: "k", model: "m", fetch: fakeFetch([json({})]).fetch });
    await expect(llm.suggestReply("Hallo")).rejects.toThrow(/nicht freigegeben/);
  });

  it("extrahiert JSON robust", () => {
    expect(extractJson('Antwort: {"a":1} danke')).toEqual({ a: 1 });
  });

  it("Mock strukturiert deterministisch", async () => {
    const r = await new LlmMock().structureReport("Nagel eingewachsen. Spange gesetzt mit Material M. Gut vertragen. Kontrolle in 4 Wochen.");
    expect(r.findings).toContain("Nagel");
    expect(r.material).toContain("Spange");
    expect(r.reaction).toContain("vertragen");
    expect(r.recommendation).toContain("Kontrolle");
  });
});

describe("Registry", () => {
  const original = { mode: process.env.INTEGRATIONS_MODE, key: process.env.APP_ENCRYPTION_KEY };
  afterEach(() => {
    process.env.INTEGRATIONS_MODE = original.mode;
    process.env.APP_ENCRYPTION_KEY = original.key;
  });

  it("liefert Mock bei INTEGRATIONS_MODE=mock oder Status mock", () => {
    process.env.INTEGRATIONS_MODE = "mock";
    expect(getAdapter("lexoffice").isMock).toBe(true);
    delete process.env.INTEGRATIONS_MODE;
    expect(getAdapter("sumup", { status: "mock" }).isMock).toBe(true);
    expect(getAdapter("whatsapp", { status: "mock" }).provider).toBe("whatsapp");
  });

  it("baut echten Adapter mit entschlüsseltem Geheimnis", () => {
    delete process.env.INTEGRATIONS_MODE;
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const a = getAdapter("lexoffice", { status: "connected", secretEnc: encryptJson({ apiKey: "abc" }) });
    expect(a.isMock).toBe(false);
    expect(() => getAdapter("sumup", { status: "connected", secret: { apiKey: "x" } })).toThrow(/merchant_code/);
    expect(() => getAdapter("google_business", { status: "disconnected" })).toThrow(IntegrationNotConfiguredError);
  });

  it("Mock-Zahlung schlägt bei ...13 Cent fehl", async () => {
    const p = getAdapter("sumup", { status: "mock" });
    const { checkoutId } = await p.createCheckout({ reference: "r", amountCents: 1013 });
    expect((await p.getTransaction(checkoutId)).status).toBe("failed");
  });
});

describe("WhatsApp-Webhook", () => {
  it("normalisiert Textnachrichten", () => {
    const msgs = handleWhatsAppWebhook({
      entry: [{ changes: [{ value: { metadata: { display_phone_number: "4930000000" }, messages: [{ id: "wamid.1", from: "491701234567", timestamp: "1767225600", type: "text", text: { body: "Kann ich den Termin verschieben?" } }] } }] }],
    });
    expect(msgs).toEqual([
      expect.objectContaining({ channel: "whatsapp", externalId: "wamid.1", from: "+491701234567", body: "Kann ich den Termin verschieben?" }),
    ]);
  });
});
