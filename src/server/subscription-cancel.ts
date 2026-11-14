import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { messages, organizations } from "@/db/schema";
import { BillingHttpError, BillingNotConfiguredError, getBillingPort, type BillingPort, type SubscriptionInfo } from "@/integrations/stripe";
import { mapSubscriptionStatus } from "@/integrations/stripe/events";
import { audit } from "@/lib/audit";
import { dateDe } from "@/lib/format";
import {
  CANCEL_FAILED_MESSAGE,
  cancelStateFromSettings,
  hasRunningSubscription,
  STRIPE_LIVE_STATUSES,
  type CancelMark,
  type CancelReason,
} from "@/lib/subscription-cancel";

/**
 * Kündigung des Stripe-Abos zum Periodenende und deren Rücknahme (Zustand: src/lib/subscription-cancel.ts).
 * Stripe ist die Quelle der Wahrheit: vor jeder Änderung werden die Abos frisch gelesen – das Abo der Praxis UND alle
 * weiteren Abos desselben Stripe-Kunden (z. B. ein versehentlich doppelt abgeschlossenes); gekündigt werden alle noch
 * laufenden. Eine Kündigung, die nicht von PodoHero stammt (z. B. über das Stripe-Kundenportal), bekommt keine Herkunft
 * und keine Marke (canceled_at) und wird bei der Rücknahme des Löschantrags nicht angetastet. Fehler werfen nicht – sie
 * werden protokolliert und als „failed“ gemeldet.
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
      stripeCustomerId: organizations.stripeCustomerId,
      currentPeriodEnd: organizations.currentPeriodEnd,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return o ?? null;
}
type OrgRow = NonNullable<Awaited<ReturnType<typeof loadOrg>>>;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Lokalen Stand nach einem erfolgreichen Stripe-Aufruf schreiben. Status und Periodenende kommen aus dem eben von Stripe
 * gelesenen bzw. zurückgegebenen Abo (also mindestens so aktuell wie jedes bis dahin erzeugte Event); billingLastEventAt
 * wird auf jetzt angehoben, damit ältere, verspätet zugestellte Abo-Events die eben gesetzte Kündigung nicht
 * überschreiben (processBillingEvent). `reason`/`marks`: undefined = unverändert lassen, null = entfernen.
 */
