import "server-only";
import { and, count, eq, ne } from "drizzle-orm";
import { db, type Db, type Tx } from "@/db";
import { auditLog, billingEvents, memberships, organizations } from "@/db/schema";
import { billingUpdateFromEvent, type OrgBillingPatch } from "@/integrations/stripe/events";
import { priceIdsFromEnv, type PriceIds } from "@/integrations/stripe/stripe";
import type { StripeEvent } from "@/integrations/stripe/types";

export type BillingResult = "processed" | "duplicate" | "ignored" | "unassigned";

/**
 * Verarbeitet ein (bereits signaturgeprüftes) Stripe-Event genau einmal:
 * billing_events (provider, external_id) ist eindeutig; die Zeile wird in derselben Transaktion gesperrt,
 * in der die Praxis aktualisiert wird. Parallele Zustellungen warten aufeinander und erkennen das Duplikat.
 * Wirft ein Fehler, rollt alles zurück → Stripe stellt erneut zu.
 */
export async function processBillingEvent(ev: StripeEvent, opts: { prices?: PriceIds } = {}): Promise<BillingResult> {
  const prices = opts.prices ?? priceIdsFromEnv();
  return db.transaction(async (tx) => {
    await tx
      .insert(billingEvents)
      .values({ provider: "stripe", externalId: ev.id, type: ev.type, payload: ev })
      .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.externalId] });
    const [row] = await tx
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.provider, "stripe"), eq(billingEvents.externalId, ev.id)))
      .for("update");
    if (row.processedAt) return "duplicate";

    const done = async (result: BillingResult, organizationId: string | null, error?: string) => {
      await tx.update(billingEvents).set({ processedAt: new Date(), organizationId, error: error ?? null }).where(eq(billingEvents.id, row.id));
      return result;
    };

    const upd = billingUpdateFromEvent(ev, prices);
    if (!upd) return done("ignored", null);
    const org = await findOrg(tx, upd.organizationId, upd.customerId);
    if (!org) return done("unassigned", null, "Keine Praxis zuordenbar");
    // Ein Stripe-Kunde gehört genau einer Praxis: abweichende Kunden-ID nie übernehmen
    if (org.stripeCustomerId && upd.customerId && org.stripeCustomerId !== upd.customerId) {
      return done("unassigned", org.id, "Stripe-Kunde passt nicht zur Praxis");
    }
    // Reihenfolge: ältere Abo-Events überschreiben keine neueren
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    const last = typeof settings.billingLastEventAt === "number" ? settings.billingLastEventAt : 0;
    if (ev.type.startsWith("customer.subscription.") && ev.created < last) return done("ignored", org.id, "veraltetes Event");

    await applyPatch(tx, org.id, upd.patch, { ...settings, billingLastEventAt: Math.max(last, ev.created) });
    await tx.insert(auditLog).values({
      organizationId: org.id,
      action: "billing.event",
      entity: "billing_event",
      entityId: ev.id,
      meta: { type: ev.type, plan: upd.patch.plan, status: upd.patch.subscriptionStatus, seats: upd.patch.seats },
    });
    return done("processed", org.id);
  });
}

async function findOrg(tx: Tx, organizationId: string | null, customerId: string | null) {
  if (organizationId) {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    if (o) return o;
  }
  if (customerId) {
    const [o] = await tx.select().from(organizations).where(eq(organizations.stripeCustomerId, customerId)).limit(1);
    if (o) return o;
  }
  return null;
}

async function applyPatch(tx: Tx, organizationId: string, patch: OrgBillingPatch, settings?: Record<string, unknown>) {
  await tx
    .update(organizations)
    .set({ ...patch, ...(settings ? { settings } : {}) })
    .where(eq(organizations.id, organizationId));
}

/** Nur Mock/Entwicklung: Tarif sofort umstellen (ohne Stripe). */
export async function applyMockSubscription(organizationId: string, userId: string, plan: OrgBillingPatch["plan"], seats: number) {
  if (process.env.NODE_ENV === "production") throw new Error("Mock-Abrechnung ist in Produktion deaktiviert.");
  await db.transaction(async (tx) => {
    await applyPatch(tx, organizationId, {
      plan,
      seats,
      subscriptionStatus: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await tx.insert(auditLog).values({ organizationId, userId, action: "billing.mock_switch", meta: { plan, seats } });
  });
}

/** Belegte Plätze: aktive Mitgliedschaften ohne Steuerberatung */
export async function usedSeats(organizationId: string, exec: Db | Tx = db): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), ne(memberships.role, "accountant")));
  return Number(r?.n ?? 0);
}

/** Abo-Felder für Entitlement-Prüfungen (aktueller DB-Stand) */
export async function loadOrgBilling(organizationId: string) {
  const [o] = await db
    .select({
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      trialEndsAt: organizations.trialEndsAt,
      currentPeriodEnd: organizations.currentPeriodEnd,
      seats: organizations.seats,
      stripeCustomerId: organizations.stripeCustomerId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return o ?? null;
}
