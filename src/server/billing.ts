import "server-only";
import { and, count, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { db, withOrg, type Db, type Tx } from "@/db";
import { auditLog, billingEvents, memberships, organizations } from "@/db/schema";
import { billingUpdateFromEvent, type OrgBillingPatch } from "@/integrations/stripe/events";
import { priceIdsFromEnv, type PriceIds } from "@/integrations/stripe/stripe";
import type { StripeEvent } from "@/integrations/stripe/types";
import { freeSwitchProblem, SEAT_FREE_ROLES } from "@/lib/plans";
import { countedPatients } from "./patient-limit";

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
      .values({ provider: "stripe", externalId: ev.id, type: ev.type, payload: minimalPayload(ev) })
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
    if ((ev.type.startsWith("customer.subscription.") || ev.type.startsWith("invoice.")) && ev.created < last) {
      return done("ignored", org.id, "veraltetes Event");
    }

    // Kostenlos-Tarif: Events eines alten (gekündigten) Abos ändern nichts. Erst ein neues, aktives Abo (Checkout)
    // stellt den Tarif um.
    if (org.plan === "free" && !upd.patch.plan && ev.type !== "checkout.session.completed") {
      return done("ignored", org.id, "Kostenlos-Tarif: Event ohne neues Abo");
    }
    if (org.plan === "free" && ev.type.startsWith("customer.subscription.") && !["active", "trialing"].includes(upd.patch.subscriptionStatus ?? "")) {
      return done("ignored", org.id, "Kostenlos-Tarif: altes Abo");
    }
    await applyPatch(tx, org.id, upd.patch, Math.max(last, ev.created));
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
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1).for("update");
    if (o) return o;
  }
  if (customerId) {
    const [o] = await tx.select().from(organizations).where(eq(organizations.stripeCustomerId, customerId)).limit(1).for("update");
    if (o) return o;
  }
  return null;
}

/** Nur die Abo-Felder setzen; settings wird per jsonb-Merge ergänzt (keine parallelen Einstellungsänderungen überschreiben). */
async function applyPatch(tx: Tx, organizationId: string, patch: OrgBillingPatch, lastEventAt?: number) {
  await tx
    .update(organizations)
    .set({
      ...patch,
      ...(lastEventAt !== undefined
        ? { settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('billingLastEventAt', ${lastEventAt}::bigint)` }
        : {}),
    })
    .where(eq(organizations.id, organizationId));
}

/** Datensparsam: keine Namen/E-Mails/Adressen der Stripe-Kunden plattformweit speichern (billing_events hat kein RLS). */
function minimalPayload(ev: StripeEvent) {
  const o = (ev.data?.object ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);
  return {
    id: ev.id,
    type: ev.type,
    created: ev.created,
    object: { id: id(o.id), object: o.object ?? null, customer: id(o.customer), subscription: id(o.subscription), status: o.status ?? null, payment_status: o.payment_status ?? null },
  };
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

/**
 * Belegte Plätze (wie seatCounts in src/lib/plans.ts): aktive Mitgliedschaften außer Empfang und Steuerberatung
 * (SEAT_FREE_ROLES; Azubis zählen). Im Kostenlos-Tarif („1 Person“) zählt jede aktive Person außer der
 * Steuerberatung. Der Tarif wird in derselben Abfrage gelesen.
 */
/** SQL-Bedingung „belegt einen Platz“ (braucht memberships und organizations in der Abfrage) – entspricht seatCounts */
export const seatCountsSql = or(notInArray(memberships.role, [...SEAT_FREE_ROLES]), and(eq(organizations.plan, "free"), ne(memberships.role, "accountant")))!;

export async function usedSeats(organizationId: string, exec: Db | Tx = db): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.active, true),
        seatCountsSql,
      ),
    );
  return Number(r?.n ?? 0);
}

/** Aktive Teammitglieder ohne Steuerberatung (inkl. Empfang) – z. B. für den Wechsel in den Kostenlos-Tarif */
export async function activeTeamMembers(organizationId: string, exec: Db | Tx = db): Promise<number> {
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
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return o ?? null;
}

/**
 * Wechsel in den kostenlosen Tarif (höchstens 20 Patient:innen, 1 Person). Nur ohne laufendes Stripe-Abo.
 * Sperren in fester Reihenfolge „seats:“ → „pnum:“ (wie Team-Änderungen bzw. Patienten-Neuanlagen), damit parallel
 * weder Personen noch Patient:innen dazukommen. Weitere Teammitglieder (außer Steuerberatung) werden deaktiviert – bewusst auch der Empfang, obwohl er in
 * bezahlten Tarifen keinen Platz belegt: Der Kostenlos-Tarif ist auf „1 Person“ begrenzt (seatCounts mit plan "free").
 * Die alte Abo-ID wird gelöst und der Event-Stand auf jetzt gesetzt: verspätete Stripe-Events des alten Abos
 * überschreiben den Tarif nicht mehr (siehe processBillingEvent).
 */
export async function switchToFreePlan(organizationId: string, userId: string): Promise<{ error: string } | { ok: true; deactivated: string[] }> {
  const res = await withOrg(organizationId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${organizationId}`}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"pnum:" + organizationId}))`);
    const [o] = await tx
      .select({
        plan: organizations.plan,
        subscriptionStatus: organizations.subscriptionStatus,
        trialEndsAt: organizations.trialEndsAt,
        currentPeriodEnd: organizations.currentPeriodEnd,
        seats: organizations.seats,
        stripeSubscriptionId: organizations.stripeSubscriptionId,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");
    if (!o) return { error: "Praxis nicht gefunden." };
    const problem = freeSwitchProblem(o, await countedPatients(tx, organizationId));
    if (problem) return { error: problem };
    const off = await tx
      .update(memberships)
      .set({ active: false })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), ne(memberships.userId, userId), ne(memberships.role, "accountant")))
      .returning({ userId: memberships.userId });
    const nowSec = Math.floor(Date.now() / 1000);
    await tx
      .update(organizations)
      .set({
        plan: "free",
        seats: 1,
        subscriptionStatus: "none",
        stripeSubscriptionId: null,
        settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('billingLastEventAt', greatest(coalesce((${organizations.settings}->>'billingLastEventAt')::bigint, 0), ${nowSec}::bigint))`,
      })
      .where(eq(organizations.id, organizationId));
    await tx.insert(auditLog).values({
      organizationId,
      userId,
      action: "billing.switch_free",
      meta: { from: o.plan, status: o.subscriptionStatus, deactivatedMembers: off.length },
    });
    return { ok: true as const, deactivated: off.map((m) => m.userId) };
  });
  return res;
}