async function writeCancelState(
  organizationId: string,
  s: { cancelAtPeriodEnd: boolean; reason?: CancelReason | null; marks?: CancelMark[] | null; periodEnd?: Date; status?: string },
) {
  const reasonSql =
    s.reason === undefined
      ? sql``
      : s.reason === null
        ? sql` - 'billingCancelReason'`
        : sql` || jsonb_build_object('billingCancelReason', ${s.reason}::text)`;
  const marksSql =
    s.marks === undefined
      ? sql``
      : s.marks === null || !s.marks.length
        ? sql` - 'billingCancelMarks'`
        : sql` || jsonb_build_object('billingCancelMarks', ${JSON.stringify(s.marks)}::jsonb)`;
  const status = s.status ? mapSubscriptionStatus(s.status) : undefined;
  await db
    .update(organizations)
    .set({
      ...(s.periodEnd ? { currentPeriodEnd: s.periodEnd } : {}),
      ...(status ? { subscriptionStatus: status } : {}),
      settings: sql`((coalesce(${organizations.settings}, '{}'::jsonb) - 'billingCancelError')${reasonSql}${marksSql}) || jsonb_build_object('billingCancelAtPeriodEnd', ${s.cancelAtPeriodEnd}::boolean, 'billingLastEventAt', greatest(coalesce((${organizations.settings}->>'billingLastEventAt')::bigint, 0), ${nowSec()}::bigint))`,
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
export const errorKind = (e: unknown) => (e instanceof BillingHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.name : "Fehler");

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

/**
 * Gehört das Abo zum Stripe-Kunden der Praxis? (AppSec L-4) Eine fremde bzw. vertauschte Abo-ID wird nie gekündigt oder
 * fortgesetzt. Ohne Kunden-ID am Abo (Mock) zählt es als zugehörig.
 */
const ownedBy = (sub: SubscriptionInfo, org: OrgRow) => !sub.customerId || sub.customerId === org.stripeCustomerId;

/**
 * Alle noch nicht beendeten Abos der Praxis: das hinterlegte (falls laut lokalem Stand laufend) und – mit echtem
 * Stripe-Zugang – alle weiteren des Stripe-Kunden. Das hinterlegte Abo steht vorn.
 */
async function liveSubscriptions(org: OrgRow, port: BillingPort): Promise<SubscriptionInfo[]> {
  const found = new Map<string, SubscriptionInfo>();
  if (hasRunningSubscription(org)) {
    assertRealPort(port, org.stripeSubscriptionId!);
    const sub = await port.getSubscription(org.stripeSubscriptionId!);
    // fremdes Abo hinterlegt: nichts ändern, als Fehler melden (Betreiber-Hinweis über billingCancelError)
    if (sub && !ownedBy(sub, org)) throw Object.assign(new Error("Abo gehört nicht zum Stripe-Kunden der Praxis"), { name: "SubscriptionCustomerMismatch" });
    if (sub) found.set(sub.id, sub);
  }
  if (org.stripeCustomerId && !port.isMock) {
    for (const sub of await port.listSubscriptions(org.stripeCustomerId)) if (!found.has(sub.id) && ownedBy(sub, org)) found.set(sub.id, sub);
  }
  return [...found.values()].filter((x) => live(x.status));
}

/** Abo zum Ende des Abrechnungszeitraums kündigen (Löschantrag oder „Abo kündigen“) – alle laufenden Abos des Kunden. */
export async function cancelSubscriptionAtPeriodEnd(
  organizationId: string,
  userId: string | null,
  reason: CancelReason,
  port: BillingPort = getBillingPort(),
): Promise<CancelOutcome> {
  const org = await loadOrg(organizationId);
  if (!org || (!hasRunningSubscription(org) && !org.stripeCustomerId)) return { status: "no_subscription" };
  const marks: CancelMark[] = [];
  try {
    const subs = await liveSubscriptions(org, port);
    if (!subs.length) return { status: "no_subscription" };
    const after = new Map<string, SubscriptionInfo>();
    for (const sub of subs) {
      // bereits gekündigt (Kundenportal oder früher): Herkunft NICHT übernehmen, sonst würde die Rücknahme
      // des Löschantrags eine separat ausgesprochene Kündigung aufheben
      if (sub.cancelAtPeriodEnd) continue;
      const upd = await port.setCancelAtPeriodEnd(sub.id, true, reason);
      marks.push({ id: sub.id, at: upd.canceledAt ?? null });
      after.set(sub.id, upd);
    }
    const main = after.get(subs[0].id) ?? subs[0];
    const own = main.id === org.stripeSubscriptionId;
    const periodEnd = main.currentPeriodEnd ?? org.currentPeriodEnd;
    if (!marks.length) {
      await writeCancelState(organizationId, { cancelAtPeriodEnd: true, periodEnd: own ? main.currentPeriodEnd : undefined, status: own ? main.status : undefined });
      await audit({ organizationId, userId, action: "billing.cancel_skipped", entity: "organization", entityId: organizationId, meta: { trigger: reason, alreadyCanceled: true, subscriptions: subs.length } });
      return { status: "already_canceled", periodEnd };
    }
    await writeCancelState(organizationId, {
      cancelAtPeriodEnd: true,
      reason,
      marks: [...cancelStateFromSettings(org.settings).marks.filter((m) => !after.has(m.id)), ...marks],
      periodEnd: own ? main.currentPeriodEnd : undefined,
      status: own ? main.status : undefined,
    });
    await audit({
      organizationId,
      userId,
      action: "billing.cancel_at_period_end",
      entity: "organization",
      entityId: organizationId,
      meta: { trigger: reason, periodEnd: periodEnd?.toISOString() ?? null, subscriptions: marks.map((m) => m.id) },
    });
    // Bestätigung mit Vertragsende (AGB § 8 Nr. 3) – zusätzlich zur Meldung auf der Seite dauerhaft im Posteingang
    const end = periodEnd ? dateDe(periodEnd) : "Ende des Abrechnungszeitraums";
    await inboxNotice(
      organizationId,
      "Kündigung bestätigt",
      reason === "deletion_request"
        ? `Mit deinem Löschantrag ist dein PodoHero-Abo zum ${end} gekündigt (Vertragsende); danach wird nichts mehr abgebucht. Bis zum Ende des Abrechnungszeitraums kannst du die Kündigung in der Software zurücknehmen.`
        : `Dein PodoHero-Abo ist zum ${end} gekündigt (Vertragsende); danach wird nichts mehr abgebucht. Bis zum Ende des Abrechnungszeitraums kannst du die Kündigung in der Software zurücknehmen. Danach bleibt die Praxis höchstens 12 Monate lesbar – exportiere rechtzeitig (Einstellungen → Daten & Kündigung).`,
    ).catch((err) => console.error("[billing] Posteingang-Hinweis fehlgeschlagen", organizationId, errorKind(err)));
    return { status: "canceled", periodEnd };
  } catch (e) {
    console.error("[billing] Kündigung zum Periodenende fehlgeschlagen", organizationId, reason, errorKind(e));
    // Teilerfolg (mehrere Abos): bereits gekündigte Abos mit Marke festhalten, damit eine Rücknahme sie findet
    if (marks.length) {
      await writeCancelState(organizationId, { cancelAtPeriodEnd: true, reason, marks: [...cancelStateFromSettings(org.settings).marks, ...marks] }).catch(() => undefined);
    }
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
 * Kündigung zum Periodenende zurücknehmen, solange das Abo läuft.
 *  - Ohne `onlyReason` (Inhaber:in auf der Abo-Seite): das Abo der Praxis und alle von PodoHero gekündigten Abos.
 *  - Mit `onlyReason` (Rücknahme des Löschantrags): nur Kündigungen dieser Herkunft – lokal (billingCancelReason) UND
 *    je Abo bei Stripe: metadata.cancel_reason passt und canceled_at ist noch dasselbe wie bei unserer Kündigung.
 *    Eine spätere erneute Kündigung (z. B. Kundenportal: erst fortgesetzt, dann wieder gekündigt – die Metadaten
 *    bleiben dabei stehen) hat ein neues canceled_at und bleibt bestehen.
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
  const running = hasRunningSubscription(org);
  if (!running && !local.marks.length) return { status: "no_subscription" };
  if (opts.onlyReason && local.reason !== opts.onlyReason) {
    return running && local.cancelAtPeriodEnd ? { status: "kept", periodEnd: org.currentPeriodEnd } : running ? { status: "not_canceled" } : { status: "no_subscription" };
  }
  try {
    // Ziele: markierte Abos; ältere Stände ohne Marken bzw. die Inhaber:in auf der Abo-Seite: auch das Abo der Praxis
    const targets = new Map<string, number | null | undefined>(local.marks.map((m) => [m.id, m.at]));
    if (running && (!opts.onlyReason || !local.marks.length) && !targets.has(org.stripeSubscriptionId!)) targets.set(org.stripeSubscriptionId!, undefined);
    let resumed = 0;
    let kept = 0;
    let anyLive = false;
    let main: SubscriptionInfo | null = null;
    for (const [id, at] of targets) {
      assertRealPort(port, id);
      const sub = await port.getSubscription(id);
      if (!sub || !live(sub.status) || !ownedBy(sub, org)) continue;
      anyLive = true;
      let state = sub;
      if (sub.cancelAtPeriodEnd) {
        const foreign = opts.onlyReason && (sub.cancelReason !== opts.onlyReason || (at !== undefined && at !== null && sub.canceledAt !== at));
        if (foreign) kept++;
        else {
          state = await port.setCancelAtPeriodEnd(id, false, null);
          resumed++;
        }
      }
      if (id === org.stripeSubscriptionId) main = state;
    }
    // Abo der Praxis nicht unter den Zielen (z. B. separat im Portal gekündigt): Zustand trotzdem frisch übernehmen
    if (running && !targets.has(org.stripeSubscriptionId!)) {
      const sub = await port.getSubscription(org.stripeSubscriptionId!);
      if (sub && live(sub.status) && ownedBy(sub, org)) {
        main = sub;
        anyLive = true;
        if (sub.cancelAtPeriodEnd) kept++;
      }
    }
    const mainCanceled = main?.cancelAtPeriodEnd ?? false;
    await writeCancelState(organizationId, {
      cancelAtPeriodEnd: mainCanceled,
      reason: null,
      marks: null,
      periodEnd: main?.currentPeriodEnd,
      status: main?.status,
    });
    if (!anyLive) return { status: "no_subscription" };
    const periodEnd = main?.currentPeriodEnd ?? org.currentPeriodEnd;
    if (resumed) {
      await audit({ organizationId, userId, action: "billing.cancel_withdrawn", entity: "organization", entityId: organizationId, meta: { trigger: opts.onlyReason ?? "owner", previousReason: local.reason, subscriptions: resumed, kept } });
    }
    if (mainCanceled || (kept && !resumed)) return { status: "kept", periodEnd };
    return resumed ? { status: "resumed", periodEnd } : { status: "not_canceled" };
  } catch (e) {
    console.error("[billing] Rücknahme der Kündigung fehlgeschlagen", organizationId, errorKind(e));
    await markCancelError(organizationId, "resume");
    await audit({ organizationId, userId, action: "billing.resume_failed", entity: "organization", entityId: organizationId, meta: { trigger: opts.onlyReason ?? "owner", error: errorKind(e) } });
    if (opts.onlyReason === "deletion_request") {
      await inboxNotice(
        organizationId,
        "Kündigung nicht automatisch zurückgenommen",
        "Dein Löschantrag ist zurückgenommen, die damit verbundene Kündigung deines Abos konnte aber nicht automatisch zurückgenommen werden. Bitte unter Einstellungen → Abo „Kündigung zurücknehmen“ wählen oder den Support kontaktieren. Der Betreiber wurde informiert.",
      ).catch((err) => console.error("[billing] Posteingang-Hinweis fehlgeschlagen", organizationId, errorKind(err)));
    }
    return { status: "failed" };
  }
}
