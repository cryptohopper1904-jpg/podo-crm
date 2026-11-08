/**
 * Übersetzt Stripe-Events in Änderungen am Abo einer Praxis (rein, ohne DB – testbar).
 * Verarbeitet: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.payment_failed.
 */
import { isPaidPlan, PLANS, type PaidPlan } from "@/lib/plans";
import type { PriceIds } from "./stripe";
import type { StripeEvent } from "./types";

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
] as const;

export type OrgBillingPatch = {
  plan?: PaidPlan;
  subscriptionStatus?: "active" | "trialing" | "past_due" | "canceled" | "paused";
  seats?: number;
  currentPeriodEnd?: Date;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
};

export type BillingUpdate = {
  /** aus Metadaten/client_reference_id (bevorzugt) */
  organizationId: string | null;
  /** Fallback-Zuordnung über die Stripe-Kunden-ID */
  customerId: string | null;
  patch: OrgBillingPatch;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** Stripe liefert IDs entweder als String oder als expandiertes Objekt */
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);
const uuid = (v: unknown): string | null => {
  const s = str(v);
  return s && UUID.test(s) ? s : null;
};
const unix = (v: unknown): Date | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : undefined);

export function mapSubscriptionStatus(s: unknown): OrgBillingPatch["subscriptionStatus"] {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return undefined;
  }
}

/** Tarif und Plätze aus den Abo-Positionen (Grundpreis + Zusatzplätze) */
export function planFromItems(sub: Record<string, unknown>, prices: PriceIds): { plan?: PaidPlan; seats?: number } {
  const items = Array.isArray(obj(sub.items).data) ? (obj(sub.items).data as unknown[]) : [];
  let plan: PaidPlan | undefined;
  let extra = 0;
  for (const it of items) {
    const price = idOf(obj(it).price);
    const qty = typeof obj(it).quantity === "number" ? (obj(it).quantity as number) : 1;
    if (!price) continue;
    if (prices.seat && price === prices.seat) extra += qty;
    else for (const p of ["starter", "praxis", "plus"] as const) if (prices[p] && prices[p] === price) plan = p;
  }
  const metaPlan = obj(sub.metadata).plan;
  if (!plan && isPaidPlan(metaPlan)) plan = metaPlan;
  if (!plan) return {};
  const max = PLANS[plan].maxSeats;
  const seats = PLANS[plan].includedSeats + extra;
  return { plan, seats: max === null ? seats : Math.min(seats, max) };
}

function periodEnd(sub: Record<string, unknown>): Date | undefined {
  // ältere API-Versionen: auf dem Abo; neuere: je Position
  const top = unix(sub.current_period_end);
  if (top) return top;
  const items = Array.isArray(obj(sub.items).data) ? (obj(sub.items).data as unknown[]) : [];
  const ends = items.map((i) => unix(obj(i).current_period_end)).filter((d): d is Date => !!d);
  return ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : undefined;
}

export function billingUpdateFromEvent(ev: StripeEvent, prices: PriceIds): BillingUpdate | null {
  const o = obj(ev.data.object);
  switch (ev.type) {
    case "checkout.session.completed": {
      if (o.mode && o.mode !== "subscription") return null;
      const meta = obj(o.metadata);
      const plan = isPaidPlan(meta.plan) ? meta.plan : undefined;
      const seatsNum = Number(meta.seats);
      // Nur bei tatsächlich bezahlter (oder kostenfreier, z. B. Testphase) Sitzung freischalten;
      // asynchrone Zahlarten (SEPA) aktivieren später über customer.subscription.updated.
      const paid = o.payment_status === undefined || o.payment_status === "paid" || o.payment_status === "no_payment_required";
      const patch: OrgBillingPatch = paid ? { subscriptionStatus: "active" } : {};
      if (plan) {
        patch.plan = plan;
        if (Number.isInteger(seatsNum) && seatsNum >= 1 && seatsNum <= 999) {
          const max = PLANS[plan].maxSeats;
          patch.seats = max === null ? seatsNum : Math.min(seatsNum, max);
        }
      }
      const customer = idOf(o.customer);
      const sub = idOf(o.subscription);
      if (customer) patch.stripeCustomerId = customer;
      if (sub) patch.stripeSubscriptionId = sub;
      return { organizationId: uuid(o.client_reference_id) ?? uuid(meta.organizationId), customerId: customer, patch };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const customer = idOf(o.customer);
      const patch: OrgBillingPatch = {};
      const status = ev.type === "customer.subscription.deleted" ? "canceled" : mapSubscriptionStatus(o.status);
      if (status) patch.subscriptionStatus = status;
      const { plan, seats } = planFromItems(o, prices);
      if (plan && ev.type !== "customer.subscription.deleted") {
        patch.plan = plan;
        patch.seats = seats;
      }
      const end = ev.type === "customer.subscription.deleted" ? (unix(o.ended_at) ?? periodEnd(o)) : periodEnd(o);
      if (end) patch.currentPeriodEnd = end;
      const sid = idOf(o.id);
      if (sid) patch.stripeSubscriptionId = sid;
      if (customer) patch.stripeCustomerId = customer;
      return { organizationId: uuid(obj(o.metadata).organizationId), customerId: customer, patch };
    }
    case "invoice.payment_failed": {
      const customer = idOf(o.customer);
      return { organizationId: uuid(obj(obj(obj(o.parent).subscription_details).metadata).organizationId), customerId: customer, patch: { subscriptionStatus: "past_due" } };
    }
    default:
      return null;
  }
}
