import "server-only";
import { notFound } from "next/navigation";
import { and, count, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, auditLog, memberships, organizations, patients, supportGrants, users } from "@/db/schema";
import { getSession, requestMeta } from "@/lib/auth/session";
import { isPlanId, PLANS, seatCounts, voiceAddonActive, type PlanId } from "@/lib/plans";
import { websiteAddonActive } from "@/lib/website";
import { isDemoPractice } from "@/lib/demo-practice";

/**
 * Plattform-Konsole (SaaS-Betreiber). Zugang NUR für users.is_platform_admin MIT aktiver 2FA – sonst 404.
 * Kein Zugriff auf Patientendaten: nur Praxis-Stammdaten, Abo-Felder und anonyme Zählwerte.
 */
export async function requirePlatformAdmin() {
  const row = await getSession();
  if (!row || !row.session.verified || !row.user.isPlatformAdmin || !row.user.totpEnabled) notFound();
  return row;
}

export type PracticeOverview = {
  id: string;
  name: string;
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  seats: number;
  usedSeats: number;
  createdAt: Date;
  patients: number;
  appointments30d: number;
  activeGrantForMe: boolean;
  /** KI-Telefon als Zusatzmodul gebucht (organizations.settings.voiceAddon) */
  voiceAddon: boolean;
  /** Praxis-Website als Zusatzmodul gebucht (organizations.settings.websiteAddon) */
  websiteAddon: boolean;
  /** Demo-Praxis mit erfundenen Daten (organizations.settings.demo, Bootstrap) */
  demo: boolean;
  /** Praxis-Inhaber:innen (Konto, kein Patientendatum) – für „Passwort-Reset senden“ */
  owners: { id: string; name: string; email: string }[];
};

/**
 * Übersicht aller Praxen. Zählwerte aus RLS-Tabellen werden je Praxis in withOrg() ermittelt
 * (die App-Rolle sieht nie mandantenübergreifend) – es werden nur Anzahlen gelesen, keine Inhalte.
 */
export async function listPractices(adminUserId: string): Promise<PracticeOverview[]> {
  const orgs = await db.select().from(organizations).orderBy(desc(organizations.createdAt)).limit(500);
  const seatRows = await db
    .select({ org: memberships.organizationId, role: memberships.role, n: count() })
    .from(memberships)
    .where(eq(memberships.active, true))
    .groupBy(memberships.organizationId, memberships.role);
  const ownerRows = await db
    .select({ org: memberships.organizationId, id: users.id, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.active, true), eq(memberships.role, "owner")));
  const since = new Date(Date.now() - 30 * 86_400_000);
  const now = new Date();
  const out: PracticeOverview[] = [];
  for (const o of orgs) {
    const c = await withOrg(o.id, async (tx) => {
      const [p] = await tx.select({ n: count() }).from(patients).where(eq(patients.organizationId, o.id));
      const [a] = await tx.select({ n: count() }).from(appointments).where(and(eq(appointments.organizationId, o.id), gte(appointments.startsAt, since)));
      const grants = await tx
        .select({ grantee: supportGrants.granteeUserId })
        .from(supportGrants)
        .where(and(eq(supportGrants.organizationId, o.id), isNull(supportGrants.revokedAt), gt(supportGrants.expiresAt, now)));
      return { patients: Number(p?.n ?? 0), appointments30d: Number(a?.n ?? 0), grant: grants.some((g) => g.grantee === null || g.grantee === adminUserId) };
    });
    out.push({
      id: o.id,
      name: o.name,
      plan: o.plan,
      subscriptionStatus: o.subscriptionStatus,
      trialEndsAt: o.trialEndsAt,
      currentPeriodEnd: o.currentPeriodEnd,
      seats: o.seats,
      usedSeats: seatRows.filter((r) => r.org === o.id && seatCounts(r.role, o.plan)).reduce((s, r) => s + Number(r.n), 0),
      createdAt: o.createdAt,
      patients: c.patients,
      appointments30d: c.appointments30d,
      activeGrantForMe: c.grant,
      voiceAddon: voiceAddonActive(o.settings),
      websiteAddon: websiteAddonActive(o.settings),
      demo: isDemoPractice(o.settings),
      owners: ownerRows.filter((r) => r.org === o.id).map(({ id, name, email }) => ({ id, name, email })),
    });
  }
  return out;
}

async function platformAudit(organizationId: string, userId: string, action: string, meta: Record<string, unknown>) {
  const { ip } = await requestMeta().catch(() => ({ ip: null }));
  await db.insert(auditLog).values({ organizationId, userId, action, entity: "organization", entityId: organizationId, meta, ip });
}

export async function setPracticePlan(adminUserId: string, organizationId: string, plan: PlanId, seats: number) {
  if (!isPlanId(plan)) throw new Error("Tarif ungültig");
  const info = PLANS[plan];
  const s = Math.max(1, Math.min(seats, info.maxSeats ?? 999));
  const [before] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!before) throw new Error("Praxis nicht gefunden");
  // Kostenlos: kein Abo (sonst blockiert „aktiv“ später den Checkout für ein Upgrade)
  const status = plan === "trial" ? "trialing" : plan === "free" ? "none" : "active";
  await db.update(organizations).set({ plan, seats: s, subscriptionStatus: status }).where(eq(organizations.id, organizationId));
  await platformAudit(organizationId, adminUserId, "platform.plan_changed", {
    from: { plan: before.plan, seats: before.seats, status: before.subscriptionStatus },
    to: { plan, seats: s, status },
  });
}

export async function extendTrial(adminUserId: string, organizationId: string, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("1 bis 90 Tage");
  const [o] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!o) throw new Error("Praxis nicht gefunden");
  const base = Math.max(Date.now(), o.trialEndsAt?.getTime() ?? 0);
  const trialEndsAt = new Date(base + days * 86_400_000);
  await db.update(organizations).set({ trialEndsAt, plan: "trial", subscriptionStatus: "trialing" }).where(eq(organizations.id, organizationId));
  await platformAudit(organizationId, adminUserId, "platform.trial_extended", { days, from: o.trialEndsAt?.toISOString() ?? null, to: trialEndsAt.toISOString() });
}

/** Zusatzmodul KI-Telefon an-/abschalten (bis zur Stripe-Anbindung manuell durch den Betreiber). */
export async function setVoiceAddon(adminUserId: string, organizationId: string, on: boolean) {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  if (!o) throw new Error("Praxis nicht gefunden");
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('voiceAddon', ${on}::boolean)` })
    .where(eq(organizations.id, organizationId));
  await platformAudit(organizationId, adminUserId, "platform.voice_addon", { from: voiceAddonActive(o.settings), to: on });
}

/** Zusatzmodul Praxis-Website an-/abschalten (Starter; bis zur Stripe-Anbindung manuell durch den Betreiber). */
export async function setWebsiteAddon(adminUserId: string, organizationId: string, on: boolean) {
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, organizationId));
  if (!o) throw new Error("Praxis nicht gefunden");
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('websiteAddon', ${on}::boolean)` })
    .where(eq(organizations.id, organizationId));
  await platformAudit(organizationId, adminUserId, "platform.website_addon", { from: websiteAddonActive(o.settings), to: on });
}
