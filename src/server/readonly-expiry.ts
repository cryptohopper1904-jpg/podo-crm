import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, withOrg, type Db, type Tx } from "@/db";
import { auditLog, messages, organizations } from "@/db/schema";
import type { MailPort } from "@/integrations/mail/mail";
import { audit } from "@/lib/audit";
import { dateDe } from "@/lib/format";
import { log } from "@/lib/log";
import { CASH_REGISTER_NOTE, deletionDueAt, DELETION_GRACE_DAYS, EXPORT_CASH_NOTE } from "@/lib/org-deletion";
import { GRACE_DAYS } from "@/lib/plans";
import {
  AUTO_DELETION_REASON,
  isAutoDeletion,
  needsManualNotice,
  plannedDeletionDate,
  readonlyExpiry,
  readonlyExpiryState,
  REMINDER_LEAD_DAYS,
  MANUAL_NOTICE_VIAS,
  type MailOutcome,
  type ManualNoticeVia,
  type ReadonlyExpiry,
} from "@/lib/readonly-expiry";
import { sendOrgMail } from "./org-mail";

/**
 * Cron „Ende des Nur-Lesen-Modus“ (Fristen und Ablauf: src/lib/readonly-expiry.ts). Je Praxis eigener Fehlerpfad.
 * Ankündigung und Erinnerung werden vor dem Versand per bedingtem UPDATE „beansprucht“ – parallele oder wiederholte
 * Läufe senden sie daher genau einmal. Versand über den Plattform-SMTP (SMTP_URL/SMTP_FROM); ohne ihn bleibt es bei
 * Posteingang, Hinweisleiste und Plattform-Konsole (Status „not_configured“ – Betreiber kündigt dann selbst in Textform an
 * und vermerkt das in der Konsole, recordManualNotice). Ohne zugestellte Ankündigung wird KEIN Löschantrag gestellt.
 * Jedes bedingte UPDATE prüft zusätzlich in SQL, dass die Praxis noch nach Vertragsende im Nur-Lesen-Modus ist
 * (readonlySql) – bucht sie zwischen Lesen und Schreiben einen Tarif, passiert nichts.
 */

const DAY = 86_400_000;
/** Abstand zwischen zwei Versuchen einer nicht zugestellten Ankündigung */
export const NOTICE_RETRY_HOURS = 24;
/** Praxen je Seite (Keyset-Paginierung über die ID) */
const PAGE_SIZE = 1000;

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

/**
 * SQL-Gegenstück zu readonlyExpiry(): Praxis ist (noch) nach Vertragsende im Nur-Lesen-Modus – kein Kostenlos/Intern,
 * kein laufendes Stripe-Abo, Testphase abgelaufen bzw. bezahlter Zeitraum + Kulanz vorbei. Notwendige Bedingung in den
 * WHERE-Klauseln der bedingten UPDATEs (AppSec L-3).
 */
export const readonlySql = (now: Date) => {
  const t = sql`${now.toISOString()}::timestamptz`;
  return sql`(${organizations.plan} not in ('free', 'internal')
    and ${organizations.subscriptionStatus} in ('canceled', 'none', 'trialing', 'paused')
    and not (${organizations.stripeSubscriptionId} is not null and ${organizations.subscriptionStatus} in ('trialing', 'paused'))
    and case when ${organizations.subscriptionStatus} = 'trialing' or (${organizations.plan} = 'trial' and ${organizations.subscriptionStatus} = 'none')
      then ${organizations.trialEndsAt} is not null and ${organizations.trialEndsAt} <= ${t}
      else coalesce(${organizations.currentPeriodEnd}, ${organizations.trialEndsAt}) is not null
        and coalesce(${organizations.currentPeriodEnd}, ${organizations.trialEndsAt}) + make_interval(days => ${GRACE_DAYS}) <= ${t} end)`;
};

