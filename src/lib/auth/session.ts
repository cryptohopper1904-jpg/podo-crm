import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { auditLog, memberships, organizations, sessions, supportGrants, users } from "@/db/schema";
import { accessMode, type AccessInfo, type OrgBilling } from "@/lib/plans";
import { effectiveCan, isReadPermission, mutationAllowedWithoutPermission, pickActiveGrant, type SupportContext } from "./access";
import { can, type Permission, type Role } from "./permissions";

export const SESSION_COOKIE = "podo_session";
const SESSION_HOURS = 12;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function requestMeta() {
  const h = await headers();
  return {
    // Letzter Eintrag = vom eigenen Reverse-Proxy (Caddy) angehängt; der erste wäre vom Client fälschbar
    ip: h.get("x-forwarded-for")?.split(",").pop()?.trim() ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

export async function createSession(userId: string, organizationId: string | null, verified: boolean) {
  const token = randomBytes(32).toString("base64url");
  const meta = await requestMeta();
  // Unbestätigte Sitzungen (2FA ausstehend) laufen nach 10 Minuten ab
  const expiresAt = new Date(Date.now() + (verified ? SESSION_HOURS * 3600_000 : 10 * 60_000));
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    organizationId,
    verified,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  jar.delete(SESSION_COOKIE);
}

/** Nach erfolgreicher 2FA: alte Sitzung verwerfen und ein NEUES Token ausgeben (Session-Fixation). */
export async function markSessionVerified() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const [old] = await db.delete(sessions).where(eq(sessions.id, sha256(token))).returning();
  if (old) await createSession(old.userId, old.organizationId, true);
}

/** Liest die Sitzung (gecacht pro Request). Gibt null zurück, wenn keine gültige Sitzung existiert. */
export const getSession = cache(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const id = sha256(token);
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
});

export type AuthContext = {
  sessionId: string;
  user: { id: string; email: string; name: string; totpEnabled: boolean; isPlatformAdmin: boolean };
  organization: { id: string; name: string; slug: string; smallBusiness: boolean; state: string };
  /** Tarif/Abo-Felder der Praxis */
  billing: OrgBilling;
  access: AccessInfo;
  /** Praxis im Nur-Lesen-Modus (Abo) – Lesen und Export bleiben immer möglich */
  readOnly: boolean;
  /** gesetzt, wenn ein Plattform-Admin per Support-Freigabe (Break-Glass) in der Praxis ist */
  support: SupportContext | null;
  /** aktuelle Anfrage ist schreibend (alles außer GET/HEAD) */
  mutating: boolean;
  role: Role;
  can: (p: Permission) => boolean;
};

/**
 * Methode/Pfad der Anfrage – vom Proxy (src/proxy.ts) gesetzt und dabei überschrieben (nicht fälschbar).
 * FAIL CLOSED: fehlt der Header, gilt die Anfrage als schreibend.
 */
async function requestInfo() {
  try {
    const h = await headers();
    const method = h.get("x-podo-method")?.toUpperCase() ?? null;
    return { mutating: method !== "GET" && method !== "HEAD", path: h.get("x-podo-path")?.slice(0, 300) ?? null };
  } catch {
    return { mutating: true, path: null };
  }
}

const billingOf = (o: typeof organizations.$inferSelect): OrgBilling => ({
  plan: o.plan,
  subscriptionStatus: o.subscriptionStatus,
  trialEndsAt: o.trialEndsAt,
  currentPeriodEnd: o.currentPeriodEnd,
  seats: o.seats,
});

/** Aktive Support-Freigabe einer Praxis für einen Plattform-Admin (support_grants unterliegt RLS). */
export async function findActiveSupportGrant(organizationId: string, userId: string, now = new Date()): Promise<SupportContext | null> {
  const rows = await withOrg(organizationId, (tx) =>
    tx
      .select()
      .from(supportGrants)
      .where(and(eq(supportGrants.organizationId, organizationId), isNull(supportGrants.revokedAt), gt(supportGrants.expiresAt, now))),
  );
  return pickActiveGrant(rows, userId, now);
}

