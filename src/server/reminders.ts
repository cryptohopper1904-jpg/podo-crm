import "server-only";
import { and, desc, eq, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { db, withOrg, type Tx } from "@/db";
import { appointments, braceEpisodes, consents, messages, organizations, patients, reminderLog, treatmentRecords } from "@/db/schema";
import { audit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/assert";
import type { AuthContext } from "@/lib/auth/session";
import {
  grantedConsents,
  parseReminderSettings,
  planReminders,
  R24_WINDOW,
  type PlannedReminder,
  type ReminderCandidates,
  type ReminderChannel,
  type ReminderPatient,
  type ReminderSettings,
} from "@/lib/reminders";
import { describeError } from "@/integrations/test-connection";
import type { MessagingPort, MessagingProvider } from "@/integrations/types";
import { adapterFor, logSync } from "./integrations";

export * from "@/lib/reminders";

const PROVIDER: Record<ReminderChannel, MessagingProvider> = { email: "email_imap", sms: "sms", whatsapp: "whatsapp" };
const REMINDER_CONSENTS = ["email_reminders", "sms_reminders", "whatsapp"] as const;

/** Lädt alle Kandidaten einer Praxis (innerhalb von withOrg; Abfragen nacheinander – eine Verbindung pro Transaktion). */
export async function loadReminderCandidates(tx: Tx, org: string, settings: ReminderSettings, practice: { name: string; phone: string | null }, now = new Date()): Promise<ReminderCandidates> {
  const c: ReminderCandidates = {
    now,
    practice,
    settings,
    patients: new Map(),
    consents: new Map(),
    appointments: [],
    lastVisit: new Map(),
    visitIntervalWeeks: new Map(),
    hasUpcoming: new Set(),
    lastRecallAt: new Map(),
    lastBraceCheckAt: new Map(),
    braceEpisodes: [],
  };
  const ids = new Set<string>();

  if (settings.r24) {
    const from = new Date(now.getTime() + R24_WINDOW.fromHours * 3600_000);
    const to = new Date(now.getTime() + R24_WINDOW.toHours * 3600_000);
    const rows = await tx
      .select({ id: appointments.id, patientId: appointments.patientId, startsAt: appointments.startsAt, status: appointments.status })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, from), lt(appointments.startsAt, to), inArray(appointments.status, ["planned", "confirmed"])));
    for (const r of rows) {
      if (!r.patientId) continue;
      c.appointments.push({ id: r.id, patientId: r.patientId, startsAt: r.startsAt, status: r.status });
      ids.add(r.patientId);
    }
  }

  if (settings.recall || settings.braceCheck) {
    const upcoming = await tx
      .selectDistinct({ patientId: appointments.patientId })
      .from(appointments)
      .where(and(eq(appointments.organizationId, org), gte(appointments.startsAt, now), inArray(appointments.status, ["planned", "confirmed"])));
    for (const u of upcoming) if (u.patientId) c.hasUpcoming.add(u.patientId);
    const logs = await tx
      .select({ patientId: reminderLog.patientId, kind: reminderLog.kind, at: max(reminderLog.at) })
      .from(reminderLog)
      .where(and(eq(reminderLog.organizationId, org), inArray(reminderLog.kind, ["recall", "brace_check"]), inArray(reminderLog.status, ["sent", "pending"])))
      .groupBy(reminderLog.patientId, reminderLog.kind);
    for (const l of logs) {
      if (!l.patientId || !l.at) continue;
      (l.kind === "recall" ? c.lastRecallAt : c.lastBraceCheckAt).set(l.patientId, new Date(l.at));
    }
  }

  if (settings.recall) {
    // nur Personen mit Erinnerungs-Einwilligung laden (spart Arbeit bei großen Praxen)
    const consenting = tx
      .selectDistinct({ patientId: consents.patientId })
      .from(consents)
      .where(and(eq(consents.organizationId, org), inArray(consents.type, [...REMINDER_CONSENTS]), eq(consents.granted, true)));
    const rows = await tx
      .select({ patientId: appointments.patientId, last: max(appointments.startsAt), interval: patients.visitIntervalWeeks })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(
        and(
          eq(appointments.organizationId, org),
          eq(appointments.status, "done"),
          isNull(patients.archivedAt),
          inArray(appointments.patientId, consenting),
        ),
      )
      .groupBy(appointments.patientId, patients.visitIntervalWeeks);
    for (const r of rows) {
      if (!r.patientId) continue;
      c.lastVisit.set(r.patientId, r.last ? new Date(r.last) : null);
      c.visitIntervalWeeks.set(r.patientId, r.interval);
      ids.add(r.patientId);
    }
  }

  if (settings.braceCheck) {
    const eps = await tx
      .select({ id: braceEpisodes.id, patientId: braceEpisodes.patientId, startedAt: braceEpisodes.startedAt })
      .from(braceEpisodes)
      .where(and(eq(braceEpisodes.organizationId, org), eq(braceEpisodes.status, "active"), isNull(braceEpisodes.endedAt)));
    if (eps.length) {
      const pids = [...new Set(eps.map((e) => e.patientId))];
      // nur das Datum der letzten Doku – keine Inhalte
      const last = await tx
        .select({ patientId: treatmentRecords.patientId, at: max(treatmentRecords.treatedAt) })
        .from(treatmentRecords)
        .where(and(eq(treatmentRecords.organizationId, org), inArray(treatmentRecords.patientId, pids)))
        .groupBy(treatmentRecords.patientId);
      const lastBy = new Map(last.map((l) => [l.patientId, l.at ? new Date(l.at) : null]));
      for (const e of eps) {
        c.braceEpisodes.push({ ...e, lastRecordAt: lastBy.get(e.patientId) ?? null });
        ids.add(e.patientId);
      }
    }
  }

  if (ids.size) {
    const list = [...ids];
    const ps = await tx
      .select({ id: patients.id, firstName: patients.firstName, email: patients.email, phoneMobile: patients.phoneMobile, preferredChannel: patients.preferredChannel, extra: patients.extra, archivedAt: patients.archivedAt })
      .from(patients)
      .where(and(eq(patients.organizationId, org), inArray(patients.id, list)));
    for (const p of ps) {
      if (p.archivedAt) continue;
      const extra = (p.extra ?? {}) as Record<string, unknown>;
      const rp: ReminderPatient = {
        id: p.id,
        firstName: p.firstName,
        email: p.email,
        phoneMobile: p.phoneMobile,
        preferredChannel: p.preferredChannel,
        noReminders: extra.no_reminders === true || extra.no_reminders === "true",
      };
      c.patients.set(p.id, rp);
    }
    const cons = await tx
      .select({ patientId: consents.patientId, type: consents.type, granted: consents.granted, recordedAt: consents.recordedAt })
      .from(consents)
      .where(and(eq(consents.organizationId, org), inArray(consents.patientId, list), inArray(consents.type, [...REMINDER_CONSENTS])))
      .orderBy(desc(consents.recordedAt));
    const byPatient = new Map<string, typeof cons>();
    for (const r of cons) byPatient.set(r.patientId, [...(byPatient.get(r.patientId) ?? []), r]);
    for (const [pid, rows] of byPatient) c.consents.set(pid, grantedConsents(rows));
  }
  return c;
}

