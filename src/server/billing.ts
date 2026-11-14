import "server-only";
import { and, count, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { db, withOrg, type Db, type Tx } from "@/db";
import { auditLog, billingEvents, memberships, organizations, promoRedemptions } from "@/db/schema";
import { billingUpdateFromEvent, type OrgBillingPatch } from "@/integrations/stripe/events";
import { priceIdsFromEnv, type PriceIds } from "@/integrations/stripe/stripe";
import type { StripeEvent } from "@/integrations/stripe/types";
import { freeSwitchProblem, SEAT_FREE_ROLES } from "@/lib/plans";
import { readonlyExpiry } from "@/lib/readonly-expiry";
import { hasRunningSubscription } from "@/lib/subscription-cancel";
import { countedPatients } from "./patient-limit";
import { stopAutoDeletion } from "./readonly-expiry";

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
    // Testphase per Aktionscode (kein aktuelles Stripe-Abo): Events eines alten (beendeten) Abos ändern nichts –
    // weder Rechnungs-Events noch Abo-Events, die kein neues aktives Abo melden (sonst fiele die Praxis z. B. auf „past_due“).
    const codeTrial = org.subscriptionStatus === "trialing" && !org.stripeSubscriptionId;
    // Rechnungs-Events nur zum aktuellen Abo: fremde/alte Abo-ID → ignorieren; ohne Abo-ID nur, wenn die Praxis gar kein
    // Abo hat (Code-Testphase) – dann kann die Rechnung zu keinem laufenden Abo gehören.
    if (ev.type.startsWith("invoice.")) {
      const invSub = invoiceSubscriptionId(ev);
      if (invSub ? invSub !== org.stripeSubscriptionId : codeTrial) return done("ignored", org.id, "Rechnung eines alten/fremden Abos");
    }
    if (codeTrial && ev.type.startsWith("customer.subscription.") && !["active", "trialing"].includes(upd.patch.subscriptionStatus ?? "")) {
      return done("ignored", org.id, "Aktionscode-Testphase: altes Abo");
    }
    // Abo-Event eines WEITEREN Abos desselben Kunden (z. B. doppelt abgeschlossen, altes Abo endet): die Zuordnung der
    // Praxis nicht stumpf überschreiben. Übernommen wird ein anderes Abo nur, wenn es aktiv ist und die Praxis kein
    // laufendes Abo mehr hat (z. B. neu abgeschlossen nach Ende des alten).
    const evSub = upd.patch.stripeSubscriptionId;
    if (ev.type.startsWith("customer.subscription.") && evSub && org.stripeSubscriptionId && evSub !== org.stripeSubscriptionId) {
      const newRunning = ["active", "trialing"].includes(upd.patch.subscriptionStatus ?? "");
      if (hasRunningSubscription(org) || !newRunning) return done("ignored", org.id, "Event eines weiteren Abos – Zuordnung unverändert");
    }
    await applyPatch(tx, org.id, upd.patch, Math.max(last, ev.created), {
      cancelAtPeriodEnd: upd.cancelAtPeriodEnd,
      // Abo beendet oder neues Abo abgeschlossen: Herkunft und Fehlermerker einer früheren Kündigung entfallen
      reset: ev.type === "customer.subscription.deleted" || ev.type === "checkout.session.completed",
    });
    await tx.insert(auditLog).values({
      organizationId: org.id,
      action: "billing.event",
      entity: "billing_event",
      entityId: ev.id,
      meta: { type: ev.type, plan: upd.patch.plan, status: upd.patch.subscriptionStatus, seats: upd.patch.seats, cancelAtPeriodEnd: upd.cancelAtPeriodEnd },
    });
    // Tarif gebucht bzw. Abo wieder aktiv: automatische Löschung nach Ende des Nur-Lesen-Modus entfällt
    if (!readonlyExpiry({ ...org, ...upd.patch })) await stopAutoDeletion(tx, org.id, { trigger: `billing:${ev.type}` });
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

/** Abo-ID einer Rechnung (ältere API: invoice.subscription, neuere: invoice.parent.subscription_details.subscription) */
function invoiceSubscriptionId(ev: StripeEvent): string | null {
  const o = (ev.data?.object ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && v ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);
  const parent = (o.parent ?? {}) as { subscription_details?: { subscription?: unknown } };
  return id(o.subscription) ?? id(parent.subscription_details?.subscription);
}

/**
 * Nur die Abo-Felder setzen; settings wird per jsonb-Merge ergänzt (keine parallelen Einstellungsänderungen überschreiben).
 * Kündigung zum Periodenende (src/lib/subscription-cancel.ts): Stripe meldet den Zustand, die Herkunft
 * (billingCancelReason) setzt nur PodoHero. Wird die Kündigung aufgehoben (z. B. im Kundenportal fortgesetzt) oder
 * endet das Abo, entfällt die Herkunft – eine spätere erneute Kündigung im Portal gilt dann NICHT als Löschantrag.
 */
async function applyPatch(
  tx: Tx,
  organizationId: string,
  patch: OrgBillingPatch,
  lastEventAt?: number,
  cancel: { cancelAtPeriodEnd?: boolean; reset?: boolean } = {},
) {
  let settings = sql`coalesce(${organizations.settings}, '{}'::jsonb)`;
  if (cancel.reset) settings = sql`(${settings} - 'billingCancelReason' - 'billingCancelMarks' - 'billingCancelError')`;
  else if (cancel.cancelAtPeriodEnd === false) settings = sql`(${settings} - 'billingCancelReason' - 'billingCancelMarks')`;
  if (cancel.cancelAtPeriodEnd !== undefined) settings = sql`${settings} || jsonb_build_object('billingCancelAtPeriodEnd', ${cancel.cancelAtPeriodEnd}::boolean)`;
  if (lastEventAt !== undefined) settings = sql`${settings} || jsonb_build_object('billingLastEventAt', ${lastEventAt}::bigint)`;
  const touchesSettings = lastEventAt !== undefined || cancel.cancelAtPeriodEnd !== undefined || cancel.reset;
  await tx
    .update(organizations)
    .set({ ...patch, ...(touchesSettings ? { settings } : {}) })
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
      // Pseudo-Abo-ID: „Abo kündigen“ und die Kündigung per Löschantrag laufen im Testmodus gegen StripeMock
      stripeSubscriptionId: `sub_mock_${organizationId.replace(/-/g, "").slice(0, 12)}`,
    }, undefined, { cancelAtPeriodEnd: false, reset: true });
    await tx.insert(auditLog).values({ organizationId, userId, action: "billing.mock_switch", meta: { plan, seats } });
    await stopAutoDeletion(tx, organizationId, { trigger: "billing.mock_switch", userId });
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
      settings: organizations.settings,
      deletionRequestedAt: organizations.deletionRequestedAt,
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
  return withOrg(organizationId, (tx) => freeSwitchTx(tx, organizationId, userId, { auditUserId: userId, action: "billing.switch_free" }));
}