export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const row = await getSession();
  if (!row || !row.session.verified || !row.session.organizationId) return null;
  const orgId = row.session.organizationId;
  const req = await requestInfo();
  const [m] = await db
    .select({ membership: memberships, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, row.user.id), eq(memberships.organizationId, orgId), eq(memberships.active, true)))
    .limit(1);

  let org: typeof organizations.$inferSelect;
  let role: Role;
  let support: SupportContext | null = null;
  if (m) {
    org = m.org;
    role = m.membership.role as Role;
  } else {
    // Keine Mitgliedschaft: nur Plattform-Admin MIT 2FA und gültiger Freigabe der Praxis (Break-Glass)
    const grant = row.user.isPlatformAdmin && row.user.totpEnabled ? await findActiveSupportGrant(orgId, row.user.id) : null;
    const [o] = grant ? await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1) : [];
    if (!grant || !o) {
      if (!row.user.isPlatformAdmin) return null;
      // Freigabe abgelaufen/widerrufen: zurück in die eigene Praxis (falls vorhanden)
      const [own] = await db
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(and(eq(memberships.userId, row.user.id), eq(memberships.active, true)))
        .limit(1);
      await db.update(sessions).set({ organizationId: own?.organizationId ?? null }).where(eq(sessions.id, row.session.id));
      await db.insert(auditLog).values({ organizationId: orgId, userId: row.user.id, action: "support.ended", meta: { reason: "keine gültige Freigabe (abgelaufen, widerrufen oder nie erteilt)" }, ip: row.session.ip });
      if (!own) return null;
      return loadOwn(row, own.organizationId, req);
    }
    org = o;
    role = "owner"; // nur für Anzeige; die Rechte begrenzt effectiveCan()
    support = grant;
    // Jede Seitenansicht/Anfrage im Support-Modus wird im Audit-Log der Praxis protokolliert
    const meta = await requestMeta().catch(() => ({ ip: null }));
    await db.insert(auditLog).values({
      organizationId: org.id,
      userId: row.user.id,
      action: "support.view",
      entity: "support_grant",
      entityId: grant.grantId,
      meta: { path: req.path, method: req.mutating ? "write" : "read" },
      ip: meta.ip,
    });
  }
  return build(row, org, role, support, req.mutating);
});

type SessionRow = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function loadOwn(row: SessionRow, orgId: string, req: { mutating: boolean }): Promise<AuthContext | null> {
  const [m] = await db
    .select({ membership: memberships, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, row.user.id), eq(memberships.organizationId, orgId), eq(memberships.active, true)))
    .limit(1);
  return m ? build(row, m.org, m.membership.role as Role, null, req.mutating) : null;
}

function build(row: SessionRow, org: typeof organizations.$inferSelect, role: Role, support: SupportContext | null, mutating: boolean): AuthContext {
  const billing = billingOf(org);
  const access = accessMode(billing);
  const readOnly = access.mode === "readonly";
  const state = { role, readOnly, mutating, support };
  return {
    sessionId: row.session.id,
    user: { id: row.user.id, email: row.user.email, name: row.user.name, totpEnabled: row.user.totpEnabled, isPlatformAdmin: row.user.isPlatformAdmin },
    organization: { id: org.id, name: org.name, slug: org.slug, smallBusiness: org.smallBusiness, state: org.state },
    billing,
    access,
    readOnly,
    support,
    mutating,
    role,
    can: (p) => effectiveCan(state, p),
  };
}

/** Weiterleitung bei fehlendem Recht: freundliche Erklärung im Nur-Lesen-/Support-Modus, sonst „kein Zugriff“. */
export function denyAccess(auth: AuthContext, permission?: Permission): never {
  if (auth.support && (!permission || !isReadPermission(permission))) redirect("/nur-lesen?grund=support");
  if (auth.readOnly && auth.mutating && (!permission || can(auth.role, permission))) redirect("/nur-lesen");
  redirect("/kein-zugriff");
}

/**
 * Für Seiten und Server Actions: erzwingt Login (und optional ein Recht).
 *
 * Nur-Lesen-Modus (Abo abgelaufen/überfällig): Bei SCHREIBENDEN Anfragen (Server Actions, POST-Routen)
 * gelten nur noch *.read-Rechte – requireAuth("x.write"/"x.manage"/"import.run") leitet auf /nur-lesen um.
 * Seitenaufrufe (GET) bleiben unverändert sichtbar; Lesen und Export sind nie gesperrt.
 * Ausnahme `allowReadOnly`: Aktionen, die zum Beheben nötig sind (Abo/Zahlung, Support-Freigabe).
 * requireAuth() ohne Recht (eigenes Passwort, 2FA) bleibt erlaubt.
 *
 * Support-Modus: nur *.read-Rechte (Scope „write“: zusätzlich Konfiguration); schreibende Anfragen
 * ohne Recht werden im Lesemodus ebenfalls abgelehnt.
 */
export async function requireAuth(permission?: Permission, opts: { allowReadOnly?: boolean } = {}): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!mutationAllowedWithoutPermission(auth)) denyAccess(auth, permission);
  if (permission && !auth.can(permission)) {
    const fixingSubscription = opts.allowReadOnly && auth.readOnly && !auth.support && can(auth.role, permission);
    if (!fixingSubscription) denyAccess(auth, permission);
  }
  return auth;
}
