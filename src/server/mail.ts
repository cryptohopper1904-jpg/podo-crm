import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import {
  describeMailSettings,
  isEmail,
  mailAdapterFor,
  MailNotConfiguredError,
  MailSendError,
  resolveMailSettings,
  toMailError,
  type MailMessage,
  type MailPort,
  type MailSettings,
  type TransportFactory,
} from "@/integrations/mail/mail";
import { resolvePublicAddress, UnsafeTargetError } from "@/integrations/net-guard";
import type { MessagingPort, OutboundMessage } from "@/integrations/types";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import { createRateLimiter } from "@/lib/rate-limit";
import { decryptSecret } from "@/lib/secrets";
import { loadConnection, logSync } from "./integrations";

/**
 * E-Mail-Versand der Praxis über den MailPort (src/integrations/mail/mail.ts):
 *  - Drosselung je Praxis (MAIL_RATE_PER_HOUR, Standard 300/h) gegen Missbrauch und Spam-Einstufung
 *  - Fehler: Audit „mail.failed“ + Synchronisationsprotokoll, sichere Meldung ohne Zugangsdaten
 *  - Testmodus: nichts wird versendet, Audit „mail.mock“ (ohne Adressen/Inhalte)
 * Rechnungsversand, Erinnerungen und Antworten aus dem Posteingang laufen über `mailMessagingPort`
 * (gleiche Schnittstelle wie bisher: MessagingPort „email_imap“).
 */

export const MAIL_RATE_PER_HOUR = Math.max(1, Number(process.env.MAIL_RATE_PER_HOUR) || 300);
const limiter = createRateLimiter({ windowMs: 3600_000, max: MAIL_RATE_PER_HOUR });

export class MailRateLimitError extends MailSendError {
  constructor() {
    super(`Zu viele E-Mails in der letzten Stunde (max. ${MAIL_RATE_PER_HOUR} je Praxis). Bitte später erneut versuchen.`, "RATE_LIMIT");
    this.name = "MailRateLimitError";
  }
}

/** nur für Tests */
export const _resetMailRateLimit = () => limiter.reset();
let factoryOverride: TransportFactory | undefined;
/** nur für Tests: nodemailer-Transport ersetzen */
export const _setTransportFactory = (f: TransportFactory | undefined) => {
  factoryOverride = f;
};

async function practiceOf(org: string) {
  const [o] = await db.select({ name: organizations.name, email: organizations.email }).from(organizations).where(eq(organizations.id, org));
  return o ?? { name: "Praxis", email: null };
}

/** Ermittelt die Versandart einer Praxis (ohne Zugangsdaten nach außen zu geben). */
export async function mailSettingsFor(org: string): Promise<MailSettings> {
  const conn = await loadConnection(org, "email_imap");
  let secret: Record<string, string> = {};
  if (conn?.secretEnc) {
    try {
      secret = JSON.parse(decryptSecret(conn.secretEnc, org));
    } catch {
      secret = {};
    }
  }
  return resolveMailSettings({
    connection: conn ? { status: conn.status, config: (conn.config ?? {}) as Record<string, unknown>, secret } : null,
    env: process.env,
    practice: await practiceOf(org),
  });
}

/**
 * MailPort der Praxis. Der SMTP-Host der Praxis wird vor jeder Verbindung EINMAL aufgelöst und gegen
 * interne Netze geprüft (SSRF); nodemailer verbindet danach genau mit dieser geprüften IP (kein
 * DNS-Rebinding), das TLS-Zertifikat wird weiterhin gegen den Hostnamen geprüft.
 */
export async function mailPortFor(org: string): Promise<MailPort> {
  const settings = await mailSettingsFor(org);
  if (settings.kind === "smtp" && settings.source === "org") {
    let connectAddress: string;
    try {
      connectAddress = await resolvePublicAddress(settings.target.host);
    } catch (e) {
      throw new MailSendError(e instanceof UnsafeTargetError ? e.message : "SMTP-Server nicht erlaubt.", "EUNSAFE");
    }
    return mailAdapterFor(settings, factoryOverride, { connectAddress });
  }
  return mailAdapterFor(settings, factoryOverride);
}

/**
 * Plattform-Versand (SMTP_URL/SMTP_FROM) für Konto-E-Mails ohne Praxis-Bezug, z. B. „Passwort vergessen“.
 * Wirft MailNotConfiguredError, wenn in Produktion kein Plattform-SMTP gesetzt ist (Entwicklung: Testmodus).
 */
export function platformMailPort(env: Record<string, string | undefined> = process.env): MailPort {
  const settings = resolveMailSettings({ connection: null, env, practice: { name: "PodoHero", email: null }, platform: true });
  return mailAdapterFor(settings, factoryOverride);
}

export type MailContext = { purpose: string; userId?: string | null; entity?: string; entityId?: string };