/**
 * Versand der Ankündigung/Erinnerung; wirft nie. „sent“ nur, wenn mindestens eine Inhaber:innen-Adresse angenommen hat
 * (AGB § 9 Nr. 2: Ankündigung an die Inhaber:innen) – die Steuerberatung (Rolle accountant) erhält sie zusätzlich zur
 * Sicherung der Aufbewahrungspflichten, zählt aber nicht als Zugang (Recht B-1).
 */
function deliver(organizationId: string, subject: string, text: string, deps: Deps): Promise<MailOutcome> {
  return sendOrgMail(organizationId, subject, text, { primary: ["owner"], additional: ["accountant"], mail: deps.mail, logKey: "cron.readonly_expiry" });
}

async function inbox(organizationId: string, subject: string, body: string) {
  await withOrg(organizationId, (tx) =>
    tx.insert(messages).values({ organizationId, patientId: null, channel: "none", direction: "inbound", fromAddress: "PodoHero", subject, body, status: "new", threadKey: "podohero-loeschung" }),
  );
}

function noticeText(name: string, info: ReadonlyExpiry, deletionAt: Date, reminder: boolean): { subject: string; body: string; text: string } {
  const date = dateDe(deletionAt);
  const url = publicUrl();
  const trial = info.kind === "trial";
  // einheitlich mit AGB § 9 Nr. 2 / AVV § 10 Nr. 2: Löschung mit Ablauf des Nur-Lesen-Modus, spätestens 14 Tage danach (Recht E-2)
  const subject = reminder ? `Erinnerung: Wir löschen deine Praxis am ${date} – PodoHero` : `Ankündigung: Löschung deiner Praxis am ${date} – PodoHero`;
  const body = [
    reminder
      ? `wie angekündigt löschen wir deine Praxis „${name}“ in PodoHero am ${date} endgültig (spätestens 14 Tage danach).`
      : `${trial ? `deine Testphase für die Praxis „${name}“ in PodoHero endete am ${dateDe(info.contractEnd)}.` : `dein Vertrag für die Praxis „${name}“ in PodoHero endete am ${dateDe(info.contractEnd)}.`} Seitdem ist die Praxis im Nur-Lesen-Modus: Alle Daten sind lesbar und exportierbar, Änderungen sind gesperrt.`,
    "",
    ...(reminder
      ? []
      : [
          `Der Nur-Lesen-Modus endet spätestens 12 Monate nach ${trial ? "Ende der Testphase (AGB § 3 Nr. 5, § 9 Nr. 2)" : "Vertragsende (AGB § 9 Nr. 2)"}. Wir löschen deine Praxis deshalb am ${date} endgültig (spätestens 14 Tage danach) – mit allen Patient:innen, Dokumentation, Fotos, Rechnungen, Terminen und Zugängen. Verschlüsselte Datensicherungen werden spätestens 30 Tage nach der Löschung gelöscht.`,
          "",
        ]),
    `Bitte erstelle vorher einen vollständigen Export (Einstellungen → Daten & Kündigung). Den Export brauchst du, um deine Aufbewahrungspflichten zu erfüllen. Bewahre ihn unverändert, lesbar und maschinell auswertbar bis zum Fristende auf und stimme die Ablage mit deiner Steuerberatung ab. ${EXPORT_CASH_NOTE} ${CASH_REGISTER_NOTE}`,
    "",
    trial
      ? "Möchtest du PodoHero weiter nutzen, wähle unter Einstellungen → Abo einen Tarif. Für kleine Praxen gibt es den kostenlosen Tarif (bis 20 Patient:innen, ein Zugang) – auch damit entfällt die Löschung."
      : "Möchtest du PodoHero weiter nutzen, wähle unter Einstellungen → Abo einen Tarif (bis 20 Patient:innen auch den kostenlosen Tarif) – dann entfällt die Löschung.",
    ...(reminder ? [] : ["Du kannst die Löschung auch sofort beantragen (Einstellungen → Daten & Kündigung)."]),
  ].join("\n");
  const text = ["Hallo,", "", body, ...(url ? ["", `${url}/einstellungen/daten`] : []), "", "Viele Grüße", "PodoHero"].join("\n");
  return { subject, body, text };
}

