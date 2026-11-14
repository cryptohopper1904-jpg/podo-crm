import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organizations, users } from "@/db/schema";
import { MailNotConfiguredError, type MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { dateDe } from "@/lib/format";
import { log } from "@/lib/log";
import { ACCOUNTANT_CASH_NOTE, deletionDueAt } from "@/lib/org-deletion";
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
  /** Rückmeldung zu den zusätzlichen Empfängern: angenommen / vorhanden (nur wenn der Versand den Mailserver erreicht hat) */
  onAdditional?: (accepted: number, total: number) => void;
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
    let extraOk = 0;
    for (const addr of extra) {
      await port.send({ to: addr, subject, text }).then(
        () => void extraOk++,
        (e) => log.warn(`${key}.mail_failed`, { organizationId, error: e }),
      );
    }
    opts.onAdditional?.(extraOk, extra.length);
    return ok ? "sent" : "failed";
  } catch (e) {
    log.warn(`${key}.mail_failed`, { organizationId, error: e });
    return "failed";
  }
}

const publicUrl = () => (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

/** Höchstens eine E-Mail je Art an die Steuerberatung einer Praxis in diesem Zeitraum (AppSec AS-2) */
export const ACCOUNTANT_MAIL_THROTTLE_HOURS = 24;
export type AccountantMailKind = "deletion_request" | "deletion_withdrawn";
export type AccountantMailOutcome = MailOutcome | "throttled";

/**
 * Drossel (AppSec AS-2): beansprucht per bedingtem UPDATE den Versand dieser Art für die Praxis
 * (organizations.settings.accountantMailAt[kind]); false = in den letzten ACCOUNTANT_MAIL_THROTTLE_HOURS schon versendet.
 * Atomar – auch gleichzeitige Anträge/Rücknahmen senden höchstens einmal. Ausnahme: Ist seit der letzten Mail dieser
 * Art eine Mail der jeweils anderen Art (Antrag/Rücknahme) gegangen, wird nicht gedrosselt.
 */
async function claimAccountantMail(organizationId: string, kind: AccountantMailKind, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - ACCOUNTANT_MAIL_THROTTLE_HOURS * 3600_000).toISOString();
  // Status hat sich seit der letzten Mail dieser Art geändert (z. B. Antrag → Rücknahme → erneuter Antrag):
  // dann nicht drosseln, sonst hielte die Steuerberatung den veralteten Stand für aktuell (AppSec I-1)
  const other: AccountantMailKind = kind === "deletion_request" ? "deletion_withdrawn" : "deletion_request";
  const prev = sql`(case when jsonb_typeof(${organizations.settings}->'accountantMailAt') = 'object' then ${organizations.settings}->'accountantMailAt' else '{}'::jsonb end)`;
  const rows = await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('accountantMailAt', ${prev} || jsonb_build_object(${kind}::text, ${now.toISOString()}::text))` })
    .where(
      and(
        eq(organizations.id, organizationId),
        sql`(case when coalesce(${prev}->>${kind}::text, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${prev}->>${kind}::text)::timestamptz <= ${cutoff}::timestamptz else true end
          or (coalesce(${prev}->>${other}::text, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' and coalesce(${prev}->>${kind}::text, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
              and (${prev}->>${other}::text)::timestamptz > (${prev}->>${kind}::text)::timestamptz))`,
      ),
    )
    .returning({ id: organizations.id });
  return rows.length > 0;
}

/** Versand an die Steuerberatung (Rolle accountant) mit Drossel und Audit; wirft nie. */
async function mailAccountants(
  organizationId: string,
  kind: AccountantMailKind,
  subject: string,
  text: string,
  auditMeta: Record<string, unknown>,
  opts: { mail?: () => MailPort; now?: Date },
): Promise<AccountantMailOutcome> {
  const action = kind === "deletion_request" ? "org.deletion_request_accountant_mail" : "org.deletion_withdrawn_accountant_mail";
  let mail: AccountantMailOutcome;
  try {
    if (!(await orgRecipientEmails(organizationId, ["accountant"])).length) return "no_recipient";
    mail = (await claimAccountantMail(organizationId, kind, opts.now ?? new Date()))
      ? await sendOrgMail(organizationId, subject, text, { primary: ["accountant"], mail: opts.mail, logKey: `org.${kind}` })
      : "throttled";
  } catch (e) {
    log.warn(`org.${kind}.mail_failed`, { organizationId, error: e });
    mail = "failed";
  }
  await audit({ organizationId, action, entity: "organization", entityId: organizationId, meta: { mail, ...auditMeta } }).catch((e) =>
    log.warn(`org.${kind}.audit_failed`, { organizationId, error: e }),
  );
  return mail;
}

/**
 * Freiwilliger Löschantrag (Buchhaltung E4): Die Steuerberatung (Rolle accountant) erfährt Löschtermin und was vorher zu
 * sichern ist – die Aufbewahrungspflichten der Praxis laufen weiter. Kassen-Hinweis in der 3. Person (Recht R-3).
 * Ohne Steuerberatung bzw. Plattform-SMTP: nichts; höchstens eine E-Mail je Praxis und 24 h (AppSec AS-2).
 */
export async function notifyAccountantsOfDeletionRequest(
  organizationId: string,
  practiceName: string,
  requestedAt: Date,
  opts: { mail?: () => MailPort; now?: Date } = {},
): Promise<AccountantMailOutcome> {
  const due = dateDe(deletionDueAt(requestedAt));
  const url = publicUrl();
  const text = [
    "Hallo,",
    "",
    `für die Praxis „${practiceName}“, bei der du in PodoHero als Steuerberatung eingetragen bist, wurde am ${dateDe(requestedAt)} die Löschung beantragt. Wir löschen die Praxis am ${due} endgültig (spätestens 14 Tage danach), sofern der Antrag nicht vorher zurückgenommen wird. Danach sind auch deine Zugänge und alle Belege in PodoHero gelöscht.`,
    "",
    `Die Aufbewahrungspflichten der Praxis bleiben bestehen. Bitte stimme mit der Praxis ab, dass sie vorher einen vollständigen Export erstellt (Einstellungen → Daten & Kündigung): Er enthält Rechnungen und Zahlungsbelege als Original-PDF mit Prüfsumme und das Kassenbuch als Tabelle. ${ACCOUNTANT_CASH_NOTE}`,
    ...(url ? ["", url] : []),
    "",
    "Viele Grüße",
    "PodoHero",
  ].join("\n");
  return mailAccountants(organizationId, "deletion_request", `Löschantrag der Praxis „${practiceName}“ – Löschung am ${due} – PodoHero`, text, { deletionAt: deletionDueAt(requestedAt).toISOString() }, opts);
}

/**
 * Rücknahme des Löschantrags (Buchhaltung BK-5): Gegen-Mail an die Steuerberatung – die Praxis bleibt bestehen.
 * Gleiche Drossel wie beim Antrag (AppSec AS-2).
 */
export async function notifyAccountantsOfDeletionWithdrawal(
  organizationId: string,
  practiceName: string,
  opts: { mail?: () => MailPort; now?: Date } = {},
): Promise<AccountantMailOutcome> {
  const now = opts.now ?? new Date();
  const url = publicUrl();
  const text = [
    "Hallo,",
    "",
    `für die Praxis „${practiceName}“, bei der du in PodoHero als Steuerberatung eingetragen bist, wurde der Löschantrag am ${dateDe(now)} zurückgenommen. Die Praxis wird nicht gelöscht; deine Zugänge und die Belege in PodoHero bleiben bestehen.`,
    ...(url ? ["", url] : []),
    "",
    "Viele Grüße",
    "PodoHero",
  ].join("\n");
  return mailAccountants(organizationId, "deletion_withdrawn", `Löschantrag der Praxis „${practiceName}“ zurückgenommen – PodoHero`, text, {}, { ...opts, now });
}
