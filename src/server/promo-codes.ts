import "server-only";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db, withOrg, type Tx } from "@/db";
import { organizations, promoCodes, promoRedemptions, salesCampaigns, salesLeads } from "@/db/schema";
import { audit } from "@/lib/audit";
import { PLANS, type PaidPlan } from "@/lib/plans";
import {
  isGeneratedPromoCode,
  isPayingOrg,
  normalizePromoCode,
  ownCodeProblem,
  PROMO_GRANT_PLANS,
  PROMO_INVALID,
  PROMO_MAX_TRIAL_DAYS,
  promoCodeUsable,
  promoRedemptionProblem,
  promoTrialEnd,
} from "@/lib/promo-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { revokeUserSessions } from "@/lib/auth/session";
import { returnPromoTrialToFree } from "./billing";

/**
 * Aktionscodes für eine verlängerte Testphase (Plattform-Betreiber). Regeln in src/lib/promo-codes.ts.
 * - Tabellen promo_codes/promo_redemptions sind plattformweit (keine RLS, wie sales_*); Zugriff NUR über diese Datei.
 * - Verwaltung (create/deactivate/list): Aufrufer prüfen vorher requirePlatformAdmin() (Admin + 2FA).
 * - Einlösen: bei der Registrierung (setupAction, in deren Transaktion) oder durch die Inhaber:in auf der Abo-Seite.
 *   Atomar: Code-Zeile FOR UPDATE, Obergrenze/Gültigkeit zusätzlich per DB-Trigger, je Praxis höchstens eine Einlösung (unique).
 * - Nach außen nur PROMO_INVALID („Code ungültig oder abgelaufen.“), Fehlversuche je Anschluss gedrosselt (promoFailLimiter).
 */

export class PromoCodeError extends Error {
  constructor(message = PROMO_INVALID) {
    super(message);
    this.name = "PromoCodeError";
  }
}

/** Fehlversuche (falscher/abgelaufener Code) je Anschluss bzw. Praxis: höchstens 10 je Stunde. */
export const promoFailLimiter = createRateLimiter({ windowMs: 3600_000, max: 10 });
/** Aufrufe der öffentlichen Aktionsseite /aktion/[code] je Anschluss: höchstens 60 je Stunde. */
export const promoLookupLimiter = createRateLimiter({ windowMs: 3600_000, max: 60 });

export type PromoCode = typeof promoCodes.$inferSelect;

// ───────────── Verwaltung (Plattform-Konsole) ─────────────

export type PromoCodeInput = {
  code: string;
  label: string;
  trialDays: number;
  grantPlan: PaidPlan | null;
  maxRedemptions: number | null;
  validUntil: Date | null;
  campaignId: string | null;
  leadId?: string | null;

};

export async function createPromoCode(adminUserId: string, input: PromoCodeInput): Promise<string> {
  const code = normalizePromoCode(input.code);
  if (!code) throw new Error("Code: 4 bis 32 Zeichen, nur Buchstaben A–Z, Ziffern und Bindestrich (nicht am Anfang/Ende).");
  // Zufallscode-Format (serverseitig erkannt) oder selbst gewählt → dann Mindestlänge und Begrenzung Pflicht
  if (!isGeneratedPromoCode(code)) {
    const own = ownCodeProblem(code, input.maxRedemptions, input.validUntil);
    if (own) throw new Error(own);
  }
  const label = input.label.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  if (!label) throw new Error("Bitte eine Bezeichnung angeben (nur intern sichtbar).");
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1 || input.trialDays > PROMO_MAX_TRIAL_DAYS) throw new Error(`Testphase: 1 bis ${PROMO_MAX_TRIAL_DAYS} Tage.`);
  if (input.grantPlan !== null && !PROMO_GRANT_PLANS.includes(input.grantPlan)) throw new Error("Tarif ungültig.");
  if (input.maxRedemptions !== null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1 || input.maxRedemptions > 100_000)) throw new Error("Höchstzahl Einlösungen: 1 bis 100000 oder leer.");
  if (input.validUntil && input.validUntil.getTime() <= Date.now()) throw new Error("„Gültig bis“ liegt in der Vergangenheit.");
  if (input.campaignId) {
    const [c] = await db.select({ id: salesCampaigns.id }).from(salesCampaigns).where(eq(salesCampaigns.id, input.campaignId));
    if (!c) throw new Error("Kampagne nicht gefunden.");
  }
  if (input.leadId) {
    const [l] = await db.select({ id: salesLeads.id }).from(salesLeads).where(eq(salesLeads.id, input.leadId));
    if (!l) throw new Error("Praxis (Lead) nicht gefunden.");
  }
  const [dup] = await db.select({ id: promoCodes.id }).from(promoCodes).where(eq(promoCodes.code, code));
  if (dup) throw new Error("Diesen Code gibt es bereits.");
  const [row] = await db
    .insert(promoCodes)
    .values({
      code,
      label,
      trialDays: input.trialDays,
      grantPlan: input.grantPlan,
      maxRedemptions: input.maxRedemptions,
      validUntil: input.validUntil,
      campaignId: input.campaignId,
      leadId: input.leadId ?? null,
      createdBy: adminUserId,
    })
    .returning({ id: promoCodes.id });
  await audit({
    userId: adminUserId,
    action: "promo.code_created",
    entity: "promo_code",
    entityId: row.id,
    meta: { code, trialDays: input.trialDays, grantPlan: input.grantPlan, maxRedemptions: input.maxRedemptions, validUntil: input.validUntil?.toISOString() ?? null, campaignId: input.campaignId },
  });
  return row.id;
}