export type ReminderRunSummary = { organizationId: string; planned: number; sent: number; failed: number; duplicates: number; skipped: number; mock: boolean };

/** Reserviert eine Erinnerung (Dedupe über reminder_log). false = schon vorhanden → nicht senden. */
export async function claimReminder(org: string, r: PlannedReminder): Promise<string | null> {
  const rows = await withOrg(org, (tx) =>
    tx
      .insert(reminderLog)
      .values({ organizationId: org, patientId: r.patientId, appointmentId: r.appointmentId, kind: r.kind, channel: r.channel, status: "pending", dedupeKey: r.dedupeKey })
      .onConflictDoNothing({ target: [reminderLog.organizationId, reminderLog.dedupeKey] })
      .returning({ id: reminderLog.id }),
  );
  return rows[0]?.id ?? null;
}

type SendDeps = { getPort?: (org: string, provider: MessagingProvider) => Promise<MessagingPort> };

/** Versendet geplante Erinnerungen einer Praxis: erst Log-Zeile (Dedupe), dann Versand, dann Status. */
export async function sendPlannedReminders(org: string, list: PlannedReminder[], deps: SendDeps = {}) {
  const getPort = deps.getPort ?? ((o, p) => adapterFor(o, p));
  const out = { sent: 0, failed: 0, duplicates: 0, mock: false };
  const ports = new Map<MessagingProvider, MessagingPort | Error>();
  for (const r of list) {
    const logId = await claimReminder(org, r);
    if (!logId) {
      out.duplicates++;
      continue;
    }
    const provider = PROVIDER[r.channel];
    let status: "sent" | "failed" = "sent";
    let detail: string;
    try {
      if (!ports.has(provider)) ports.set(provider, await getPort(org, provider).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
      const port = ports.get(provider)!;
      if (port instanceof Error) throw port;
      const res = await port.send({ to: r.to, body: r.body, subject: r.channel === "email" ? r.subject : undefined });
      out.mock ||= port.isMock;
      detail = port.isMock ? "Testmodus – nicht wirklich versendet" : `versendet (${res.externalId})`.slice(0, 200);
      await withOrg(org, (tx) =>
        tx.insert(messages).values({
          organizationId: org,
          patientId: r.patientId,
          channel: r.channel,
          direction: "outbound",
          toAddress: r.to,
          subject: r.channel === "email" ? r.subject : null,
          body: r.body,
          status: "answered",
          externalId: res.externalId,
          threadKey: r.to,
        }),
      );
      out.sent++;
    } catch (e) {
      status = "failed";
      detail = describeError(e).slice(0, 300);
      out.failed++;
    }
    await withOrg(org, (tx) => tx.update(reminderLog).set({ status, detail }).where(and(eq(reminderLog.organizationId, org), eq(reminderLog.id, logId))));
  }
  return out;
}

/** Eine Praxis abarbeiten. */
export async function runRemindersForOrg(org: { id: string; name: string; phone: string | null; settings: unknown }, now = new Date(), deps: SendDeps = {}): Promise<ReminderRunSummary> {
  const settings = parseReminderSettings((org.settings as Record<string, unknown> | null)?.reminders);
  const empty = { organizationId: org.id, planned: 0, sent: 0, failed: 0, duplicates: 0, skipped: 0, mock: false };
  if (!settings.r24 && !settings.recall && !settings.braceCheck) return empty;
  const candidates = await withOrg(org.id, (tx) => loadReminderCandidates(tx, org.id, settings, { name: org.name, phone: org.phone }, now));
  const plan = planReminders(candidates);
  if (!plan.planned.length) return { ...empty, skipped: plan.skipped.length };
  const res = await sendPlannedReminders(org.id, plan.planned, deps);
  const summary = { organizationId: org.id, planned: plan.planned.length, skipped: plan.skipped.length, ...res };
  if (res.sent || res.failed) {
    await audit({ organizationId: org.id, action: "reminders.run", meta: { sent: res.sent, failed: res.failed, duplicates: res.duplicates, mock: res.mock } });
    if (res.failed) await logSync(org.id, "sms", { direction: "out", ok: false, message: `Erinnerungen: ${res.failed} fehlgeschlagen (Details unter Einstellungen → Erinnerungen)` }).catch(() => undefined);
  }
  return summary;
}

/** Runner für alle Praxen (organizations hat keine RLS; pro Praxis withOrg). Fehler einer Praxis stoppen nicht die anderen. */
export async function runReminders(opts: { now?: Date; organizationId?: string } = {}) {
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, phone: organizations.phone, settings: organizations.settings })
    .from(organizations)
    .where(opts.organizationId ? eq(organizations.id, opts.organizationId) : sql`(${organizations.settings} -> 'reminders') is not null`);
  const results: ReminderRunSummary[] = [];
  const errors: { organizationId: string; error: string }[] = [];
  for (const o of orgs) {
    try {
      results.push(await runRemindersForOrg(o, opts.now));
    } catch (e) {
      errors.push({ organizationId: o.id, error: describeError(e).slice(0, 200) });
    }
  }
  return {
    organizations: orgs.length,
    sent: results.reduce((s, r) => s + r.sent, 0),
    failed: results.reduce((s, r) => s + r.failed, 0),
    duplicates: results.reduce((s, r) => s + r.duplicates, 0),
    skipped: results.reduce((s, r) => s + r.skipped, 0),
    errors,
  };
}

