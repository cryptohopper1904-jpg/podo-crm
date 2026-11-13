import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db, withOrg, type Tx } from "@/db";
import { memberships, organizations, users } from "@/db/schema";
import { berlinDateIso } from "@/lib/format";
import type { CheckResult } from "@/lib/ops-health";
import { checkMigrations, checkTimestamps } from "./ops-status";

/**
 * Betreiber-Dashboard: NUTZUNGSDATEN, NIE PATIENTENDATEN.
 *
 * Alle Werte sind Anzahlen, Summen oder Zeitstempel. Es werden keine Namen, Kontaktdaten, Akteninhalte,
 * Rechnungsempfänger o. Ä. gelesen – die SQL-Abfragen selektieren ausschließlich count()/sum()/max()/exists().
 * Zählwerte aus mandantengeschützten Tabellen werden je Praxis in withOrg() (RLS) ermittelt.
 * Der Test platform-stats.db.test.ts prüft die Form des Ergebnisses auf personenbezogene Felder.
 */

export const USAGE_MONTHS = 6;
/** Zeitraum für „Modul wird genutzt“ */
export const ADOPTION_DAYS = 90;

export const MODULES = {
  kalender: "Kalender",
  doku: "Behandlungsdoku",
  fotos: "Fotodoku",
  rechnungen: "Rechnungen",
  kasse: "Kasse",
  verordnungen: "Verordnungen",
  onlineBuchung: "Online-Buchung",
  portal: "Patientenportal",
  erinnerungen: "Erinnerungen",
  email: "E-Mail-Versand",
  telefon: "KI-Telefon",
  ki: "KI-Assistenz",
  ocr: "Verordnungs-OCR",
  hygiene: "Hygiene",
  gutscheine: "Gutscheine",
  website: "Praxis-Website",
} as const;
export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];

export const MONTHLY_METRICS = {
  appointments: "Termine",
  treatmentRecords: "Behandlungsdokus",
  invoicesIssued: "Rechnungen ausgestellt",
  revenueCents: "Rechnungssumme (brutto)",
  onlineBookings: "Online-Buchungen",
  portalBookings: "Portal-Buchungen",
  voiceMinutes: "Telefon-Minuten",
  emailsSent: "E-Mails versendet",
  aiUses: "KI-Nutzungen",
  ocrUses: "OCR-Auslesungen",
} as const;
export type MonthlyMetric = keyof typeof MONTHLY_METRICS;
export const MONTHLY_METRIC_KEYS = Object.keys(MONTHLY_METRICS) as MonthlyMetric[];

export type MonthlyUsage = { month: string } & Record<MonthlyMetric, number>;

export type PracticeUsage = {
  organizationId: string;
  /** Name der Praxis (Geschäftskunde der Plattform) – keine Patientendaten */
  practiceName: string;
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  createdAt: string;
  seatsPaid: number;
  seatsUsed: number;
  activeUsers7d: number;
  activeUsers30d: number;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  customersTotal: number;
  storageBytes: number;
  months: MonthlyUsage[];
  modules: Record<ModuleKey, boolean>;
};

export type PlatformSummary = {
  practices: number;
  byPlan: Record<string, number>;
  byStatus: Record<string, number>;
  trialsEnding14d: number;
  seatsUsed: number;
  seatsPaid: number;
  activeUsers7d: number;
  activeUsers30d: number;
  storageBytes: number;
  months: MonthlyUsage[];
  /** Anzahl Praxen, die das Modul in den letzten ADOPTION_DAYS Tagen genutzt haben */
  adoption: Record<ModuleKey, number>;
};

export type PlatformHealth = { migrations: CheckResult; backup: CheckResult };

export type PlatformUsage = { generatedAt: string; summary: PlatformSummary; practices: PracticeUsage[]; health: PlatformHealth };

