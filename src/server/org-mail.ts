import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { MailNotConfiguredError, type MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { dateDe } from "@/lib/format";
import { log } from "@/lib/log";
import { CASH_REGISTER_NOTE, deletionDueAt, EXPORT_CASH_NOTE } from "@/lib/org-deletion";
import type { MailOutcome } from "@/lib/readonly-expiry";
import { platformMailPort } from "./mail";

/**
 * Betreiber-E-Mails an Zugänge einer Praxis über den Plattform-SMTP (SMTP_URL/SMTP_FROM) – Löschankündigung,
 * Kündigungsbestätigung, Hinweis an die Steuerberatung. Ohne Plattform-SMTP (bzw. im Testmodus) wird nichts versendet
 * („not_configured“).
 */
export type OrgMailRole = "owner" | "accountant";

/** aktive Zugänge der Praxis mit diesen Rollen (E-Mail-Adressen, ohne Dubletten) */
export async function orgRecipientEmails(organizationId: string, roles: OrgMailRole[]): Promise<string[]> {
  if (!roles.length) return [];
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), inArray(memberships.role, roles)));
  return [...new Set(rows.map((r) => r.email))];
}

export type OrgMailOptions = {
  /** Pflicht-Empfänger: „sent“ nur, wenn an mindestens EINE dieser Adressen zugestellt wurde */
  primary: OrgMailRole[];
  /** zusätzliche Empfänger (z. B. Steuerberatung) – erhalten die E-Mail auch, zählen für „sent“ aber nicht */
  additional?: OrgMailRole[];
  /** Versandweg ersetzen (Tests) */
  mail?: () => MailPort;
  /** Schlüssel für das Betriebsprotokoll */
  logKey?: string;
};

/**
 * Versand an die Zugänge der Praxis; wirft nie. „sent“ = mindestens eine Pflicht-Adresse angenommen (Recht B-1:
 * eine nur an die Steuerberatung zugestellte Ankündigung gilt NICHT als Zugang bei der Praxis).
 */
export async function sendOrgMail(organizationId: string, subject: string, text: string, opts: OrgMailOptions): Promise<MailOutcome> {
  const key = opts.logKey ?? "org_mail";
  try {
    const primary = await orgRecipientEmails(organizationId, opts.primary);
    if (!primary.length) return "no_recipient";
    const extra = (await orgRecipientEmails(organizationId, opts.additional ?? [])).filter((a) => !primary.includes(a));
    let port: MailPort;
    try {
      port = (opts.mail ?? (() => platformMailPort()))();
    } catch (e) {
      if (e instanceof MailNotConfiguredError) return "not_configured";
      throw e;
    }
    if (port.isMock) return "not_configured";
    let ok = 0;
    for (const addr of primary) {
      try {
        await port.send({ to: addr, subject, text });
        ok++;
      } catch (e) {
        log.warn(`${key}.mail_failed`, { organizationId, error: e });
      }
    }
    for (const addr of extra) {
      await port.send({ to: addr, subject, text }).catch((e) => log.warn(`${key}.mail_failed`, { organizationId, error: e }));
    }
    return ok ? "sent" : "failed";
  } catch (e) {
    log.warn(`${key}.mail_failed`, { organizationId, error: e });
    return "failed";
  }
}

const publicUrl = () => (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

/**
 * Freiwilliger Löschantrag (Buchhaltung E4): Die Steuerberatung (Rolle accountant) erfährt Löschtermin und was vorher zu
 * sichern ist – die Aufbewahrungspflichten der Praxis laufen weiter. Ohne Steuerberatung bzw. Plattform-SMTP: nichts.
 */
export async function notifyAccountantsOfDeletionRequest(
  organizationId: string,
  practiceName: string,
  requestedAt: Date,
  opts: { mail?: () => MailPort } = {},
): Promise<MailOutcome> {
  const due = dateDe(deletionDueAt(requestedAt));
  const url = publicUrl();
  const text = [
    "Hallo,",
    "",
    `für die Praxis „${practiceName}“, bei der du in PodoHero als Steuerberatung eingetragen bist, wurde am ${dateDe(requestedAt)} die Löschung beantragt. Wir löschen die Praxis am ${due} endgültig (spätestens 14 Tage danach), sofern der Antrag nicht vorher zurückgenommen wird. Danach sind auch deine Zugänge und alle Belege in PodoHero gelöscht.`,
    "",
    `Die Aufbewahrungspflichten der Praxis bleiben bestehen. Bitte stimme mit der Praxis ab, dass sie vorher einen vollständigen Export erstellt (Einstellungen → Daten & Kündigung): Er enthält Rechnungen und Zahlungsbelege als Original-PDF mit Prüfsumme und das Kassenbuch als Tabelle. ${EXPORT_CASH_NOTE} ${CASH_REGISTER_NOTE}`,
    ...(url ? ["", url] : []),
    "",
    "Viele Grüße",
    "PodoHero",
  ].join("\n");
  const mail = await sendOrgMail(organizationId, `Löschantrag der Praxis „${practiceName}“ – Löschung am ${due} – PodoHero`, text, {
    primary: ["accountant"],
    mail: opts.mail,
    logKey: "org.deletion_request",
  });
  if (mail !== "no_recipient") {
    await audit({ organizationId, action: "org.deletion_request_accountant_mail", entity: "organization", entityId: organizationId, meta: { mail, deletionAt: deletionDueAt(requestedAt).toISOString() } }).catch(
      (e) => log.warn("org.deletion_request.audit_failed", { organizationId, error: e }),
    );
  }
  return mail;
}