const stateSql = (patch: Record<string, string | null>) =>
  sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('readonlyExpiry', coalesce(${organizations.settings}->'readonlyExpiry', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`;

async function setState(organizationId: string, patch: Record<string, string | null>) {
  await db.update(organizations).set({ settings: stateSql(patch) }).where(eq(organizations.id, organizationId));
}

type OrgRow = Awaited<ReturnType<typeof candidates>>[number];

/** Eine Seite Kandidaten (Keyset über die ID – keine Obergrenze für die Gesamtzahl) */
async function candidates(only: string[] | undefined, afterId: string | null) {
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
        afterId ? gt(organizations.id, afterId) : undefined,
      ),
    )
    .orderBy(organizations.id)
    .limit(PAGE_SIZE);
}

/** Ankündigung nachweislich in Textform zugegangen (E-Mail versendet oder Betreiber-Vermerk) – SQL-Gegenstück zu noticeDeliveredAt */
const deliveredSql = sql`(${organizations.settings}->'readonlyExpiry'->>'noticeMail' = 'sent' or ${organizations.settings}->'readonlyExpiry'->>'manualNoticeAt' is not null)`;

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
  const still = readonlySql(now);

  if (o.deletionRequestedAt && auto) {
    const due = deletionDueAt(o.deletionRequestedAt);
    if (state.reminderSentAt || now.getTime() < due.getTime() - REMINDER_LEAD_DAYS * DAY) return "none";
    const claimed = await db
      .update(organizations)
      // „unknown“, bis das Ergebnis feststeht: bricht der Lauf ab, gilt die Erinnerung als nicht versendet
      .set({ settings: stateSql({ reminderSentAt: now.toISOString(), reminderMail: "unknown" }) })
      .where(and(eq(organizations.id, o.id), isNotNull(organizations.deletionRequestedAt), still, sql`${organizations.settings}->'readonlyExpiry'->>'reminderSentAt' is null`))
      .returning({ id: organizations.id });
    if (!claimed.length) return "none";
    const { subject, body, text } = noticeText(o.name, info, due, true);
    await inbox(o.id, `Erinnerung: Löschung der Praxis am ${dateDe(due)}`, body).catch((e) => log.error("cron.readonly_expiry.inbox_failed", { organizationId: o.id, error: e }));
    const mail = await deliver(o.id, subject, text, deps);
    await setState(o.id, { reminderMail: mail });
    await db.insert(auditLog).values({ organizationId: o.id, action: "org.readonly_expiry_reminder", entity: "organization", entityId: o.id, meta: { deletionAt: due.toISOString(), mail } });
    return "reminder";
  }

  let did: "none" | "notice" = "none";
  let current = state;
  // Erstankündigung – oder erneuter Versuch, wenn die letzte Ankündigung nicht zugestellt wurde (Versandfehler, kein
  // Plattform-SMTP, kein Empfänger, abgebrochener Lauf) und der Betreiber noch nichts vermerkt hat: höchstens einmal je
  // NOTICE_RETRY_HOURS, mit neuem Termin (frühestens 30 Tage nach diesem Versuch).
  const retry =
    !!state.noticeSentAt && needsManualNotice(state) && now.getTime() - Date.parse(state.noticeSentAt) >= NOTICE_RETRY_HOURS * 3600_000;
  if (!state.noticeSentAt || retry) {
    if (now < info.noticeAt) return "none";
    // angekündigter Termin: spätester Termin, aber nie weniger als 30 Tage nach der Ankündigung
    const deletionAt = plannedDeletionDate(info, state, null, now);
    const claimed = await db
      .update(organizations)
      // „unknown“, bis das Versandergebnis feststeht: bricht der Lauf ab, gilt die Ankündigung als nicht zugestellt
      .set({ settings: stateSql({ noticeSentAt: now.toISOString(), deletionAt: deletionAt.toISOString(), noticeMail: "unknown" }) })
      .where(
        and(
          eq(organizations.id, o.id),
          isNull(organizations.deletionRequestedAt),
          still,
          retry
            ? sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' = ${state.noticeSentAt} and not ${deliveredSql}`
            : sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is null`,
        ),
      )
      .returning({ id: organizations.id });
    if (!claimed.length) return "none";
    const { subject, body, text } = noticeText(o.name, info, deletionAt, false);
    // Posteingang nur bei der Erstankündigung (Wiederholungen ändern nur den Termin; die Hinweisleiste zeigt ihn aktuell)
    if (!retry) await inbox(o.id, `Löschung der Praxis am ${dateDe(deletionAt)}`, body).catch((e) => log.error("cron.readonly_expiry.inbox_failed", { organizationId: o.id, error: e }));
    const mail = await deliver(o.id, subject, text, deps);
    await setState(o.id, { noticeMail: mail });
    await db.insert(auditLog).values({
      organizationId: o.id,
      action: "org.readonly_expiry_notice",
      entity: "organization",
      entityId: o.id,
      meta: { deletionAt: deletionAt.toISOString(), contractEnd: info.contractEnd.toISOString(), mail, ...(retry ? { retry: true, previousMail: state.noticeMail } : {}) },
    });
    did = "notice";
    current = { ...state, noticeSentAt: now.toISOString(), deletionAt: deletionAt.toISOString(), noticeMail: mail };
  }
  // Antrag frühestens 30 Tage vor dem angekündigten Termin (der Löschlauf löscht 30 Tage nach dem Antrag) und nur mit
  // zugegangener Ankündigung; der angekündigte Termin liegt mindestens 30 Tage nach dem Zugang (recordManualNotice).
  const announced = current.deletionAt ? Date.parse(current.deletionAt) : info.deletionAt.getTime();
  if (now < info.requestAt || now.getTime() < announced - DELETION_GRACE_DAYS * DAY) return did;
  const req = await db
    .update(organizations)
    .set({ deletionRequestedAt: now, settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('deletionReason', ${AUTO_DELETION_REASON}::text)` })
    .where(
      and(
        eq(organizations.id, o.id),
        isNull(organizations.deletionRequestedAt),
        still,
        sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is not null`,
        deliveredSql,
        sql`(${organizations.settings}->'readonlyExpiry'->>'deletionAt')::timestamptz <= ${new Date(now.getTime() + DELETION_GRACE_DAYS * DAY).toISOString()}::timestamptz`,
      ),
    )
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
  const out: ReadonlyExpiryRun = { checked: 0, notices: 0, requests: 0, reminders: 0, stopped: 0, failed: 0, mailNotSent: 0 };
  for (let afterId: string | null = null; ; ) {
    const rows = await candidates(deps.organizationIds, afterId);
    if (!rows.length) break;
    out.checked += rows.length;
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
    out.mailNotSent += Number(
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(organizations)
          .where(and(inArray(organizations.id, rows.map((r) => r.id)), sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is not null and not ${deliveredSql}`))
      )[0]?.n ?? 0,
    );
    if (rows.length < PAGE_SIZE) break;
    afterId = rows[rows.length - 1].id;
  }
  return out;
}

