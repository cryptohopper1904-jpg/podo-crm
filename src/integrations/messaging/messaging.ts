/**
 * Nachrichtenkanäle (PLAN 6.6–6.8): E-Mail (SMTP/IMAP), WhatsApp Cloud API über BSP, SMS.
 *
 * Datenschutz: WhatsApp nur für Organisatorisches (Termine), keine medizinischen Inhalte,
 * ausdrückliche Einwilligung (consent "whatsapp") mit Risikohinweis. Standard: SMS/E-Mail.
 */
import { IntegrationNotConfiguredError } from "../errors";
import { requestJson } from "../http";
import { mockId } from "../mock-util";
import type { FetchLike, InboundMessage, MessagingPort, MessagingProvider, OutboundMessage } from "../types";

// ───────────── E-Mail (Gerüst) ─────────────
/**
 * Versand: läuft NICHT über diese Klasse, sondern über den MailPort (src/integrations/mail/mail.ts,
 * src/server/mail.ts – adapterFor("email_imap") liefert ihn). Diese Klasse prüft nur die Konfiguration
 * („Verbindung testen“) und normalisiert eingehende Mails.
 * TODO: IMAP-Abruf (z. B. imapflow), alternativ Gmail API bzw. Microsoft Graph.
 */
export class EmailAdapter implements MessagingPort {
  readonly provider = "email_imap" as const;
  readonly isMock = false;
  constructor(private readonly opts: { smtpHost?: string | null; imapHost?: string | null; user?: string | null; password?: string | null }) {
    if (!opts.smtpHost || !opts.user || !opts.password) {
      throw new IntegrationNotConfiguredError("email_imap", "SMTP-Host, Benutzer und Passwort fehlen");
    }
  }
  async send(): Promise<{ externalId: string }> {
    throw new IntegrationNotConfiguredError("email_imap", "Versand bitte über den MailPort (src/server/mail.ts)");
  }
  /** Erwartet eine bereits zerlegte Mail { messageId, from, to, subject, text, date }. */
  parseInbound(payload: unknown): InboundMessage[] {
    const p = payload as { messageId?: string; from?: string; to?: string; subject?: string; text?: string; date?: string; inReplyTo?: string };
    if (!p?.from || !p.text) return [];
    return [
      {
        channel: "email",
        externalId: p.messageId ?? mockId("mail", `${p.from}|${p.date}|${p.subject}`),
        from: p.from,
        to: p.to ?? null,
        subject: p.subject ?? null,
        body: p.text,
        receivedAt: p.date ? new Date(p.date).toISOString() : new Date().toISOString(),
        threadKey: p.inReplyTo ?? p.messageId ?? null,
      },
    ];
  }
}

// ───────────── WhatsApp Cloud API ─────────────
/**
 * Meta WhatsApp Cloud API (direkt oder über BSP wie 360dialog, EU-Hosting bevorzugt).
 * Doku: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * TODO: Webhook-Signatur (X-Hub-Signature-256, HMAC mit App-Secret), Vorlagenverwaltung, Medien.
 * Ungetestet gegen die echte API.
 */
export class WhatsAppAdapter implements MessagingPort {
  readonly provider = "whatsapp" as const;
  readonly isMock = false;
  private readonly fetchFn: FetchLike;
  constructor(private readonly opts: { accessToken?: string | null; phoneNumberId?: string | null; baseUrl?: string; fetch?: FetchLike }) {
    if (!opts.accessToken || !opts.phoneNumberId) {
      throw new IntegrationNotConfiguredError("whatsapp", "Access-Token und phoneNumberId fehlen", "https://developers.facebook.com/docs/whatsapp/cloud-api");
    }
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async send(msg: OutboundMessage): Promise<{ externalId: string }> {
    if (msg.attachments?.length) throw new Error("WhatsApp: Anhänge werden nicht unterstützt (bitte per E-Mail senden).");
    const to = msg.to.replace(/[^\d]/g, "");
    const body = msg.template
      ? {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: msg.template.name,
            language: { code: msg.template.language },
            components: msg.template.params?.length
              ? [{ type: "body", parameters: msg.template.params.map((t) => ({ type: "text", text: t })) }]
              : undefined,
          },
        }
      : { messaging_product: "whatsapp", to, type: "text", text: { body: msg.body } };
    const res = await requestJson<{ messages?: { id: string }[] }>({
      provider: "whatsapp",
      fetch: this.fetchFn,
      baseUrl: this.opts.baseUrl ?? "https://graph.facebook.com/v21.0",
      method: "POST",
      path: `/${encodeURIComponent(this.opts.phoneNumberId!)}/messages`,
      headers: { Authorization: `Bearer ${this.opts.accessToken}` },
      body,
    });
    const id = res?.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp: Antwort ohne Nachrichten-ID.");
    return { externalId: id };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    return parseWhatsAppWebhook(payload);
  }
}

