/**
 * Minimaler SMTP-Client (RFC 5321) über implizites TLS (SMTPS) für den KIM-Versand über das
 * KIM-Clientmodul. Das Clientmodul signiert und verschlüsselt (S/MIME) die Nachricht für den
 * Empfänger aus dem Verzeichnisdienst – wir liefern eine normale MIME-Nachricht ein.
 *
 * Der Versand läuft über die schmale Schnittstelle `SmtpTransport` – austauschbar
 * (z. B. gegen eine gemeinsame Mail-Bibliothek) und in Tests ersetzbar.
 */
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { KimSendAttachment } from "../types";
import type { ConnectFn } from "./pop3";

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SmtpError";
  }
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
  /** fertige MIME-Nachricht (CRLF-Zeilenenden) */
  raw: string;
}

/** Austauschbarer Versandweg. */
export interface SmtpTransport {
  send(envelope: SmtpEnvelope): Promise<void>;
}

const ADDRESS_RE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[a-z0-9-]{2,}$/i;
export const isMailAddress = (a: string) => a.length <= 254 && ADDRESS_RE.test(a);

/** Antwort lesen (mehrzeilig: „250-…“ bis „250 …“). */
class ReplyReader {
  private buf = "";
  private waiters: (() => void)[] = [];
  private ended = false;
  private error: Error | null = null;
  constructor(stream: Duplex) {
    stream.on("data", (c: Buffer) => {
      this.buf += c.toString("latin1");
      this.wake();
    });
    stream.on("end", () => ((this.ended = true), this.wake()));
    stream.on("close", () => ((this.ended = true), this.wake()));
    stream.on("error", (e: Error) => ((this.error = e), this.wake()));
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  async reply(timeoutMs: number): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        lines.push(line.slice(4));
        if (!/^\d{3}[ -]/.test(line) && !/^\d{3}$/.test(line)) throw new SmtpError("Ungültige SMTP-Antwort");
        if (line[3] !== "-") return { code: Number(line.slice(0, 3)), lines };
        if (lines.length > 100) throw new SmtpError("SMTP-Antwort zu lang");
        continue;
      }
      if (this.buf.length > 8192) throw new SmtpError("SMTP-Antwortzeile zu lang");
      if (this.error) throw this.error;
      if (this.ended) throw new SmtpError("Verbindung vom SMTP-Server geschlossen");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new SmtpError("Zeitüberschreitung beim SMTP-Server")), timeoutMs);
        this.waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
  }
}

export interface SmtpClientOptions {
  connect: ConnectFn;
  user: string;
  password: string;
  /** Name für EHLO */
  clientName?: string;
  timeoutMs?: number;
}

/** SMTP über eine bereits verschlüsselte Verbindung (SMTPS). */
export class SimpleSmtpTransport implements SmtpTransport {
  constructor(private readonly opts: SmtpClientOptions) {}

