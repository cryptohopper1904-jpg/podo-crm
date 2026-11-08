/**
 * MailPort: echter E-Mail-Versand (Rechnungen, Erinnerungen, Antworten, Testmail).
 *
 * Adapter:
 *  - SMTP (nodemailer) mit den SMTP-Daten der Praxis (integration_connections „email_imap“, Passwort
 *    verschlüsselt) oder dem Plattform-Standard aus der Umgebung (SMTP_URL, SMTP_FROM).
 *  - Mock: versendet nichts, protokolliert nur Länge/Anhänge (Konsole) – die Serverseite schreibt Audit.
 *
 * Auswahl (resolveMailSettings, rein und testbar):
 *  1. INTEGRATIONS_MODE=mock oder Verbindung im Testmodus → Mock
 *  2. Verbindung „verbunden“ mit Host, Benutzer, Passwort → SMTP der Praxis
 *  3. SMTP_URL + SMTP_FROM gesetzt → Plattform-SMTP (Absendername = Praxis, Antwort an Praxisadresse)
 *  4. sonst: in Produktion „nicht eingerichtet“ (sichtbarer Fehler), in Entwicklung Mock
 *
 * Fehlermeldungen enthalten NIE Zugangsdaten oder Server-Antworten, nur Fehlercodes.
 */
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { mockId } from "../mock-util";

export interface MailAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
  attachments?: MailAttachment[];
}

export interface MailPort {
  readonly kind: "smtp" | "mock";
  readonly isMock: boolean;
  /** „org“ = SMTP der Praxis, „platform“ = Plattform-Standard, „mock“ = Testmodus */
  readonly source: "org" | "platform" | "mock";
  send(msg: MailMessage): Promise<{ messageId: string }>;
}