/** Normalisiert den WhatsApp-Webhook (entry[].changes[].value.messages[]). Nur Textnachrichten. */
export function parseWhatsAppWebhook(payload: unknown): InboundMessage[] {
  type Msg = { id: string; from: string; timestamp?: string; type?: string; text?: { body?: string } };
  const p = payload as { entry?: { changes?: { value?: { metadata?: { display_phone_number?: string }; messages?: Msg[] } }[] }[] };
  const out: InboundMessage[] = [];
  for (const e of p?.entry ?? []) {
    for (const c of e.changes ?? []) {
      for (const m of c.value?.messages ?? []) {
        out.push({
          channel: "whatsapp",
          externalId: m.id,
          from: `+${m.from.replace(/^\+/, "")}`,
          to: c.value?.metadata?.display_phone_number ?? null,
          body: m.type === "text" ? m.text?.body ?? "" : `[${m.type ?? "unbekannt"}]`,
          receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
          threadKey: `+${m.from.replace(/^\+/, "")}`,
        });
      }
    }
  }
  return out;
}

// ───────────── SMS (seven.io; sipgate als Alternative) ─────────────
/**
 * seven.io: POST https://gateway.seven.io/api/sms, Header X-Api-Key, Body { to, text, from }.
 * Doku: https://docs.seven.io/en/rest-api/endpoints/sms
 * sipgate: https://developer.sipgate.io/rest-api/ (TODO als Alternative).
 * Ungetestet gegen die echte API.
 */
export class SmsAdapter implements MessagingPort {
  readonly provider = "sms" as const;
  readonly isMock = false;
  private readonly fetchFn: FetchLike;
  constructor(private readonly opts: { apiKey?: string | null; sender?: string | null; vendor?: "seven" | "sipgate"; fetch?: FetchLike }) {
    if (!opts.apiKey) throw new IntegrationNotConfiguredError("sms", "API-Key fehlt", "https://docs.seven.io/en/rest-api/endpoints/sms");
    if (opts.vendor === "sipgate") throw new IntegrationNotConfiguredError("sms", "sipgate-SMS noch nicht implementiert (TODO)");
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async send(msg: OutboundMessage): Promise<{ externalId: string }> {
    if (msg.attachments?.length) throw new Error("SMS: Anhänge werden nicht unterstützt (bitte per E-Mail senden).");
    const res = await requestJson<{ success?: string; messages?: { id?: string | number }[] }>({
      provider: "sms",
      fetch: this.fetchFn,
      baseUrl: "https://gateway.seven.io/api",
      method: "POST",
      path: "/sms",
      headers: { "X-Api-Key": this.opts.apiKey! },
      body: { to: msg.to, text: msg.body, from: this.opts.sender ?? undefined },
    });
    const id = res?.messages?.[0]?.id;
    return { externalId: id !== undefined ? String(id) : mockId("sms", `${msg.to}|${msg.body}`) };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    return parseSevenSmsWebhook(payload);
  }
}

/** seven.io Inbound-Webhook: { data: { id, sender, system, text, time } } */
export function parseSevenSmsWebhook(payload: unknown): InboundMessage[] {
  const d = (payload as { data?: { id?: string | number; sender?: string; system?: string; text?: string; time?: number } })?.data;
  if (!d?.sender || d.text === undefined) return [];
  return [
    {
      channel: "sms",
      externalId: String(d.id ?? mockId("sms-in", `${d.sender}|${d.time}`)),
      from: d.sender,
      to: d.system ?? null,
      body: d.text,
      receivedAt: d.time ? new Date(d.time * 1000).toISOString() : new Date().toISOString(),
      threadKey: d.sender,
    },
  ];
}

// ───────────── Mock ─────────────
/** Mock für alle Kanäle: speichert gesendete Nachrichten, parseInbound akzeptiert { from, body }. */
export class MessagingMock implements MessagingPort {
  readonly isMock = true;
  readonly sent: OutboundMessage[] = [];
  constructor(readonly provider: MessagingProvider) {}

  /**
   * Testmodus: nichts wird versendet. Protokolliert nur Kanal, Länge und Anhänge – keine Adressen/Inhalte.
   * Anhänge sind nur bei E-Mail erlaubt (wie bei den echten Adaptern).
   */
  async send(msg: OutboundMessage) {
    if (msg.attachments?.length && this.provider !== "email_imap") throw new Error(`${this.provider}: Anhänge werden nicht unterstützt.`);
    this.sent.push(msg);
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      console.info(`[mock:${this.provider}] Nachricht nicht versendet (Testmodus) · ${msg.body.length} Zeichen · ${msg.attachments?.length ?? 0} Anhang/Anhänge`);
    }
    const att = (msg.attachments ?? []).map((a) => `${a.filename}:${a.data.byteLength}`).join(",");
    return { externalId: mockId(`msg-${this.provider}`, `${this.sent.length}|${msg.to}|${msg.body}|${att}`) };
  }

  parseInbound(payload: unknown): InboundMessage[] {
    const list = Array.isArray(payload) ? payload : [payload];
    const channel = this.provider === "email_imap" ? "email" : this.provider;
    return list
      .filter((p): p is { from: string; body: string; subject?: string; id?: string } => !!p && typeof p.from === "string" && typeof p.body === "string")
      .map((p, i) => ({
        channel,
        externalId: p.id ?? mockId("inbound", `${p.from}|${i}|${p.body}`),
        from: p.from,
        subject: p.subject ?? null,
        body: p.body,
        receivedAt: "2026-01-01T08:00:00.000Z",
        threadKey: p.from,
      }));
  }
}
