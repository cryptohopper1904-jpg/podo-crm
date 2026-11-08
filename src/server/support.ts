import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { memberships, sessions, supportGrants, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { SUPPORT_MAX_HOURS, SUPPORT_MIN_HOURS } from "@/lib/auth/access";
import { findActiveSupportGrant, type AuthContext } from "@/lib/auth/session";

/**
 * Support-Freigaben (Break-Glass, PLAN.md 14.4): Die Praxis (Inhaber:in) erteilt einem Plattform-Admin
 * zeitlich begrenzten, standardmäßig nur lesenden Zugriff. Erteilen, Widerrufen, Betreten, Verlassen
 * und jede Seitenansicht stehen im Audit-Log DER PRAXIS.
 */

export type GrantInput = { reason: string; hours: number; scope: "read" | "write"; granteeUserId?: string | null };

export function validateGrantInput(input: GrantInput): string | null {
  if (input.reason.trim().length < 5) return "Bitte einen Grund angeben (mind. 5 Zeichen).";
  if (input.reason.length > 500) return "Grund zu lang (max. 500 Zeichen).";
  if (!Number.isInteger(input.hours) || input.hours < SUPPORT_MIN_HOURS || input.hours > SUPPORT_MAX_HOURS) {
    return `Dauer: ${SUPPORT_MIN_HOURS} bis ${SUPPORT_MAX_HOURS} Stunden.`;
  }
  if (input.scope !== "read" && input.scope !== "write") return "Umfang ungültig.";
  return null;
}

const ownerOnly = (auth: AuthContext) => {
  if (auth.role !== "owner" || auth.support) throw new Error("Nur die Praxisinhaberin bzw. der Praxisinhaber kann Support-Zugriff verwalten.");
};

export async function createSupportGrant(auth: AuthContext, input: GrantInput, now = new Date()) {
  ownerOnly(auth);
  const problem = validateGrantInput(input);
  if (problem) throw new Error(problem);
  const org = auth.organization.id;
  const expiresAt = new Date(now.getTime() + input.hours * 3600_000);
  const [g] = await withOrg(org, (tx) =>
    tx
      .insert(supportGrants)
      .values({
        organizationId: org,
        grantedBy: auth.user.id,
        granteeUserId: input.granteeUserId ?? null,
        reason: input.reason.trim(),
        scope: input.scope,
        expiresAt,
      })
      .returning(),
  );
  await audit({
    organizationId: org,
    userId: auth.user.id,
    action: "support.grant",
    entity: "support_grant",
    entityId: g.id,
    meta: { hours: input.hours, scope: input.scope, expiresAt: expiresAt.toISOString() },
  });
  return g;
}

export async function revokeSupportGrant(auth: AuthContext, grantId: string) {
  ownerOnly(auth);
  const org = auth.organization.id;
  const [g] = await withOrg(org, (tx) =>
    tx
      .update(supportGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(supportGrants.organizationId, org), eq(supportGrants.id, grantId), isNull(supportGrants.revokedAt)))
      .returning(),
  );
  if (!g) return false;
  await audit({ organizationId: org, userId: auth.user.id, action: "support.revoke", entity: "support_grant", entityId: g.id });
  return true;
}

export async function listSupportGrants(auth: AuthContext) {
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ g: supportGrants, grantedByName: users.name })
      .from(supportGrants)
      .leftJoin(users, eq(users.id, supportGrants.grantedBy))
      .where(eq(supportGrants.organizationId, org))
      .orderBy(desc(supportGrants.createdAt))
      .limit(50),
  );
}

export type PlatformUser = { id: string; isPlatformAdmin: boolean; totpEnabled: boolean };

/** Plattform-Admin betritt eine Praxis (nur mit gültiger Freigabe). Gibt false zurück, wenn keine besteht. */
export async function enterSupport(user: PlatformUser, sessionId: string, organizationId: string): Promise<boolean> {
  if (!user.isPlatformAdmin || !user.totpEnabled) return false;
  // eigene Mitgliedschaft? Dann ist es kein Support, sondern ein normaler Praxiswechsel
  const [own] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.organizationId, organizationId), eq(memberships.active, true)))
    .limit(1);
  if (own) return false;
  const grant = await findActiveSupportGrant(organizationId, user.id);
  if (!grant) return false;
  await db.update(sessions).set({ organizationId }).where(eq(sessions.id, sessionId));
  await audit({ organizationId, userId: user.id, action: "support.enter", entity: "support_grant", entityId: grant.grantId, meta: { scope: grant.scope } });
  return true;
}

/** Support verlassen: zurück in die eigene Praxis (oder ohne Praxis). */
export async function exitSupport(userId: string, sessionId: string, fromOrganizationId: string | null) {
  const [own] = await db
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)))
    .limit(1);
  await db.update(sessions).set({ organizationId: own?.organizationId ?? null }).where(eq(sessions.id, sessionId));
  if (fromOrganizationId) await audit({ organizationId: fromOrganizationId, userId, action: "support.exit" });
}