export async function setPromoCodeActive(adminUserId: string, id: string, active: boolean) {
  const r = await db.update(promoCodes).set({ active }).where(eq(promoCodes.id, id)).returning({ code: promoCodes.code });
  if (!r.length) throw new Error("Code nicht gefunden.");
  await audit({ userId: adminUserId, action: active ? "promo.code_activated" : "promo.code_deactivated", entity: "promo_code", entityId: id, meta: { code: r[0].code } });
}

export type RedemptionRow = {
  id: string;
  codeId: string;
  organizationId: string;
  practiceName: string;
  via: string;
  redeemedAt: Date;
  trialEndsAfter: Date;
  converted: boolean;
  plan: string;
  subscriptionStatus: string;
};

export type PromoCodeListItem = PromoCode & { redemptions: number; converted: number; campaignName: string | null; leadName: string | null; usable: boolean };

export async function listPromoCodes(now = new Date()): Promise<PromoCodeListItem[]> {
  const rows = await db
    .select({ c: promoCodes, campaignName: salesCampaigns.name, leadName: salesLeads.name })
    .from(promoCodes)
    .leftJoin(salesCampaigns, eq(salesCampaigns.id, promoCodes.campaignId))
    .leftJoin(salesLeads, eq(salesLeads.id, promoCodes.leadId))
    .orderBy(desc(promoCodes.createdAt))
    .limit(500);
  const reds = await listRedemptions();
  return rows.map(({ c, campaignName, leadName }) => {
    const mine = reds.filter((r) => r.codeId === c.id);
    return {
      ...c,
      campaignName,
      leadName,
      redemptions: mine.length,
      converted: mine.filter((r) => r.converted).length,
      usable: promoCodeUsable({ ...c, redemptions: mine.length }, now),
    };
  });
}

/** Alle Einlösungen mit Praxisname und Abo-Stand (keine Patientendaten). */
export async function listRedemptions(codeIds?: string[]): Promise<RedemptionRow[]> {
  if (codeIds && !codeIds.length) return [];
  const rows = await db
    .select({
      id: promoRedemptions.id,
      codeId: promoRedemptions.codeId,
      organizationId: promoRedemptions.organizationId,
      practiceName: organizations.name,
      via: promoRedemptions.via,
      redeemedAt: promoRedemptions.redeemedAt,
      trialEndsAfter: promoRedemptions.trialEndsAfter,
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
    })
    .from(promoRedemptions)
    .innerJoin(organizations, eq(organizations.id, promoRedemptions.organizationId))
    .where(codeIds ? inArray(promoRedemptions.codeId, codeIds) : undefined)
    .orderBy(desc(promoRedemptions.redeemedAt))
    .limit(2000);
  return rows.map((r) => ({ ...r, converted: isPayingOrg(r) }));
}

// ───────────── Prüfen (öffentlich, ohne Hinweise) ─────────────

export type PromoOffer = { code: string; trialDays: number; grantPlan: PaidPlan | null; validUntil: Date | null; limited: boolean };

/** Gültiges Angebot zu einem Code oder null (nie ein Grund). Nur Code, Testtage und Tarif – keine internen Angaben. */
export async function lookupPromoCode(input: unknown, now = new Date()): Promise<PromoOffer | null> {
  const code = normalizePromoCode(input);
  if (!code) return null;
  const [c] = await db.select().from(promoCodes).where(eq(promoCodes.code, code));
  if (!c) return null;
  const [{ n }] = await db.select({ n: count() }).from(promoRedemptions).where(eq(promoRedemptions.codeId, c.id));
  if (!promoCodeUsable({ ...c, redemptions: Number(n) }, now)) return null;
  return { code: c.code, trialDays: c.trialDays, grantPlan: (c.grantPlan as PaidPlan | null) ?? null, validUntil: c.validUntil, limited: c.maxRedemptions !== null };
}