/** Versandfehler mit sicherer, deutscher Meldung (ohne Passwort, ohne Server-Antwort). */
export class MailSendError extends Error {
  constructor(
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

export class MailNotConfiguredError extends Error {
  constructor(message = "E-Mail-Versand ist nicht eingerichtet (Einstellungen → Schnittstellen → E-Mail).") {
    super(message);
    this.name = "MailNotConfiguredError";
  }
}

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);

// ───────────── Auswahl ─────────────

export type SmtpTarget = { host: string; port: number; secure: boolean; user: string; password: string };

export type MailSettings =
  | { kind: "mock"; reason: "env_mock" | "connection_mock" | "dev_unconfigured" }
  | { kind: "smtp"; source: "org"; target: SmtpTarget; from: string; replyTo: string | null }
  | { kind: "smtp"; source: "platform"; url: string; from: string; replyTo: string | null }
  | { kind: "unconfigured"; reason: string };

export type MailEnv = { SMTP_URL?: string; SMTP_FROM?: string; INTEGRATIONS_MODE?: string; NODE_ENV?: string };

const quoteName = (name: string) => `"${name.replace(/["\\\r\n<>]/g, "").trim().slice(0, 80)}"`;

export function resolveMailSettings(input: {
  connection: { status: string; config: Record<string, unknown>; secret: Record<string, string> } | null;
  env: MailEnv;
  practice: { name: string; email?: string | null };
}): MailSettings {
  const { connection: c, env, practice } = input;
  if (env.INTEGRATIONS_MODE === "mock") return { kind: "mock", reason: "env_mock" };
  if (c?.status === "mock") return { kind: "mock", reason: "connection_mock" };
  const replyTo = isEmail(practice.email) ? practice.email : null;
  if (c && (c.status === "connected" || c.status === "error")) {
    const host = typeof c.config.smtpHost === "string" ? c.config.smtpHost.trim() : "";
    const user = typeof c.config.user === "string" ? c.config.user.trim() : "";
    const password = c.secret.password ?? "";
    if (!host || !user || !password) return { kind: "unconfigured", reason: "SMTP-Server, Benutzer und Passwort der Praxis sind unvollständig." };
    const rawPort = Number(c.config.smtpPort ?? 587);
    const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 587;
    const fromAddr = isEmail(c.config.fromAddress) ? (c.config.fromAddress as string) : isEmail(user) ? user : null;
    if (!fromAddr) return { kind: "unconfigured", reason: "Absenderadresse fehlt (Feld „Absenderadresse“ oder Benutzername als E-Mail-Adresse)." };
    return { kind: "smtp", source: "org", target: { host, port, secure: port === 465, user, password }, from: `${quoteName(practice.name)} <${fromAddr}>`, replyTo };
  }
  if (env.SMTP_URL) {
    if (!isEmail(env.SMTP_FROM)) return { kind: "unconfigured", reason: "SMTP_FROM fehlt oder ist ungültig (Plattform-Einstellung)." };
    return { kind: "smtp", source: "platform", url: env.SMTP_URL, from: `${quoteName(practice.name)} <${env.SMTP_FROM}>`, replyTo };
  }
  if (env.NODE_ENV === "production") return { kind: "unconfigured", reason: "Kein SMTP-Zugang hinterlegt und kein Plattform-Standard (SMTP_URL) gesetzt." };
  return { kind: "mock", reason: "dev_unconfigured" };
}

/** Für die Oberfläche: woher kommt der Versand (ohne Zugangsdaten). */
export function describeMailSettings(s: MailSettings): string {
  switch (s.kind) {
    case "mock":
      return s.reason === "dev_unconfigured" ? "Testmodus (Entwicklung, kein SMTP hinterlegt) – es wird nichts versendet." : "Testmodus – es wird nichts versendet.";
    case "unconfigured":
      return `Nicht eingerichtet: ${s.reason}`;
    case "smtp":
      return s.source === "org" ? `SMTP der Praxis (${s.target.host}:${s.target.port}) · Absender ${s.from}` : `Versand über den Plattform-Server · Absender ${s.from}`;
  }
}

// ───────────── Fehler ─────────────

const CODE_TEXT: Record<string, string> = {
  EAUTH: "Anmeldung am SMTP-Server fehlgeschlagen (Benutzer/Passwort prüfen).",
  ENOAUTH: "Anmeldung am SMTP-Server fehlgeschlagen (Benutzer/Passwort prüfen).",
  ECONNECTION: "SMTP-Server nicht erreichbar (Server/Port prüfen).",
  ECONNREFUSED: "SMTP-Server nicht erreichbar (Server/Port prüfen).",
  ETIMEDOUT: "Zeitüberschreitung beim SMTP-Server.",
  ESOCKET: "Verbindung zum SMTP-Server abgebrochen (TLS/Port prüfen).",
  EDNS: "SMTP-Server nicht gefunden (Servername prüfen).",
  ENOTFOUND: "SMTP-Server nicht gefunden (Servername prüfen).",
  ETLS: "Verschlüsselte Verbindung (TLS) zum SMTP-Server fehlgeschlagen.",
  EENVELOPE: "Empfänger- oder Absenderadresse wurde vom Server abgelehnt.",
  EMESSAGE: "Nachricht wurde vom Server abgelehnt.",
};

/** Beliebiger nodemailer-Fehler → MailSendError ohne Geheimnisse (nur Code + SMTP-Statuscode). */
export function toMailError(e: unknown): MailSendError {
  if (e instanceof MailSendError) return e;
  const err = (e ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof err.code === "string" && /^[A-Z_]{2,20}$/.test(err.code) ? err.code : null;
  const status = typeof err.responseCode === "number" && err.responseCode >= 200 && err.responseCode < 600 ? err.responseCode : null;
  const text = (code && CODE_TEXT[code]) || "E-Mail-Versand fehlgeschlagen.";
  return new MailSendError(status ? `${text} (SMTP ${status})` : text, code);
}

// ───────────── Adapter ─────────────

type Transporter = { sendMail(m: Mail.Options): Promise<{ messageId?: string }>; verify(): Promise<unknown> };
export type TransportFactory = (opts: SMTPTransport.Options) => Transporter;

const defaultFactory: TransportFactory = (opts) => nodemailer.createTransport(opts);

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const stripBrackets = (h: string) => h.replace(/^\[|\]$/g, "");

export type TransportContext = {
  /** bereits geprüfte (öffentliche) IP, mit der verbunden wird – kein erneutes DNS (Rebinding-Schutz) */
  connectAddress?: string;
  /** Umgebung (Standard: process.env.NODE_ENV) – Klartext nur in Entwicklung zu localhost */
  nodeEnv?: string;
};

/** Plattform-SMTP_URL (smtp:// bzw. smtps://) in nodemailer-Optionen zerlegen. */
export function parseSmtpUrl(raw: string): { host: string; port: number; secure: boolean; user?: string; pass?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new MailSendError("SMTP_URL ist ungültig (Plattform-Einstellung).", "ECONFIG");
  }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new MailSendError("SMTP_URL muss mit smtp:// oder smtps:// beginnen.", "ECONFIG");
  const host = stripBrackets(u.hostname);
  if (!host) throw new MailSendError("SMTP_URL ohne Server (Plattform-Einstellung).", "ECONFIG");
  const secure = u.protocol === "smtps:";
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  return { host, port, secure: secure || port === 465, user: u.username ? decodeURIComponent(u.username) : undefined, pass: u.password ? decodeURIComponent(u.password) : undefined };
}

/**
 * nodemailer-Optionen (rein, testbar):
 *  - immer TLS: implizit (465/smtps) oder STARTTLS-Pflicht (requireTLS), mindestens TLS 1.2,
 *    Zertifikat wird gegen den konfigurierten Hostnamen geprüft (tls.servername)
 *  - Praxis-SMTP: Verbindung zur vorab geprüften IP (`connectAddress`)
 *  - Ausnahme nur außerhalb der Produktion für localhost (Mailcatcher in der Entwicklung)
 */
export function smtpTransportOptions(settings: Extract<MailSettings, { kind: "smtp" }>, ctx: TransportContext = {}): SMTPTransport.Options {
  const t =
    settings.source === "org"
      ? { host: stripBrackets(settings.target.host), port: settings.target.port, secure: settings.target.secure, user: settings.target.user, pass: settings.target.password }
      : parseSmtpUrl(settings.url);
  const nodeEnv = ctx.nodeEnv ?? process.env.NODE_ENV;
  const devPlain = nodeEnv !== "production" && settings.source === "platform" && LOCAL_DEV_HOSTS.has(t.host.toLowerCase());
  const servername = isIP(t.host) ? undefined : t.host;
  return {
    host: ctx.connectAddress ?? t.host,
    port: t.port,
    secure: t.secure,
    // STARTTLS erzwingen – Gesundheitsbezug, nie im Klartext
    requireTLS: !t.secure && !devPlain,
    ...(t.user ? { auth: { user: t.user, pass: t.pass ?? "" } } : {}),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, ...(servername ? { servername } : {}) },
    ...TIMEOUTS,
  };
}