/**
 * Wechsel in den Kostenlos-Tarif in einer Transaktion mit gesetztem app.org_id: prüft freeSwitchProblem (u. a. höchstens
 * 20 Patient:innen), deaktiviert alle weiteren Personen außer `keepUserId` und der Steuerberatung, schreibt das Audit.
 * `check` = zusätzliche Bedingung auf der gesperrten Praxis-Zeile (z. B. „Aktionscode-Testphase abgelaufen“).
 */
async function freeSwitchTx(
  tx: Tx,
  organizationId: string,
  keepUserId: string,
  opts: { auditUserId: string | null; action: string; meta?: Record<string, unknown>; check?: (o: { plan: string; subscriptionStatus: string; trialEndsAt: Date | null; stripeSubscriptionId: string | null; settings: Record<string, unknown> }) => string | null },
): Promise<{ error: string } | { ok: true; deactivated: string[] }> {
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
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!o) return { error: "Praxis nicht gefunden." };
  const pre = opts.check?.({ ...o, settings: (o.settings ?? {}) as Record<string, unknown> });
  if (pre) return { error: pre };
  const problem = freeSwitchProblem(o, await countedPatients(tx, organizationId));
  if (problem) return { error: problem };
  const off = await tx
    .update(memberships)
    .set({ active: false })
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), ne(memberships.userId, keepUserId), ne(memberships.role, "accountant")))
    .returning({ userId: memberships.userId });
  const nowSec = Math.floor(Date.now() / 1000);
  await tx
    .update(organizations)
    .set({
      plan: "free",
      seats: 1,
      subscriptionStatus: "none",
      stripeSubscriptionId: null,
      settings: sql`(coalesce(${organizations.settings}, '{}'::jsonb) - 'promoReturnFree') || jsonb_build_object('billingLastEventAt', greatest(coalesce((${organizations.settings}->>'billingLastEventAt')::bigint, 0), ${nowSec}::bigint))`,
    })
    .where(eq(organizations.id, organizationId));
  await tx.insert(auditLog).values({
    organizationId,
    userId: opts.auditUserId,
    action: opts.action,
    meta: { from: o.plan, status: o.subscriptionStatus, deactivatedMembers: off.length, ...opts.meta },
  });
  // Kostenlos-Tarif beendet den Nur-Lesen-Modus: automatische Löschung entfällt
  await stopAutoDeletion(tx, organizationId, { trigger: opts.action, userId: opts.auditUserId });
  return { ok: true as const, deactivated: off.map((m) => m.userId) };
}

