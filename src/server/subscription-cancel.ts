import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { messages, organizations } from "@/db/schema";
import { BillingHttpError, BillingNotConfiguredError, getBillingPort, type BillingPort } from "@/integrations/stripe";
import { audit } from "@/lib/audit";
import { CANCEL_FAILED_MESSAGE, cancelStateFromSettings, hasRunningSubscription, STRIPE_LIVE_STATUSES, type CancelReason } from "@/lib/subscription-cancel";

/**
 * Kündigung des Stripe-Abos zum Periodenende und deren Rücknahme (Zustand: src/lib/subscription-cancel.ts).
 * Stripe ist die Quelle der Wahrheit: vor jeder Änderung wird das Abo frisch gelesen. Eine Kündigung, die nicht von
 * PodoHero stammt (z. B. über das Stripe-Kundenportal), bekommt keine Herkunft und wird bei der Rücknahme des
 * Löschantrags nicht angetastet. Fehler werfen nicht – sie werden protokolliert und als „failed“ gemeldet.
 */

export type CancelOutcome =
  | { status: "no_subscription" }
  /** war schon gekündigt (z. B. über das Kundenportal) – nichts geändert */
  | { status: "already_canceled"; periodEnd: Date | null }
  | { status: "canceled"; periodEnd: Date | null }
  | { status: "failed" };

export type ResumeOutcome =
  | { status: "no_subscription" }
  | { status: "not_canceled" }
  /** gekündigt, aber nicht aus der verlangten Herkunft (z. B. separat über das Kundenportal) – bleibt bestehen */
  | { status: "kept"; periodEnd: Date | null }
  | { status: "resumed"; periodEnd: Date | null }
  | { status: "failed" };