/** Die letzten `n` Kalendermonate (Europe/Berlin) als "YYYY-MM", ältester zuerst. */
export function lastMonths(n = USAGE_MONTHS, today = berlinDateIso()): string[] {
  const [y, m] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

const emptyMonth = (month: string): MonthlyUsage => ({ month, ...(Object.fromEntries(MONTHLY_METRIC_KEYS.map((k) => [k, 0])) as Record<MonthlyMetric, number>) });
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Monatswerte einer Praxis – nur count()/sum() je Monat. */
async function monthlyFor(tx: Tx, org: string): Promise<MonthlyUsage[]> {
  const months = lastMonths();
  // Monatsbeginn (Berlin) des ältesten Monats als Zeitpunkt bzw. Datum
  const startLocal = sql`(date_trunc('month', now() at time zone 'Europe/Berlin') - make_interval(months => ${USAGE_MONTHS - 1}))`;
  const since = sql`(${startLocal} at time zone 'Europe/Berlin')`;
  const month = (col: ReturnType<typeof sql.raw>) => sql`to_char(${col} at time zone 'Europe/Berlin', 'YYYY-MM')`;
  const r = await tx.execute<{ k: MonthlyMetric; m: string; n: string | number }>(sql`
    select 'appointments' as k, ${month(sql.raw("starts_at"))} as m, count(*)::float8 as n from appointments
      where organization_id = ${org} and starts_at >= ${since} and status <> 'cancelled' group by 2
    union all
    select 'treatmentRecords', ${month(sql.raw("treated_at"))}, count(*)::float8 from treatment_records
      where organization_id = ${org} and treated_at >= ${since} group by 2
    union all
    select 'invoicesIssued', to_char(issued_at, 'YYYY-MM'), count(*)::float8 from invoices
      where organization_id = ${org} and issued_at >= ${startLocal}::date and status <> 'draft' group by 2
    union all
    select 'revenueCents', to_char(issued_at, 'YYYY-MM'), coalesce(sum(total_cents), 0)::float8 from invoices
      where organization_id = ${org} and issued_at >= ${startLocal}::date and status not in ('draft', 'cancelled')
        and kind not in ('credit_note', 'deposit') and cancels_invoice_id is null group by 2
    union all
    select 'onlineBookings', ${month(sql.raw("created_at"))}, count(*)::float8 from appointments
      where organization_id = ${org} and created_at >= ${since} and source = 'online' group by 2
    union all
    select 'portalBookings', ${month(sql.raw("created_at"))}, count(*)::float8 from appointments
      where organization_id = ${org} and created_at >= ${since} and source = 'portal' group by 2
    union all
    select 'voiceMinutes', ${month(sql.raw("started_at"))}, round(coalesce(sum(duration_sec), 0) / 60.0)::float8 from voice_calls
      where organization_id = ${org} and started_at >= ${since} group by 2
    union all
    select 'emailsSent', ${month(sql.raw("at"))}, count(*)::float8 from sync_log
      where organization_id = ${org} and at >= ${since} and provider = 'email_imap' and direction = 'out' and ok group by 2
    union all
    select 'aiUses', ${month(sql.raw("at"))}, count(*)::float8 from audit_log
      where organization_id = ${org} and at >= ${since} and action like 'ai.%' group by 2
    union all
    select 'ocrUses', ${month(sql.raw("at"))}, count(*)::float8 from audit_log
      where organization_id = ${org} and at >= ${since} and action = 'prescription.ocr' group by 2
  `);
  const byMonth = new Map(months.map((m) => [m, emptyMonth(m)]));
  for (const row of r.rows) {
    const target = byMonth.get(row.m);
    if (target && (MONTHLY_METRIC_KEYS as string[]).includes(row.k)) target[row.k] = num(row.n);
  }
  return months.map((m) => byMonth.get(m)!);
}

type Totals = { customersTotal: number; storageBytes: number; lastActivityAt: string | null; modules: Omit<Record<ModuleKey, boolean>, "website"> };

/** Gesamtzahlen und genutzte Module einer Praxis – nur count()/sum()/max()/exists(). */
async function totalsFor(tx: Tx, org: string): Promise<Totals> {
  const since = sql`(now() - make_interval(days => ${ADOPTION_DAYS}))`;
  const used = (table: string, col: string, extra = "") =>
    sql`exists(select 1 from ${sql.raw(table)} where organization_id = ${org} and ${sql.raw(col)} >= ${since} ${sql.raw(extra)})`;
  const r = await tx.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from patients where organization_id = ${org})::int as customers,
      (select coalesce(sum(size_bytes), 0) from media where organization_id = ${org} and deleted_at is null)::float8 as storage,
      (select max(at) from audit_log where organization_id = ${org}) as last_activity,
      ${used("appointments", "created_at")} as kalender,
      ${used("treatment_records", "created_at")} as doku,
      ${used("media", "taken_at", "and deleted_at is null")} as fotos,
      ${used("invoices", "created_at")} as rechnungen,
      ${used("payments", "paid_at")} as kasse,
      ${used("prescriptions", "created_at")} as verordnungen,
      ${used("appointments", "created_at", "and source = 'online'")} as online_buchung,
      ${used("patient_links", "created_at", "and purpose = 'portal'")} as portal,
      ${used("reminder_log", "at", "and status = 'sent'")} as erinnerungen,
      ${used("sync_log", "at", "and provider = 'email_imap' and direction = 'out' and ok")} as email,
      ${used("voice_calls", "started_at")} as telefon,
      ${used("audit_log", "at", "and action like 'ai.%'")} as ki,
      ${used("audit_log", "at", "and action = 'prescription.ocr'")} as ocr,
      ${used("sterile_batches", "processed_at")} as hygiene,
      ${used("vouchers", "created_at")} as gutscheine
  `);
  const row = r.rows[0] ?? {};
  const b = (k: string) => row[k] === true;
  return {
    customersTotal: num(row.customers),
    storageBytes: num(row.storage),
    lastActivityAt: iso(row.last_activity as string | null),
    modules: {
      kalender: b("kalender"),
      doku: b("doku"),
      fotos: b("fotos"),
      rechnungen: b("rechnungen"),
      kasse: b("kasse"),
      verordnungen: b("verordnungen"),
      onlineBuchung: b("online_buchung"),
      portal: b("portal"),
      erinnerungen: b("erinnerungen"),
      email: b("email"),
      telefon: b("telefon"),
      ki: b("ki"),
      ocr: b("ocr"),
      hygiene: b("hygiene"),
      gutscheine: b("gutscheine"),
    },
  };
}

/** Nutzungsdaten einer Praxis (nur Zahlen/Zeitstempel). */
export async function practiceUsage(organizationId: string): Promise<PracticeUsage | null> {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!o) return null;
  const logins = await loginStats();
  return usageOf(o, logins.get(o.id));
}

type LoginRow = { seatsUsed: number; active7d: number; active30d: number; lastLoginAt: string | null };

/** Aktive Personen (letzte Anmeldung) und belegte Plätze je Praxis – eine Abfrage für alle Praxen. */
async function loginStats(): Promise<Map<string, LoginRow>> {
  const rows = await db
    .select({
      org: memberships.organizationId,
      seatsUsed: sql<number>`count(*) filter (where ${memberships.role} <> 'accountant')::int`,
      active7d: sql<number>`count(*) filter (where ${users.lastLoginAt} >= now() - interval '7 days')::int`,
      active30d: sql<number>`count(*) filter (where ${users.lastLoginAt} >= now() - interval '30 days')::int`,
      lastLoginAt: sql<string | null>`max(${users.lastLoginAt})`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.active, true))
    .groupBy(memberships.organizationId);
  return new Map(rows.map((r) => [r.org, { seatsUsed: num(r.seatsUsed), active7d: num(r.active7d), active30d: num(r.active30d), lastLoginAt: iso(r.lastLoginAt) }]));
}

async function usageOf(o: typeof organizations.$inferSelect, login: LoginRow | undefined): Promise<PracticeUsage> {
  // nacheinander in EINER Transaktion (kein Promise.all auf derselben Verbindung)
  const { months, totals } = await withOrg(o.id, async (tx) => {
    const months = await monthlyFor(tx, o.id);
    const totals = await totalsFor(tx, o.id);
    return { months, totals };
  });
  const website = (o.settings as { website?: { enabled?: boolean } } | null)?.website?.enabled === true;
  return {
    organizationId: o.id,
    practiceName: o.name,
    plan: o.plan,
    subscriptionStatus: o.subscriptionStatus,
    trialEndsAt: iso(o.trialEndsAt),
    createdAt: iso(o.createdAt)!,
    seatsPaid: o.seats,
    seatsUsed: login?.seatsUsed ?? 0,
    activeUsers7d: login?.active7d ?? 0,
    activeUsers30d: login?.active30d ?? 0,
    lastLoginAt: login?.lastLoginAt ?? null,
    lastActivityAt: totals.lastActivityAt,
    customersTotal: totals.customersTotal,
    storageBytes: totals.storageBytes,
    months,
    modules: { ...totals.modules, website },
  };
}

export function summarize(practices: PracticeUsage[], now = new Date()): PlatformSummary {
  const months = lastMonths();
  const sum = months.map(emptyMonth);
  const byPlan: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const adoption = Object.fromEntries(MODULE_KEYS.map((k) => [k, 0])) as Record<ModuleKey, number>;
  let trialsEnding14d = 0;
  for (const p of practices) {
    byPlan[p.plan] = (byPlan[p.plan] ?? 0) + 1;
    byStatus[p.subscriptionStatus] = (byStatus[p.subscriptionStatus] ?? 0) + 1;
    if (p.trialEndsAt && p.subscriptionStatus === "trialing") {
      const left = new Date(p.trialEndsAt).getTime() - now.getTime();
      if (left > 0 && left <= 14 * 86_400_000) trialsEnding14d++;
    }
    for (const k of MODULE_KEYS) if (p.modules[k]) adoption[k]++;
    p.months.forEach((m, i) => {
      const target = sum[months.indexOf(m.month)] ?? sum[i];
      for (const k of MONTHLY_METRIC_KEYS) target[k] += m[k];
    });
  }
  return {
    practices: practices.length,
    byPlan,
    byStatus,
    trialsEnding14d,
    seatsUsed: practices.reduce((s, p) => s + p.seatsUsed, 0),
    seatsPaid: practices.reduce((s, p) => s + p.seatsPaid, 0),
    activeUsers7d: practices.reduce((s, p) => s + p.activeUsers7d, 0),
    activeUsers30d: practices.reduce((s, p) => s + p.activeUsers30d, 0),
    storageBytes: practices.reduce((s, p) => s + p.storageBytes, 0),
    months: sum,
    adoption,
  };
}

/** Nutzungsdaten aller Praxen + Plattform-Kennzahlen + Betriebszustand. */
export async function platformUsage(limit = 500): Promise<PlatformUsage> {
  const orgs = await db.select().from(organizations).orderBy(desc(organizations.createdAt)).limit(limit);
  const logins = await loginStats();
  const practices: PracticeUsage[] = [];
  for (const o of orgs) practices.push(await usageOf(o, logins.get(o.id)));
  const [migrations, stamps] = [await checkMigrations(), await checkTimestamps()];
  return { generatedAt: new Date().toISOString(), summary: summarize(practices), practices, health: { migrations, backup: stamps.backup } };
}
