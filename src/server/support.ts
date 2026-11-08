import "server-only";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, withOrg } from "@/db";
import { memberships, supportGrants, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { SUPPORT_MAX_HOURS, SUPPORT_MIN_HOURS } from "@/lib/auth/access";
import { findActiveSupportGrant, rotateSession, type AuthContext } from "@/lib/auth/session";

/**
 * Support-Freigaben (Break-Glass, PLAN.md 14.4): Die Praxis (Inhaber:in) erteilt einem Plattform-Admin
 * zeitlich begrenzten, standardmäßig nur lesenden Zugriff. Erteilen, Widerrufen, Betreten, Verlassen
 * und jede Seitenansicht stehen im Audit-Log DER PRAXIS.
 */

/**
 * Neue Freigaben sind immer personengebunden (granteeUserId = konkreter Plattform-Admin mit 2FA).
 * Ältere Freigaben ohne Person (null = alle Betreiber-Admins) bleiben bis zu ihrem Ablauf gültig und werden
 * in der Übersicht als solche markiert.
 */
export type GrantInput = { reason: string; hours: number; scope: "read" | "write"; granteeUserId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateGrantInput(input: GrantInput): string | null {
  if (typeof input.granteeUserId !== "string" || !UUID.test(input.granteeUserId)) return "Bitte die Person beim Support auswählen, die zugreifen darf.";
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

export type SupportAdmin = { id: string; name: string; email: string };

/** Plattform-Admins, denen eine Freigabe erteilt werden kann (nur mit aktiver 2FA) – nur Name und E-Mail. */
export async function listSupportAdmins(): Promise<SupportAdmin[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.isPlatformAdmin, true), eq(users.totpEnabled, true)))
    .orderBy(asc(users.name))
    .limit(100);
}

async function isEligibleSupportAdmin(userId: string) {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isPlatformAdmin, true), eq(users.totpEnabled, true)))
    .limit(1);
  return !!u;
}

export async function createSupportGrant(auth: AuthContext, input: GrantInput, now = new Date()) {
  ownerOnly(auth);
  const problem = validateGrantInput(input);
  if (problem) throw new Error(problem);
  if (!(await isEligibleSupportAdmin(input.granteeUserId))) throw new Error("Diese Person kann keinen Support-Zugriff erhalten (kein Betreiber-Konto mit Zwei-Faktor-Anmeldung).");
  const org = auth.organization.id;
  const expiresAt = new Date(now.getTime() + input.hours * 3600_000);
  const [g] = await withOrg(org, (tx) =>
    tx
      .insert(supportGrants)
      .values({
        organizationId: org,
        grantedBy: auth.user.id,
        granteeUserId: input.granteeUserId,
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
    meta: { hours: input.hours, scope: input.scope, expiresAt: expiresAt.toISOString(), granteeUserId: input.granteeUserId },
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

const grantee = alias(users, "grantee");

/** Übersicht der Freigaben (inkl. E-Mail-Adressen der Plattform-Admins und Begründungen): nur Inhaber:in
 *  bzw. wer Praxiseinstellungen verwalten darf – nie der Support selbst. */
export async function listSupportGrants(auth: AuthContext) {
  if (auth.support || !(auth.role === "owner" || auth.can("settings.manage"))) {
    throw new Error("Nur die Praxisinhaberin bzw. der Praxisinhaber kann Support-Zugriff verwalten.");
  }
  const org = auth.organization.id;
  return withOrg(org, (tx) =>
    tx
      .select({ g: supportGrants, grantedByName: users.name, granteeName: grantee.name, granteeEmail: grantee.email })
      .from(supportGrants)
      .leftJoin(users, eq(users.id, supportGrants.grantedBy))
      .leftJoin(grantee, eq(grantee.id, supportGrants.granteeUserId))
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
  // Neues Token beim Betreten der fremden Praxis (Session-Fixation/-Wiederverwendung)
  if (!(await rotateSession(sessionId, user.id, organizationId))) return false;
  await audit({ organizationId, userId: user.id, action: "support.enter", entity: "support_grant", entityId: grant.grantId, meta: { scope: grant.scope } });
  return true;
}

/** Support verlassen: zurück in die eigene Praxis (oder ohne Praxis). */
export async function exitSupport(userId: string, sessionId: string, fromOrganizationId: string | null): Promise<boolean> {
  const [own] = await db
    .select({ organizationId: memberships.organizationId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)))
    .limit(1);
  if (!(await rotateSession(sessionId, userId, own?.organizationId ?? null))) return false;
  if (fromOrganizationId) await audit({ organizationId: fromOrganizationId, userId, action: "support.exit" });
  return true;
}