async function loadOrg(organizationId: string) {
  const [o] = await db
    .select({
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
      currentPeriodEnd: organizations.currentPeriodEnd,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return o ?? null;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Lokalen Stand nach einem erfolgreichen Stripe-Aufruf schreiben. billingLastEventAt wird auf jetzt angehoben:
 * ältere, verspätet zugestellte Abo-Events überschreiben die eben gesetzte Kündigung nicht (processBillingEvent).
 * `reason: undefined` = Herkunft unverändert lassen.
 */
async function writeCancelState(organizationId: string, s: { cancelAtPeriodEnd: boolean; reason?: CancelReason | null; periodEnd?: Date }) {
  const reasonSql =
    s.reason === undefined
      ? sql``
      : s.reason === null
        ? sql` - 'billingCancelReason'`
        : sql` || jsonb_build_object('billingCancelReason', ${s.reason}::text)`;
  await db
    .update(organizations)
    .set({
      ...(s.periodEnd ? { currentPeriodEnd: s.periodEnd } : {}),
      settings: sql`((coalesce(${organizations.settings}, '{}'::jsonb) - 'billingCancelError')${reasonSql}) || jsonb_build_object('billingCancelAtPeriodEnd', ${s.cancelAtPeriodEnd}::boolean, 'billingLastEventAt', greatest(coalesce((${organizations.settings}->>'billingLastEventAt')::bigint, 0), ${nowSec()}::bigint))`,
    })
    .where(eq(organizations.id, organizationId));
}

async function markCancelError(organizationId: string, trigger: CancelReason | "resume") {
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('billingCancelError', jsonb_build_object('at', ${new Date().toISOString()}::text, 'trigger', ${trigger}::text))` })
    .where(eq(organizations.id, organizationId));
}

async function clearCancelError(organizationId: string) {
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) - 'billingCancelError'` })
    .where(eq(organizations.id, organizationId));
}

/** Fehlerbeschreibung ohne Antworttext von Stripe (kann Kundendaten enthalten) */
const errorKind = (e: unknown) => (e instanceof BillingHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.name : "Fehler");

/** Hinweis im Posteingang der Praxis (ohne Patientenbezug) */
async function inboxNotice(organizationId: string, subject: string, body: string) {
  await withOrg(organizationId, (tx) =>
    tx.insert(messages).values({ organizationId, patientId: null, channel: "none", direction: "inbound", fromAddress: "PodoHero", subject, body, status: "new", threadKey: "podohero-abo" }),
  );
}

/** Echte Abo-IDs nie gegen den Mock „kündigen“ (fehlender STRIPE_SECRET_KEY darf keinen Erfolg vortäuschen) */
function assertRealPort(port: BillingPort, subId: string) {
  if (port.isMock && !subId.startsWith("sub_mock_")) throw new BillingNotConfiguredError("STRIPE_SECRET_KEY fehlt.");
}

const live = (status: string) => (STRIPE_LIVE_STATUSES as readonly string[]).includes(status);

/** Abo zum Ende des Abrechnungszeitraums kündigen (Löschantrag oder „Abo kündigen“). */
export async function cancelSubscriptionAtPeriodEnd(
  organizationId: string,
  userId: string | null,
  reason: CancelReason,
  port: BillingPort = getBillingPort(),
): Promise<CancelOutcome> {
  const org = await loadOrg(organizationId);
  if (!org || !hasRunningSubscription(org)) return { status: "no_subscription" };
  const subId = org.stripeSubscriptionId!;
  try {
    assertRealPort(port, subId);
    const sub = await port.getSubscription(subId);
    if (!sub || !live(sub.status)) return { status: "no_subscription" };
    if (sub.cancelAtPeriodEnd) {
      // bereits gekündigt (Kundenportal oder früher): Herkunft NICHT übernehmen, sonst würde die Rücknahme
      // des Löschantrags eine separat ausgesprochene Kündigung aufheben
      await writeCancelState(organizationId, { cancelAtPeriodEnd: true, periodEnd: sub.currentPeriodEnd });
      await audit({ organizationId, userId, action: "billing.cancel_skipped", entity: "organization", entityId: organizationId, meta: { trigger: reason, alreadyCanceled: true } });
      return { status: "already_canceled", periodEnd: sub.currentPeriodEnd ?? org.currentPeriodEnd };
    }
    const upd = await port.setCancelAtPeriodEnd(subId, true, reason);
    await writeCancelState(organizationId, { cancelAtPeriodEnd: upd.cancelAtPeriodEnd, reason, periodEnd: upd.currentPeriodEnd });
    const periodEnd = upd.currentPeriodEnd ?? org.currentPeriodEnd;
    await audit({ organizationId, userId, action: "billing.cancel_at_period_end", entity: "organization", entityId: organizationId, meta: { trigger: reason, periodEnd: periodEnd?.toISOString() ?? null } });
    return { status: "canceled", periodEnd };
  } catch (e) {
    console.error("[billing] Kündigung zum Periodenende fehlgeschlagen", organizationId, reason, errorKind(e));
    await markCancelError(organizationId, reason);
    await audit({ organizationId, userId, action: "billing.cancel_failed", entity: "organization", entityId: organizationId, meta: { trigger: reason, error: errorKind(e) } });
    if (reason === "deletion_request") {
      await inboxNotice(
        organizationId,
        "Abo nicht automatisch gekündigt",
        `Dein Löschantrag ist gespeichert. ${CANCEL_FAILED_MESSAGE} (Einstellungen → Abo). Der Betreiber wurde informiert.`,
      ).catch((err) => console.error("[billing] Posteingang-Hinweis fehlgeschlagen", organizationId, errorKind(err)));
    }
    return { status: "failed" };
  }
}

/**
 * Kündigung zum Periodenende zurücknehmen, solange das Abo läuft. Mit `onlyReason` nur, wenn die Kündigung aus
 * dieser Herkunft stammt – lokal UND laut Metadaten bei Stripe (Rücknahme des Löschantrags).
 */
export async function resumeSubscription(
  organizationId: string,
  userId: string | null,
  opts: { onlyReason?: CancelReason } = {},
  port: BillingPort = getBillingPort(),
): Promise<ResumeOutcome> {
  const org = await loadOrg(organizationId);
  if (!org) return { status: "no_subscription" };
  const local = cancelStateFromSettings(org.settings);
  if (opts.onlyReason && local.error?.trigger === opts.onlyReason) await clearCancelError(organizationId);
  if (!hasRunningSubscription(org)) return { status: "no_subscription" };
  if (opts.onlyReason && local.reason !== opts.onlyReason) {
    return local.cancelAtPeriodEnd ? { status: "kept", periodEnd: org.currentPeriodEnd } : { status: "not_canceled" };
  }
  const subId = org.stripeSubscriptionId!;
  try {
    assertRealPort(port, subId);
    const sub = await port.getSubscription(subId);
    if (!sub || !live(sub.status)) return { status: "no_subscription" };
    if (!sub.cancelAtPeriodEnd) {
      await writeCancelState(organizationId, { cancelAtPeriodEnd: false, reason: null, periodEnd: sub.currentPeriodEnd });
      return { status: "not_canceled" };
    }
    if (opts.onlyReason && sub.cancelReason !== opts.onlyReason) {
      // bei Stripe inzwischen anders gekündigt (z. B. Portal: erst fortgesetzt, dann erneut gekündigt) → bleibt
      await writeCancelState(organizationId, { cancelAtPeriodEnd: true, reason: null, periodEnd: sub.currentPeriodEnd });
      return { status: "kept", periodEnd: sub.currentPeriodEnd ?? org.currentPeriodEnd };
    }
    const upd = await port.setCancelAtPeriodEnd(subId, false, null);
    await writeCancelState(organizationId, { cancelAtPeriodEnd: upd.cancelAtPeriodEnd, reason: null, periodEnd: upd.currentPeriodEnd });
    const periodEnd = upd.currentPeriodEnd ?? org.currentPeriodEnd;
    await audit({ organizationId, userId, action: "billing.cancel_withdrawn", entity: "organization", entityId: organizationId, meta: { trigger: opts.onlyReason ?? "owner", previousReason: sub.cancelReason } });
    return { status: "resumed", periodEnd };
  } catch (e) {
    console.error("[billing] Rücknahme der Kündigung fehlgeschlagen", organizationId, errorKind(e));
    await markCancelError(organizationId, "resume");
    await audit({ organizationId, userId, action: "billing.resume_failed", entity: "organization", entityId: organizationId, meta: { trigger: opts.onlyReason ?? "owner", error: errorKind(e) } });
    return { status: "failed" };
  }
}