/** Hinweis für die App (Hinweisleiste, Abo-/Daten-Seite): voraussichtlicher Löschtermin, sonst null. */
export async function readonlyDeletionNotice(
  organizationId: string,
  now: Date = new Date(),
): Promise<{ deletionAt: Date; auto: boolean; kind: ReadonlyExpiry["kind"] } | null> {
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
  return { deletionAt: plannedDeletionDate(info, readonlyExpiryState(o.settings), o.deletionRequestedAt, now), auto, kind: info.kind };
}

export class ManualNoticeError extends Error {}

/**
 * Plattform-Konsole: Betreiber vermerkt, dass er die Löschung von Hand in Textform angekündigt hat (E-Mail nicht
 * zugestellt). `receivedAt` = Tag des Zugangs (bei Brief: Zustelltag). Der angekündigte Termin wird auf mindestens
 * Zugang + 30 Tage verschoben (AGB § 9 Nr. 2: Löschung frühestens 30 Tage nach Zugang); erst danach stellt der Cron den
 * automatischen Löschantrag. Aufrufer prüft Plattform-Admin mit 2FA. Audit an der Praxis (ohne Notiztext-Inhalte darüber hinaus).
 */
export async function recordManualNotice(
  adminUserId: string,
  organizationId: string,
  input: { receivedOn: string; via: ManualNoticeVia; note: string },
  now: Date = new Date(),
): Promise<{ deletionAt: Date }> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.receivedOn);
  if (!m || !Object.hasOwn(MANUAL_NOTICE_VIAS, input.via)) throw new ManualNoticeError("Eingaben ungültig.");
  // Tagesende (UTC liegt nach dem deutschen Tagesende) – höchstens jetzt: im Zweifel später, nie früher
  const endOfDay = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (Number.isNaN(endOfDay) || new Date(endOfDay).getUTCDate() !== Number(m[3])) throw new ManualNoticeError("Datum ungültig.");
  const startOfDay = endOfDay - DAY + 1;
  if (startOfDay > now.getTime()) throw new ManualNoticeError("Das Datum liegt in der Zukunft.");
  if (startOfDay < now.getTime() - 90 * DAY) throw new ManualNoticeError("Das Datum liegt mehr als 90 Tage zurück.");
  const note = input.note.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
  if (note.length < 5) throw new ManualNoticeError("Bitte den Nachweis kurz beschreiben (z. B. Versandweg, Empfänger, Aktenzeichen).");
  const receivedAt = new Date(Math.min(endOfDay, now.getTime()));

  const [o] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!o) throw new ManualNoticeError("Praxis nicht gefunden.");
  const state = readonlyExpiryState(o.settings);
  const info = readonlyExpiry(o, now);
  if (!info || !state.noticeSentAt) throw new ManualNoticeError("Für diese Praxis ist keine Löschung angekündigt.");
  if (o.deletionRequestedAt) throw new ManualNoticeError("Für diese Praxis läuft bereits ein Löschantrag.");
  const deletionAt = new Date(Math.max(state.deletionAt ? Date.parse(state.deletionAt) : 0, info.deletionAt.getTime(), receivedAt.getTime() + DELETION_GRACE_DAYS * DAY));
  const rows = await db
    .update(organizations)
    .set({
      settings: stateSql({
        manualNoticeAt: receivedAt.toISOString(),
        manualNoticeVia: input.via,
        manualNoticeNote: note,
        manualNoticeBy: adminUserId,
        manualNoticeRecordedAt: now.toISOString(),
        deletionAt: deletionAt.toISOString(),
      }),
    })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletionRequestedAt), readonlySql(now), sql`${organizations.settings}->'readonlyExpiry'->>'noticeSentAt' is not null`))
    .returning({ id: organizations.id });
  if (!rows.length) throw new ManualNoticeError("Zustand der Praxis hat sich geändert – bitte neu laden.");
  // mit IP des Plattform-Admins (audit() liest sie aus dem Request – AppSec I-2)
  await audit({
    organizationId,
    userId: adminUserId,
    action: "platform.readonly_notice_manual",
    entity: "organization",
    entityId: organizationId,
    meta: { receivedAt: receivedAt.toISOString(), via: input.via, note, deletionAt: deletionAt.toISOString(), mail: state.noticeMail },
  });
  return { deletionAt };
}