export async function reminderLogFor(org: string, limit = 50) {
  return withOrg(org, (tx) =>
    tx
      .select({ log: reminderLog, firstName: patients.firstName, lastName: patients.lastName })
      .from(reminderLog)
      .leftJoin(patients, eq(patients.id, reminderLog.patientId))
      .where(eq(reminderLog.organizationId, org))
      .orderBy(desc(reminderLog.at))
      .limit(limit),
  );
}

// ───────────── Einstellungen (mit Rechteprüfung) ─────────────

/** Einstellungen speichern (organizations hat keine RLS → nur die eigene Praxis aus der Sitzung). */
export async function saveReminderSettings(auth: AuthContext, settings: ReminderSettings) {
  assertCan(auth, "settings.manage");
  const clean = parseReminderSettings(settings);
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('reminders', ${JSON.stringify(clean)}::jsonb)` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "settings.reminders", meta: clean });
  return clean;
}

export async function loadReminderSettings(auth: AuthContext) {
  assertCan(auth, "settings.manage");
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  return parseReminderSettings((o?.settings as Record<string, unknown> | undefined)?.reminders);
}

export async function runRemindersForPractice(auth: AuthContext) {
  assertCan(auth, "settings.manage");
  const r = await runReminders({ organizationId: auth.organization.id });
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "reminders.run_manual", meta: { sent: r.sent, failed: r.failed } });
  return r;
}

export async function listReminderLog(auth: AuthContext, limit = 50) {
  assertCan(auth, "settings.manage");
  const rows = await reminderLogFor(auth.organization.id, limit);
  await audit({ organizationId: auth.organization.id, userId: auth.user.id, action: "reminders.log_read", meta: { n: rows.length } });
  return rows;
}