export class SmtpMailAdapter implements MailPort {
  readonly kind = "smtp" as const;
  readonly isMock = false;
  readonly source: "org" | "platform";
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly replyTo: string | null;

  constructor(settings: Extract<MailSettings, { kind: "smtp" }>, factory: TransportFactory = defaultFactory, ctx: TransportContext = {}) {
    this.source = settings.source;
    this.from = settings.from;
    this.replyTo = settings.replyTo;
    try {
      this.transporter = factory(smtpTransportOptions(settings, ctx));
    } catch (e) {
      throw toMailError(e);
    }
  }

  async send(msg: MailMessage): Promise<{ messageId: string }> {
    if (!isEmail(msg.to)) throw new MailSendError("Die Empfängeradresse ist ungültig.", "EENVELOPE");
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: msg.to,
        replyTo: msg.replyTo ?? this.replyTo ?? undefined,
        subject: msg.subject.replace(/[\r\n]+/g, " ").slice(0, 300),
        text: msg.text,
        attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.data) })),
      });
      return { messageId: typeof info?.messageId === "string" && info.messageId ? info.messageId.slice(0, 250) : mockId("smtp", `${msg.to}|${msg.subject}`) };
    } catch (e) {
      throw toMailError(e);
    }
  }

  /** Verbindung + Anmeldung prüfen, ohne zu senden. */
  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (e) {
      throw toMailError(e);
    }
  }
}

export class MockMailAdapter implements MailPort {
  readonly kind = "mock" as const;
  readonly isMock = true;
  readonly source = "mock" as const;
  readonly sent: MailMessage[] = [];

  async send(msg: MailMessage): Promise<{ messageId: string }> {
    if (!isEmail(msg.to)) throw new MailSendError("Die Empfängeradresse ist ungültig.", "EENVELOPE");
    this.sent.push(msg);
    if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
      // keine Adressen, keine Inhalte
      console.info(`[mock:mail] E-Mail nicht versendet (Testmodus) · ${msg.text.length} Zeichen · ${msg.attachments?.length ?? 0} Anhang/Anhänge`);
    }
    const att = (msg.attachments ?? []).map((a) => `${a.filename}:${a.data.byteLength}`).join(",");
    return { messageId: mockId("mail", `${this.sent.length}|${msg.to}|${msg.subject}|${att}`) };
  }
}

/** Adapter zur Auswahl. `unconfigured` → MailNotConfiguredError. */
export function mailAdapterFor(settings: MailSettings, factory?: TransportFactory, ctx?: TransportContext): MailPort {
  if (settings.kind === "mock") return new MockMailAdapter();
  if (settings.kind === "unconfigured") throw new MailNotConfiguredError(`E-Mail-Versand nicht eingerichtet: ${settings.reason}`);
  return new SmtpMailAdapter(settings, factory, ctx);
}