/** Praxis hat einen Aktionscode im Kostenlos-Tarif eingelöst (Merker beim Einlösen, src/server/promo-codes.ts) */
export const promoReturnFreePending = (settings: Record<string, unknown> | null | undefined) => settings?.promoReturnFree === true;

/**
 * Nach Ablauf einer Aktionscode-Testphase, die im Kostenlos-Tarif begonnen wurde: automatisch zurück in den
 * Kostenlos-Tarif (AGB § 3 Abs. 4), wenn die Bedingungen erfüllt sind (höchstens 20 Patient:innen, kein Stripe-Abo).
 * Weitere Personen werden deaktiviert; es bleibt die einlösende Inhaber:in (bzw. die am längsten aktive Inhaber:in).
 * Sonst bleibt die Praxis wie bisher nur lesbar und der Merker wird entfernt (kein erneuter Versuch je Anfrage).
 * Aufruf: nächtlicher Cron (runPromoTrialReturns in src/server/promo-codes.ts, /api/cron/lead-search). Bis dahin kann
 * die Inhaber:in sofort „Kostenlos weiter nutzen“ wählen (Abo-Seite, auch im Nur-Lesen-Modus).
 */
export async function returnPromoTrialToFree(organizationId: string, now = new Date()): Promise<{ status: "switched" | "kept" | "not_due"; deactivated: string[] }> {
  return withOrg(organizationId, async (tx) => {
    const [cur] = await tx
      .select({ subscriptionStatus: organizations.subscriptionStatus, trialEndsAt: organizations.trialEndsAt, stripeSubscriptionId: organizations.stripeSubscriptionId, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const isDue = (o: { subscriptionStatus: string; trialEndsAt: Date | null; stripeSubscriptionId: string | null; settings: Record<string, unknown> | null }) =>
      promoReturnFreePending(o.settings) && o.subscriptionStatus === "trialing" && !o.stripeSubscriptionId && !!o.trialEndsAt && o.trialEndsAt.getTime() <= now.getTime();
    if (!cur || !isDue(cur)) return { status: "not_due" as const, deactivated: [] };
    const owners = await tx
      .select({ userId: memberships.userId, createdAt: memberships.createdAt })
      .from(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.active, true), eq(memberships.role, "owner")))
      .orderBy(memberships.createdAt);
    const [red] = await tx.select({ by: promoRedemptions.redeemedBy }).from(promoRedemptions).where(eq(promoRedemptions.organizationId, organizationId));
    const keep = owners.find((o) => o.userId === red?.by)?.userId ?? owners[0]?.userId;
    let notDue = false;
    // erneut unter der Zeilensperre prüfen (parallele Anfragen)
    const due = (o: { subscriptionStatus: string; trialEndsAt: Date | null; stripeSubscriptionId: string | null; settings: Record<string, unknown> }) => {
      notDue = !isDue(o);
      return notDue ? "nicht fällig" : null;
    };
    const r = keep ? await freeSwitchTx(tx, organizationId, keep, { auditUserId: null, action: "promo.return_free", check: due }) : { error: "keine aktive Inhaber:in" };
    if ("ok" in r) return { status: "switched" as const, deactivated: r.deactivated };
    if (notDue) return { status: "not_due" as const, deactivated: [] };
    // Bedingungen nicht erfüllt (z. B. mehr als 20 Patient:innen): Merker entfernen, Praxis bleibt nur lesbar
    await tx
      .update(organizations)
      .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) - 'promoReturnFree'` })
      .where(eq(organizations.id, organizationId));
    await tx.insert(auditLog).values({ organizationId, userId: null, action: "promo.return_free_skipped", meta: { reason: r.error.slice(0, 200) } });
    return { status: "kept" as const, deactivated: [] };
  });
}
