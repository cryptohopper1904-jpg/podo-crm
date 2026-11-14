import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, withOrg, type Db, type Tx } from "@/db";
import { auditLog, memberships, messages, organizations, users } from "@/db/schema";
import { MailNotConfiguredError, type MailPort } from "@/integrations/mail/mail";
import { dateDe } from "@/lib/format";
import { log } from "@/lib/log";
import { deletionDueAt } from "@/lib/org-deletion";
import {
  AUTO_DELETION_REASON,
  isAutoDeletion,
  plannedDeletionDate,
  readonlyExpiry,
  readonlyExpiryState,
  REMINDER_LEAD_DAYS,
  type MailOutcome,
} from "@/lib/readonly-expiry";
import { platformMailPort } from "./mail";

/**
 * Cron „Ende des Nur-Lesen-Modus“ (Fristen und Ablauf: src/lib/readonly-expiry.ts). Je Praxis eigener Fehlerpfad.
 * Ankündigung und Erinnerung werden vor dem Versand per bedingtem UPDATE „beansprucht“ – parallele oder wiederholte
 * Läufe senden sie daher genau einmal. Versand über den Plattform-SMTP (SMTP_URL/SMTP_FROM); ohne ihn bleibt es bei
 * Posteingang, Hinweisleiste und Plattform-Konsole (Status „not_configured“ – Betreiber kündigt dann selbst in Textform an).
 */

const DAY = 86_400_000;

export type ReadonlyExpiryRun = { checked: number; notices: number; requests: number; reminders: number; stopped: number; failed: number; mailNotSent: number };

/** `organizationIds`: nur diese Praxen prüfen (Tests, gezielte Läufe); `mail`: Versandweg ersetzen (Tests) */
type Deps = { now?: Date; mail?: () => MailPort; organizationIds?: string[] };

const publicUrl = () => (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

/**
 * Automatische Löschung stoppen (Tarif gebucht, Testphase verlängert, Kostenlos-Tarif …): entfernt den Zustand der
 * Ankündigung und – nur wenn er automatisch gestellt wurde – den Löschantrag. Ein selbst gestellter Löschantrag bleibt.
 * true = es wurde etwas zurückgesetzt.
 */
export async function stopAutoDeletion(exec: Db | Tx, organizationId: string, meta: { trigger: string; userId?: string | null }): Promise<boolean> {
  const auto = sql`(${organizations.settings}->>'deletionReason') = ${AUTO_DELETION_REASON}`;
  const rows = await exec
    .update(organizations)
    .set({
      deletionRequestedAt: sql`case when ${auto} then null else ${organizations.deletionRequestedAt} end`,
      settings: sql`(coalesce(${organizations.settings}, '{}'::jsonb) - 'readonlyExpiry') - (case when ${auto} then 'deletionReason' else '' end)`,
    })
    .where(and(eq(organizations.id, organizationId), sql`(${organizations.settings} ? 'readonlyExpiry' or ${auto})`))
    .returning({ id: organizations.id });
  if (!rows.length) return false;
  await exec.insert(auditLog).values({ organizationId, userId: meta.userId ?? null, action: "org.readonly_expiry_stopped", entity: "organization", entityId: organizationId, meta: { trigger: meta.trigger } });
  return true;
}

async function ownerEmails(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), eq(memberships.role, "owner")));
  return [...new Set(rows.map((r) => r.email))];
}

async function deliver(organizationId: string, subject: string, text: string, deps: Deps): Promise<MailOutcome> {
  const to = await ownerEmails(organizationId);
  if (!to.length) return "no_recipient";
  let port: MailPort;
  try {
    port = (deps.mail ?? (() => platformMailPort()))();
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return "not_configured";
    throw e;
  }
  if (port.isMock) return "not_configured";
  let ok = 0;
  for (const addr of to) {
    try {
      await port.send({ to: addr, subject, text });
      ok++;
    } catch (e) {
      log.warn("cron.readonly_expiry.mail_failed", { organizationId, error: e });
    }
  }
  return ok ? "sent" : "failed";
}

async function inbox(organizationId: string, subject: string, body: string) {
  await withOrg(organizationId, (tx) =>
    tx.insert(messages).values({ organizationId, patientId: null, channel: "none", direction: "inbound", fromAddress: "PodoHero", subject, body, status: "new", threadKey: "podohero-loeschung" }),
  );
}

