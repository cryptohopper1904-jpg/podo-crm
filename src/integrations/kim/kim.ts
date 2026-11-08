/**
 * KIM-Adapter (echt) und Mock.
 *
 * Echt: spricht mit dem KIM-Clientmodul (bzw. dem KIM-Dienst eines TI-Gateway-Anbieters) über
 *  - POP3S (Abruf) und SMTPS (Versand), Zugangsdaten verschlüsselt in integration_connections.
 *  - Der Benutzername enthält beim KIM-Clientmodul je nach Anbieter zusätzliche Kontextangaben
 *    (z. B. KIM-Adresse, Fachdienst-Host, Mandant/Clientsystem/Arbeitsplatz des Konnektors) –
 *    genaues Format laut Anbieterdokumentation; wir reichen ihn unverändert durch.
 *  - Nachrichten werden standardmäßig NICHT auf dem Server gelöscht (deleteAfterFetch = false);
 *    Dubletten verhindert der Abgleich über die Message-ID.
 *
 * Wir sind kein zertifiziertes TI-Produkt: Signatur/Verschlüsselung, Verzeichnisdienst und
 * Zertifikate liegen vollständig beim Clientmodul des zugelassenen KIM-Anbieters.
 */
import { IntegrationNotConfiguredError } from "../errors";
import { mockId } from "../mock-util";
import type { KimInboundMessage, KimPort, KimSendAttachment } from "../types";
import { addressOf, parseMime } from "./mime";
import { tlsConnector } from "./net";
import { Pop3Client, type ConnectFn } from "./pop3";
import { KIM_CONNECTION_PROVIDER } from "./provider";
import { buildMail, isMailAddress, SimpleSmtpTransport, type SmtpTransport } from "./smtp";

export interface KimConfig {
  pop3Host?: string;
  pop3Port?: number;
  smtpHost?: string;
  smtpPort?: number;
  user?: string;
  password?: string;
  /** eigene KIM-Adresse der Praxis (Absender), z. B. praxis.name@anbieter.kim.telematik */
  address?: string;
  deleteAfterFetch?: boolean;
  /** Tests: eigener Transport für POP3 bzw. SMTP */
  pop3Connect?: ConnectFn;
  smtpTransport?: SmtpTransport;
}

/** Höchstzahl je Abruf – Rest folgt beim nächsten Lauf. */
const DEFAULT_LIMIT = 50;
/** Maximal so viele Anhänge/Bytes werden als Metadaten übernommen */
const MAX_ATTACHMENTS = 20;

export function toInbound(raw: Buffer, fallbackId: string, now = new Date()): KimInboundMessage {
  const m = parseMime(raw);
  return {
    messageId: m.messageId ?? fallbackId,
    from: addressOf(m.from) ?? m.from ?? "unbekannt",
    to: addressOf(m.to),
    subject: m.subject?.slice(0, 300) ?? null,
    receivedAt: (m.date ?? now).toISOString(),
    text: m.text,
    attachments: m.attachments.slice(0, MAX_ATTACHMENTS),
    inReplyTo: m.inReplyTo,
    kimService: m.kimService?.slice(0, 100) ?? null,
  };
}

export class KimAdapter implements KimPort {
  readonly provider = "kim" as const;
  readonly isMock = false;
  private readonly pop3Connect: ConnectFn;
  private readonly smtp: SmtpTransport;

  constructor(private readonly cfg: KimConfig) {
    if (!cfg.user || !cfg.password || !cfg.address) {
      throw new IntegrationNotConfiguredError(KIM_CONNECTION_PROVIDER, "KIM: Benutzername, Passwort und KIM-Adresse fehlen");
    }
    if (!isMailAddress(cfg.address)) throw new IntegrationNotConfiguredError(KIM_CONNECTION_PROVIDER, "KIM-Adresse ist ungültig");
    if (!cfg.pop3Connect && !cfg.pop3Host) throw new IntegrationNotConfiguredError(KIM_CONNECTION_PROVIDER, "KIM: POP3-Host fehlt");
    if (!cfg.smtpTransport && !cfg.smtpHost) throw new IntegrationNotConfiguredError(KIM_CONNECTION_PROVIDER, "KIM: SMTP-Host fehlt");
    this.pop3Connect = cfg.pop3Connect ?? tlsConnector({ host: cfg.pop3Host!, port: cfg.pop3Port ?? 995 });
    this.smtp =
      cfg.smtpTransport ??
      new SimpleSmtpTransport({ connect: tlsConnector({ host: cfg.smtpHost!, port: cfg.smtpPort ?? 465 }), user: cfg.user, password: cfg.password });
  }