/**
 * Sendet eine E-Mail für eine Praxis. Wirft MailSendError/MailNotConfiguredError (sichere Meldung).
 * Fehler werden immer protokolliert (Audit + Sync-Protokoll), nie mit Passwort oder Server-Antwort.
 */
export async function sendMail(org: string, msg: MailMessage, ctx: MailContext): Promise<{ messageId: string; mock: boolean }> {
  const fail = async (err: Error) => {
    const message = err.message.slice(0, 300);
    await audit({ organizationId: org, userId: ctx.userId ?? null, action: "mail.failed", entity: ctx.entity, entityId: ctx.entityId, meta: { purpose: ctx.purpose, error: message, code: (err as MailSendError).code ?? null } }).catch(() => undefined);
    await logSync(org, "email_imap", { direction: "out", ok: false, message: `E-Mail (${ctx.purpose}): ${message}`, entity: ctx.entity, entityId: ctx.entityId }).catch(() => undefined);
    return err;
  };
  if (limiter.limited(org)) throw await fail(new MailRateLimitError());
  let port: MailPort;
  try {
    port = await mailPortFor(org);
  } catch (e) {
    throw await fail(e instanceof MailNotConfiguredError || e instanceof MailSendError ? e : toMailError(e));
  }
  try {
    const res = await port.send(msg);
    if (port.isMock) {
      await audit({ organizationId: org, userId: ctx.userId ?? null, action: "mail.mock", entity: ctx.entity, entityId: ctx.entityId, meta: { purpose: ctx.purpose, attachments: msg.attachments?.length ?? 0 } }).catch(() => undefined);
    } else {
      // Zähler für die Nutzungsstatistik (Plattform-Konsole): nur Zweck, nie Empfänger oder Inhalt
      await logSync(org, "email_imap", { direction: "out", ok: true, message: `E-Mail (${ctx.purpose}) versendet` }).catch(() => undefined);
    }
    return { messageId: res.messageId, mock: port.isMock };
  } catch (e) {
    throw await fail(toMailError(e));
  }
}

/**
 * MessagingPort-Hülle (Kanal „email_imap“) für bestehende Aufrufer – Rechnungsversand, Erinnerungen,
 * Posteingang. `isMock` wird nach der ersten Auswahl gesetzt.
 */
export async function mailMessagingPort(org: string, ctx: Omit<MailContext, "purpose"> & { purpose?: string } = {}): Promise<MessagingPort> {
  const settings = await mailSettingsFor(org);
  const isMock = settings.kind === "mock";
  return {
    provider: "email_imap",
    isMock,
    async send(m: OutboundMessage) {
      const r = await sendMail(org, { to: m.to.trim(), subject: m.subject ?? "", text: m.body, attachments: m.attachments }, { purpose: ctx.purpose ?? "message", ...ctx });
      return { externalId: r.messageId };
    },
    parseInbound: () => [],
  };
}

// ───────────── Einstellungen (Schnittstellen-Seite) ─────────────

export async function mailOverview(auth: AuthContext) {
  assertCan(auth, "integrations.manage");
  const s = await mailSettingsFor(auth.organization.id);
  return { kind: s.kind, source: s.kind === "smtp" ? s.source : null, description: describeMailSettings(s), ratePerHour: MAIL_RATE_PER_HOUR };
}

/** Testmail an eine Adresse (Standard: eigene Anmeldeadresse). */
export async function sendTestMail(auth: AuthContext, to?: string | null) {
  assertCan(auth, "integrations.manage");
  const target = (to ?? "").trim() || auth.user.email;
  if (!isEmail(target)) throw new MailSendError("Bitte eine gültige E-Mail-Adresse angeben.", "EENVELOPE");
  const org = auth.organization.id;
  const r = await sendMail(
    org,
    {
      to: target,
      subject: `Testmail aus PodoHero – ${auth.organization.name}`,
      text: [
        "Guten Tag,",
        "",
        "dies ist eine Testmail aus PodoHero. Wenn Sie diese Nachricht lesen, funktioniert der E-Mail-Versand Ihrer Praxis.",
        "Bitte prüfen Sie auch, ob die Mail im Spam-Ordner gelandet ist – dann SPF/DKIM/DMARC der Absenderdomain prüfen.",
        "",
        "Mit freundlichen Grüßen",
        "PodoHero",
      ].join("\n"),
    },
    { purpose: "test", userId: auth.user.id },
  );
  await logSync(org, "email_imap", { direction: "test", ok: true, message: r.mock ? "Testmail: Testmodus – nicht wirklich versendet" : "Testmail versendet" });
  await audit({ organizationId: org, userId: auth.user.id, action: "mail.test", meta: { mock: r.mock } });
  return { to: target, mock: r.mock };
}