function noticeText(name: string, contractEnd: Date, deletionAt: Date, reminder: boolean): { subject: string; body: string; text: string } {
  const date = dateDe(deletionAt);
  const url = publicUrl();
  const subject = reminder ? `Erinnerung: Deine Praxis wird ab dem ${date} gelöscht – PodoHero` : `Ankündigung: Löschung deiner Praxis ab dem ${date} – PodoHero`;
  const body = [
    reminder
      ? `wie angekündigt löschen wir deine Praxis „${name}“ in PodoHero ab dem ${date} endgültig.`
      : `dein Vertrag für die Praxis „${name}“ in PodoHero ist am ${dateDe(contractEnd)} geendet. Seitdem ist die Praxis im Nur-Lesen-Modus: Alle Daten sind lesbar und exportierbar, Änderungen sind gesperrt.`,
    "",
    ...(reminder
      ? []
      : [
          `Der Nur-Lesen-Modus endet spätestens 12 Monate nach Vertragsende (AGB § 9 Nr. 2). Wir löschen deine Praxis deshalb ab dem ${date} endgültig – mit allen Patient:innen, Dokumentation, Fotos, Rechnungen, Terminen und Zugängen. Verschlüsselte Datensicherungen laufen spätestens 30 Tage nach der Löschung aus.`,
          "",
        ]),
    "Bitte erstelle vorher einen vollständigen Export (Einstellungen → Daten & Kündigung) und bewahre ihn sicher auf. Deine gesetzlichen Aufbewahrungspflichten (z. B. 10 Jahre Behandlungsdokumentation nach § 630f Abs. 3 BGB, 8 bzw. 10 Jahre für Belege und Bücher nach § 147 AO) erfüllst du mit dem Export. Hast du die Kasse genutzt, erstelle auch den DSFinV-K- und den TSE-Export – nach der Löschung lassen sie sich nicht mehr erzeugen.",
    "",
    "Möchtest du PodoHero weiter nutzen, wähle unter Einstellungen → Abo einen Tarif (bis 20 Patient:innen auch kostenlos) – dann entfällt die Löschung.",
  ].join("\n");
  const text = ["Hallo,", "", body, ...(url ? ["", `${url}/einstellungen/daten`] : []), "", "Viele Grüße", "PodoHero"].join("\n");
  return { subject, body, text };
}

const stateSql = (patch: Record<string, string>) =>
  sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('readonlyExpiry', coalesce(${organizations.settings}->'readonlyExpiry', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`;

async function setState(organizationId: string, patch: Record<string, string>) {
  await db.update(organizations).set({ settings: stateSql(patch) }).where(eq(organizations.id, organizationId));
}

type OrgRow = Awaited<ReturnType<typeof candidates>>[number];

async function candidates(only?: string[]) {
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      trialEndsAt: organizations.trialEndsAt,
      currentPeriodEnd: organizations.currentPeriodEnd,
      seats: organizations.seats,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      deletionRequestedAt: organizations.deletionRequestedAt,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(
      and(
        sql`((${organizations.plan} not in ('free', 'internal') and ${organizations.subscriptionStatus} in ('canceled', 'none', 'trialing', 'paused'))
          or ${organizations.settings} ? 'readonlyExpiry' or (${organizations.settings}->>'deletionReason') = ${AUTO_DELETION_REASON})`,
        only ? inArray(organizations.id, only.length ? only : ["00000000-0000-0000-0000-000000000000"]) : undefined,
      ),
    )
    .orderBy(organizations.createdAt)
    .limit(5000);
}

/** Ein Schritt für eine Praxis; Rückgabe = was geschah */
async function step(o: OrgRow, now: Date, deps: Deps): Promise<"none" | "notice" | "request" | "reminder" | "stopped" | "notice+request"> {
  const settings = (o.settings ?? {}) as Record<string, unknown>;
  const info = readonlyExpiry(o, now);
  const auto = isAutoDeletion(settings);
  if (!info) {
    // nicht (mehr) im Nur-Lesen-Modus nach Vertragsende – z. B. Tarif gebucht
    if (settings.readonlyExpiry !== undefined || auto) return (await stopAutoDeletion(db, o.id, { trigger: "cron" })) ? "stopped" : "none";
    return "none";
  }
  // selbst gestellter Löschantrag: normaler Löschlauf, keine eigene Ankündigung nötig
  if (o.deletionRequestedAt && !auto) return "none";
  const state = readonlyExpiryState(settings);

  if (o.deletionRequestedAt && auto) {
    const due = deletionDueAt(o.deletionRequestedAt);
    if (state.reminderSentAt || now.getTime() < due.getTime() - REMINDER_LEAD_DAYS * DAY) return "none";
    const claimed = await db
      .update(organizations)
      .set({ settings: stateSql({ reminderSentAt: now.toISOString() }) })
      .where(and(eq(organizations.id, o.id), isNotNull(organizations.deletionRequestedAt), sql`${organizations.settings}->'readonlyExpiry'->>'reminderSentAt' is null`))
      .returning({ id: organizations.id });
    if (!claimed.length) return "none";
    const { subject, body, text } = noticeText(o.name, info.contractEnd, due, true);
    await inbox(o.id, `Erinnerung: Löschung der Praxis ab dem ${dateDe(due)}`, body).catch((e) => log.error("cron.readonly_expiry.inbox_failed", { organizationId: o.id, error: e }));
    const mail = await deliver(o.id, subject, text, deps);
    await setState(o.id, { reminderMail: mail });
    await db.insert(auditLog).values({ organizationId: o.id, action: "org.readonly_expiry_reminder", entity: "organization", entityId: o.id, meta: { deletionAt: due.toISOString(), mail } });
    return "reminder";
  }

  let did: "none" | "notice" = "none";
  if (!state.noticeSentAt) {
    if (now < info.noticeAt) return "none";
    // angekündigter Termin: spätester Termin, aber nie weniger als 30 Tage nach der Ankündigung
    const deletionAt = plannedDeletionDate(info, state, null, now);
    const claimed = await db
      .update(organizations)
      .set({ settings: stateSql({ noticeSentAt: now.toISOString(), deletionAt: deletionAt.toISOString() }) })
      .where(and(eq(organizations.id, o.id), isNull(organizations.deletionRequestedAt), sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is null`))
      .returning({ id: organizations.id });
    if (!claimed.length) return "none";
    const { subject, body, text } = noticeText(o.name, info.contractEnd, deletionAt, false);
    await inbox(o.id, `Löschung der Praxis ab dem ${dateDe(deletionAt)}`, body).catch((e) => log.error("cron.readonly_expiry.inbox_failed", { organizationId: o.id, error: e }));
    const mail = await deliver(o.id, subject, text, deps);
    await setState(o.id, { noticeMail: mail });
    await db.insert(auditLog).values({ organizationId: o.id, action: "org.readonly_expiry_notice", entity: "organization", entityId: o.id, meta: { deletionAt: deletionAt.toISOString(), contractEnd: info.contractEnd.toISOString(), mail } });
    did = "notice";
  }
  if (now < info.requestAt) return did;
  // automatischer Löschantrag (frühestens mit der Ankündigung): der Löschlauf löscht 30 Tage danach
  const req = await db
    .update(organizations)
    .set({ deletionRequestedAt: now, settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('deletionReason', ${AUTO_DELETION_REASON}::text)` })
    .where(and(eq(organizations.id, o.id), isNull(organizations.deletionRequestedAt), sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is not null`))
    .returning({ id: organizations.id });
  if (!req.length) return did;
  await db.insert(auditLog).values({
    organizationId: o.id,
    action: "org.deletion_requested",
    entity: "organization",
    entityId: o.id,
    meta: { reason: AUTO_DELETION_REASON, deletionAt: deletionDueAt(now).toISOString(), contractEnd: info.contractEnd.toISOString() },
  });
  return did === "notice" ? "notice+request" : "request";
}