  private client() {
    return new Pop3Client({ connect: this.pop3Connect, user: this.cfg.user!, password: this.cfg.password! });
  }

  async ping(): Promise<{ messages: number }> {
    const c = this.client();
    try {
      await c.connect();
      const s = await c.stat();
      await c.quit();
      return { messages: s.count };
    } finally {
      c.close();
    }
  }

  async fetchInbox(opts: { limit?: number } = {}): Promise<KimInboundMessage[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 200));
    const c = this.client();
    const out: KimInboundMessage[] = [];
    try {
      await c.connect();
      const { count } = await c.stat();
      const uidl = count ? await c.uidl() : null;
      for (let n = 1; n <= Math.min(count, limit); n++) {
        const raw = await c.retr(n);
        // ohne Message-ID: UIDL bzw. Inhalts-Hash als stabiler Ersatz
        out.push(toInbound(raw, uidl?.get(n) ? `uidl:${uidl.get(n)}` : mockId("kim", raw.toString("latin1"))));
        if (this.cfg.deleteAfterFetch) await c.dele(n);
      }
      await c.quit();
    } finally {
      c.close();
    }
    return out;
  }

  async send(to: string, subject: string, body: string, attachments: KimSendAttachment[] = [], opts: { inReplyTo?: string | null } = {}): Promise<{ messageId: string }> {
    const rcpt = to.trim();
    if (!isMailAddress(rcpt)) throw new Error("KIM: Empfängeradresse ist ungültig");
    const { raw, messageId } = buildMail({ from: this.cfg.address!, to: rcpt, subject, text: body, attachments, inReplyTo: opts.inReplyTo });
    await this.smtp.send({ from: this.cfg.address!, to: [rcpt], raw });
    return { messageId };
  }
}

// ───────────── Mock ─────────────

/** Erfundene Beispielnachrichten (keine echten Personen). */
export const KIM_MOCK_MESSAGES: KimInboundMessage[] = [
  {
    messageId: "mock-kim-0001@praxis-dr-beispiel.kim.example",
    from: "praxis.dr.beispiel@kim-anbieter.example",
    to: "podologie.testpraxis@kim-anbieter.example",
    subject: "Arztbrief: Erika Musterfrau, geb. 01.02.1950",
    receivedAt: "2026-11-02T09:15:00.000Z",
    text:
      "Sehr geehrte Kolleginnen und Kollegen,\n\nanbei der Arztbrief zu Frau Erika Musterfrau (KVNR A123456780). " +
      "Diabetes mellitus Typ 2 mit Polyneuropathie, Fußstatus unauffällig, keine Ulzera. " +
      "Podologische Komplexbehandlung wurde verordnet.\n\nMit freundlichen Grüßen\nPraxis Dr. Beispiel (Testdaten)",
    attachments: [{ filename: "Arztbrief_Musterfrau.pdf", contentType: "application/pdf", size: 48213 }],
    inReplyTo: null,
    kimService: "eArztbrief;Brief;V1.2",
  },
  {
    messageId: "mock-kim-0002@hausarzt-demo.kim.example",
    from: "hausarztpraxis.demo@kim-anbieter.example",
    to: "podologie.testpraxis@kim-anbieter.example",
    subject: "Rückfrage Therapiebericht Max Mustermann",
    receivedAt: "2026-11-05T14:40:00.000Z",
    text: "Guten Tag,\n\nbitte senden Sie uns den Therapiebericht zur letzten Verordnung von Herrn Max Mustermann (geb. 15.06.1948).\n\nViele Grüße\nHausarztpraxis Demo (Testdaten)",
    attachments: [],
    inReplyTo: null,
    kimService: null,
  },
];

export class KimMock implements KimPort {
  readonly provider = "kim" as const;
  readonly isMock = true;
  readonly sent: { to: string; subject: string; body: string; attachments: number }[] = [];

  async ping() {
    return { messages: KIM_MOCK_MESSAGES.length };
  }
  async fetchInbox(opts: { limit?: number } = {}): Promise<KimInboundMessage[]> {
    return KIM_MOCK_MESSAGES.slice(0, opts.limit ?? DEFAULT_LIMIT).map((m) => ({ ...m, attachments: [...m.attachments] }));
  }
  async send(to: string, subject: string, body: string, attachments: KimSendAttachment[] = []) {
    if (!isMailAddress(to.trim())) throw new Error("KIM: Empfängeradresse ist ungültig");
    this.sent.push({ to, subject, body, attachments: attachments.length });
    return { messageId: mockId("kim-out", `${to}|${subject}|${body}`) };
  }
}