// ───────────── Einlösen ─────────────

const pgMessage = (e: unknown): string => {
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 4; i++) {
    const o = x as { message?: unknown; code?: unknown; constraint?: unknown; cause?: unknown };
    parts.push(String(o.message ?? ""), String(o.code ?? ""), String(o.constraint ?? ""));
    x = o.cause;
  }
  return parts.join(" ");
};

const ALREADY = "Für diese Praxis wurde bereits ein Aktionscode eingelöst (je Praxis nur einmal möglich).";

export type RedeemResult = { trialEndsAt: Date; trialDays: number; code: string; plan: string };

/**
 * Löst `input` für die Praxis ein – innerhalb einer bestehenden Transaktion `tx` (Praxis-Zeile ist dort bereits
 * angelegt bzw. gesperrt). Wirft PromoCodeError mit allgemeiner Meldung; jeder Fehler rollt die Transaktion zurück.
 * Setzt Tarif (Testphase bzw. gewährter Tarif), Status „trialing“ und trialEndsAt = max(bisher, jetzt + Testtage).
 */
export async function redeemPromoCodeTx(
  tx: Tx,
  opts: { input: unknown; organizationId: string; userId: string | null; via: "signup" | "abo"; now?: Date },
): Promise<RedeemResult> {
  const now = opts.now ?? new Date();
  // Reihenfolge der Sperren überall gleich: erst Praxis, dann Code (der Trigger sperrt den Code erneut).
  // Praxis-Gründe (laufendes Abo, schon eingelöst) VOR der Code-Prüfung – sonst verrieten sie, ob ein Code gültig ist.
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, opts.organizationId)).for("update");
  if (!org) throw new PromoCodeError();
  const problem = promoRedemptionProblem(org);
  if (problem) throw new PromoCodeError(problem);
  const [already] = await tx.select({ id: promoRedemptions.id }).from(promoRedemptions).where(eq(promoRedemptions.organizationId, org.id));
  if (already) throw new PromoCodeError(ALREADY);
  const code = normalizePromoCode(opts.input);
  if (!code) throw new PromoCodeError();
  const [c] = await tx.select().from(promoCodes).where(eq(promoCodes.code, code)).for("update");
  if (!c) throw new PromoCodeError();
  const [{ n }] = await tx.select({ n: count() }).from(promoRedemptions).where(eq(promoRedemptions.codeId, c.id));
  if (!promoCodeUsable({ ...c, redemptions: Number(n) }, now)) throw new PromoCodeError();

  // Testphase läuft schon (registriert oder trialing): bisheriges Ende zählt; sonst (abgelaufen/Kostenlos/beendet) ab jetzt
  const trialEndsAt = promoTrialEnd(org.trialEndsAt, now, c.trialDays);
  const plan = (c.grantPlan as PaidPlan | null) ?? "trial";
  const info = PLANS[plan];
  const seats = Math.min(Math.max(org.seats, info.includedSeats), info.maxSeats ?? Number.MAX_SAFE_INTEGER);
  try {
    await tx
      .insert(promoRedemptions)
      .values({ codeId: c.id, organizationId: org.id, redeemedBy: opts.userId, via: opts.via, previousPlan: org.plan, trialEndsBefore: org.trialEndsAt, trialEndsAfter: trialEndsAt, redeemedAt: now });
  } catch (e) {
    const m = pgMessage(e);
    if (/promo_redemptions_org|23505/.test(m)) throw new PromoCodeError(ALREADY);
    if (/promo_code_unavailable/.test(m)) throw new PromoCodeError();
    throw e;
  }
  // Kein laufendes Abo (promoRedemptionProblem): eine alte, beendete Stripe-Abo-ID wird entfernt (wie switchToFreePlan),
  // damit Checkout/Kostenlos-Wechsel danach gehen und Events des alten Abos nichts mehr ändern (billing.ts).
  // Aus dem Kostenlos-Tarif eingelöst → nach Ablauf automatisch zurück (returnPromoTrialToFree, Merker in settings).
  const fromFree = org.plan === "free";
  await tx
    .update(organizations)
    .set({
      plan,
      subscriptionStatus: "trialing",
      trialEndsAt,
      seats,
      stripeSubscriptionId: null,
      settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('promoReturnFree', ${fromFree}::boolean)`,
    })
    .where(eq(organizations.id, org.id));
  await audit(
    {
      organizationId: org.id,
      userId: opts.userId,
      action: "promo.redeemed",
      entity: "promo_code",
      entityId: c.id,
      meta: { code: c.code, via: opts.via, trialDays: c.trialDays, plan, from: { plan: org.plan, status: org.subscriptionStatus, trialEndsAt: org.trialEndsAt?.toISOString() ?? null }, trialEndsAt: trialEndsAt.toISOString() },
    },
    tx,
  );
  return { trialEndsAt, trialDays: c.trialDays, code: c.code, plan };
}

/** Abo-Seite: Inhaber:in löst einen Code für die eigene Praxis ein (Aufrufer prüft Rolle und Drosselung). */
export async function redeemPromoCodeForOrganization(organizationId: string, userId: string, input: unknown, now = new Date()): Promise<RedeemResult> {
  return withOrg(organizationId, (tx) => redeemPromoCodeTx(tx, { input, organizationId, userId, via: "abo", now }));
}

/** Einlösung der Praxis (für die Abo-Seite), null = noch keine */
export async function redemptionForOrganization(organizationId: string) {
  const [r] = await db
    .select({ code: promoCodes.code, trialDays: promoCodes.trialDays, redeemedAt: promoRedemptions.redeemedAt, trialEndsAfter: promoRedemptions.trialEndsAfter, previousPlan: promoRedemptions.previousPlan })
    .from(promoRedemptions)
    .innerJoin(promoCodes, eq(promoCodes.id, promoRedemptions.codeId))
    .where(and(eq(promoRedemptions.organizationId, organizationId)));
  return r ?? null;
}

/** Aktiver, einlösbarer Code einer Kampagne (neuester) bzw. eines Leads – für {{code}}/{{link}} in Vertriebsmails. */
export async function usableCodesFor(opts: { campaignIds: string[]; leadIds: string[] }, now = new Date()): Promise<{ byCampaign: Map<string, string>; byLead: Map<string, string> }> {
  const byCampaign = new Map<string, string>();
  const byLead = new Map<string, string>();
  if (!opts.campaignIds.length && !opts.leadIds.length) return { byCampaign, byLead };
  const rows = await db
    .select({ c: promoCodes, n: sql<number>`(select count(*)::int from ${promoRedemptions} r where r.code_id = ${promoCodes.id})` })
    .from(promoCodes)
    .where(
      sql`${promoCodes.active} and (${opts.campaignIds.length ? inArray(promoCodes.campaignId, opts.campaignIds) : sql`false`} or ${opts.leadIds.length ? inArray(promoCodes.leadId, opts.leadIds) : sql`false`})`,
    )
    .orderBy(desc(promoCodes.createdAt));
  for (const { c, n } of rows) {
    if (!promoCodeUsable({ ...c, redemptions: Number(n) }, now)) continue;
    if (c.leadId && !byLead.has(c.leadId)) byLead.set(c.leadId, c.code);
    if (c.campaignId && !c.leadId && !byCampaign.has(c.campaignId)) byCampaign.set(c.campaignId, c.code);
  }
  return { byCampaign, byLead };
}

/**
 * Nächtlicher Schritt (/api/cron/lead-search): Praxen, die einen Code im Kostenlos-Tarif eingelöst haben und deren
 * Testphase abgelaufen ist, zurück in den Kostenlos-Tarif (returnPromoTrialToFree: Sperren, Patientengrenze, Audit).
 * Deaktivierten Personen werden die Sitzungen in dieser Praxis beendet. Fehler je Praxis werden geloggt, der Lauf geht weiter.
 */
export async function runPromoTrialReturns(now = new Date()): Promise<{ checked: number; switched: number; kept: number; failed: number }> {
  const due = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      sql`${organizations.settings}->>'promoReturnFree' = 'true' and ${organizations.subscriptionStatus} = 'trialing' and ${organizations.stripeSubscriptionId} is null and ${organizations.trialEndsAt} <= ${now}`,
    )
    .orderBy(organizations.trialEndsAt)
    .limit(500);
  const out = { checked: due.length, switched: 0, kept: 0, failed: 0 };
  for (const { id } of due) {
    try {
      const r = await returnPromoTrialToFree(id, now);
      if (r.status === "switched") {
        out.switched++;
        for (const u of r.deactivated) await revokeUserSessions(u, { organizationId: id });
      } else if (r.status === "kept") out.kept++;
    } catch (e) {
      out.failed++;
      log.error("cron.promo_return_free.failed", { organizationId: id, error: e });
    }
  }
  return out;
}