  async send(env: SmtpEnvelope): Promise<void> {
    if (!isMailAddress(env.from) || env.to.length === 0 || env.to.some((t) => !isMailAddress(t))) throw new SmtpError("Ungültige Adresse");
    const timeout = this.opts.timeoutMs ?? 30_000;
    const stream = await this.opts.connect();
    const reader = new ReplyReader(stream);
    const expect = async (ok: number[], what: string) => {
      const r = await reader.reply(timeout);
      if (!ok.includes(r.code)) throw new SmtpError(`SMTP ${what} abgelehnt`, r.code);
      return r;
    };
    const cmd = async (line: string, ok: number[], what: string) => {
      if (/[\r\n]/.test(line)) throw new SmtpError("Ungültiges Zeichen im SMTP-Befehl");
      stream.write(`${line}\r\n`);
      return expect(ok, what);
    };
    try {
      await expect([220], "Begrüßung");
      const ehlo = await cmd(`EHLO ${this.opts.clientName ?? "podocrm.local"}`, [250], "EHLO");
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? "";
      if (auth.includes("PLAIN")) {
        const token = Buffer.from(`\u0000${this.opts.user}\u0000${this.opts.password}`, "utf8").toString("base64");
        await cmd(`AUTH PLAIN ${token}`, [235], "Anmeldung");
      } else if (auth.includes("LOGIN")) {
        await cmd("AUTH LOGIN", [334], "Anmeldung");
        await cmd(Buffer.from(this.opts.user, "utf8").toString("base64"), [334], "Anmeldung");
        await cmd(Buffer.from(this.opts.password, "utf8").toString("base64"), [235], "Anmeldung");
      } else {
        throw new SmtpError("SMTP-Server bietet keine unterstützte Anmeldung (PLAIN/LOGIN)");
      }
      await cmd(`MAIL FROM:<${env.from}>`, [250], "Absender");
      for (const to of env.to) await cmd(`RCPT TO:<${to}>`, [250, 251], "Empfänger");
      await cmd("DATA", [354], "DATA");
      // Dot-Stuffing (RFC 5321 4.5.2) und Abschluss mit „.“
      const body = env.raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      stream.write(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.\r\n`);
      await expect([250], "Nachricht");
      try {
        await cmd("QUIT", [221], "QUIT");
      } catch {
        // Nachricht ist bereits angenommen
      }
    } finally {
      stream.destroy();
    }
  }
}

// ───────────── MIME-Nachricht bauen ─────────────

/** RFC 2047 für Kopfzeilen mit Nicht-ASCII-Zeichen. */
export function encodeHeader(v: string): string {
  const clean = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");

export interface BuildMailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments?: KimSendAttachment[];
  inReplyTo?: string | null;
  /** z. B. „Arztbrief;Brief;V1.0“ – optional, sonst setzt das Clientmodul keine Dienstkennung */
  kimService?: string | null;
  domain?: string;
  date?: Date;
}

/** Kopfzeilenwert ohne CR/LF/Steuerzeichen (gegen Header-Injection), danach RFC 2047. */
export const sanitizeHeader = (v: string) => encodeHeader(String(v ?? "").replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, " "));

export function buildMail(input: BuildMailInput): { raw: string; messageId: string } {
  // Adressen landen ungefiltert in From:/To: – deshalb hier (nicht erst beim Envelope) streng prüfen
  if (typeof input.from !== "string" || /[\r\n]/.test(input.from) || !isMailAddress(input.from)) throw new SmtpError("Ungültige Absenderadresse in Kopfzeile");
  if (typeof input.to !== "string" || /[\r\n]/.test(input.to) || !isMailAddress(input.to)) throw new SmtpError("Ungültige Empfängeradresse in Kopfzeile");
  const fromDomain = input.from.split("@")[1];
  const domain = input.domain && /^[a-z0-9.-]{1,253}$/i.test(input.domain) ? input.domain : fromDomain || "podocrm.local";
  const messageId = `${randomBytes(12).toString("hex")}@${domain}`;
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Date: ${(input.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
  ];
  if (input.inReplyTo && !/[\r\n<>]/.test(input.inReplyTo)) headers.push(`In-Reply-To: <${input.inReplyTo}>`, `References: <${input.inReplyTo}>`);
  if (input.kimService && /^[\x20-\x7e]{1,100}$/.test(input.kimService)) headers.push(`X-KIM-Dienstkennung: ${input.kimService}`);
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(input.text, "utf8").toString("base64"))].join("\r\n");
  if (!input.attachments?.length) {
    return { raw: `${headers.join("\r\n")}\r\n${textPart}`, messageId };
  }
  const boundary = `=_podo_${randomBytes(12).toString("hex")}`;
  const parts = [textPart];
  for (const a of input.attachments) {
    const name = encodeHeader(a.filename.replace(/["\\]/g, "_"));
    const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.contentType) ? a.contentType : "application/octet-stream";
    parts.push(
      [`Content-Type: ${type}; name="${name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "", wrap76(Buffer.from(a.data).toString("base64"))].join("\r\n"),
    );
  }
  const body = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--\r\n`;
  return { raw: `${headers.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${body}`, messageId };
}