export async function runReadonlyExpiry(deps: Deps = {}): Promise<ReadonlyExpiryRun> {
  const now = deps.now ?? new Date();
  const rows = await candidates(deps.organizationIds);
  const out: ReadonlyExpiryRun = { checked: rows.length, notices: 0, requests: 0, reminders: 0, stopped: 0, failed: 0, mailNotSent: 0 };
  for (const o of rows) {
    try {
      const r = await step(o, now, deps);
      if (r === "notice" || r === "notice+request") out.notices++;
      if (r === "request" || r === "notice+request") out.requests++;
      if (r === "reminder") out.reminders++;
      if (r === "stopped") out.stopped++;
    } catch (e) {
      out.failed++;
      log.error("cron.readonly_expiry.failed", { organizationId: o.id, error: e });
    }
  }
  out.mailNotSent = rows.length
    ? Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(organizations)
            .where(and(inArray(organizations.id, rows.map((r) => r.id)), sql`${organizations.settings}->'readonlyExpiry'->>'noticeMail' in ('not_configured', 'failed', 'no_recipient')`))
        )[0]?.n ?? 0,
      )
    : 0;
  return out;
}

/** Hinweis für die App (Hinweisleiste, Abo-/Daten-Seite): voraussichtlicher Löschtermin, sonst null. */
export async function readonlyDeletionNotice(organizationId: string, now: Date = new Date()): Promise<{ deletionAt: Date; auto: boolean } | null> {
  const [o] = await db
    .select({
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      trialEndsAt: organizations.trialEndsAt,
      currentPeriodEnd: organizations.currentPeriodEnd,
      seats: organizations.seats,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      deletionRequestedAt: organizations.deletionRequestedAt,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!o) return null;
  const info = readonlyExpiry(o, now);
  if (!info) return null;
  const auto = isAutoDeletion(o.settings);
  if (o.deletionRequestedAt && !auto) return null;
  return { deletionAt: plannedDeletionDate(info, readonlyExpiryState(o.settings), o.deletionRequestedAt, now), auto };
}
