import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { auditLog, memberships, organizations, sessions, supportGrants, users } from "@/db/schema";
import { accessMode, type AccessInfo, type OrgBilling } from "@/lib/plans";
import { billingModeOf, type BillingMode } from "@/lib/features";
import { effectiveCan, isReadPermission, mutationAllowedWithoutPermission, pickActiveGrant, type SupportContext } from "./access";
import { can, type Permission, type Role } from "./permissions";
import { clientIpFrom } from "./client-ip";
import { acceptedSessionCookieNames, readSessionToken, sessionCookieName, sessionCookieOptions } from "./cookie";
import { createSupportViewLog } from "./support-view";
import { TWO_FACTOR_SETUP_PATH, twoFactorPending } from "./two-factor";

/** Name des Sitzungs-Cookies in dieser Umgebung (Produktion: __Host-podo_session), siehe ./cookie.ts */
export const SESSION_COOKIE = sessionCookieName();
const SESSION_HOURS = 12;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export async function requestMeta() {
  const h = await headers();
  return {
    // Nur so viele X-Forwarded-For-Einträge von rechts, wie Proxys vertraut wird (TRUSTED_PROXY_HOPS, docs/BETRIEB.md)
    ip: clientIpFrom(h.get("x-forwarded-for"), h.get("x-real-ip")),
    userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
  };
}

const newToken = () => randomBytes(32).toString("base64url");

async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(sessionCookieName(), token, sessionCookieOptions(expiresAt));
}

export async function createSession(userId: string, organizationId: string | null, verified: boolean) {
  const token = newToken();
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
  await setSessionCookie(token, expiresAt);
}

/**
 * Neues Token beim Wechsel der Praxis (eigene Praxis, Support betreten/verlassen): alte Zeile löschen,
 * neue mit gleichem Bestätigungs-Status (2FA) und gleichem Ablauf anlegen (kein Verlängern durch Wechseln).
 * Das alte Token ist danach wertlos. false, wenn die Sitzung nicht (mehr) existiert oder fremd ist.
 */
export async function rotateSession(sessionId: string, userId: string, organizationId: string | null): Promise<boolean> {
  const token = newToken();
  const meta = await requestMeta().catch(() => ({ ip: null, userAgent: null }));
  const created = await db.transaction(async (tx) => {
    const [old] = await tx
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .returning();
    if (!old) return null;
    await tx.insert(sessions).values({
      id: sha256(token),
      userId,
      organizationId,
      verified: old.verified,
      totpFailures: old.totpFailures,
      expiresAt: old.expiresAt,
      ip: meta.ip ?? old.ip,
      userAgent: meta.userAgent ?? old.userAgent,
    });
    return old;
  });
  if (!created) return false;
  await setSessionCookie(token, created.expiresAt);
  return true;
}

/**
 * Entzug: alle Sitzungen einer Person löschen (optional nur die einer Praxis bzw. außer der aktuellen).
 * Aufgerufen bei 2FA-Sperre (das Passwort war bekannt), Deaktivierung der Mitgliedschaft und Passwortwechsel.
 * NICHT bei Passwort-Fehlversuchen – sonst könnte ein Angreifer die echte Person ausloggen (DoS).
 */
export async function revokeUserSessions(userId: string, opts: { organizationId?: string; exceptSessionId?: string } = {}): Promise<number> {
  const conds = [eq(sessions.userId, userId)];
  if (opts.organizationId) conds.push(eq(sessions.organizationId, opts.organizationId));
  if (opts.exceptSessionId) conds.push(ne(sessions.id, opts.exceptSessionId));
  const gone = await db.delete(sessions).where(and(...conds)).returning({ id: sessions.id });
  return gone.length;
}

export async function destroySession() {
  const jar = await cookies();
  const token = readSessionToken(jar);
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  // __Host-Cookies lassen sich nur mit denselben Attributen (Secure, Path=/) löschen
  for (const name of acceptedSessionCookieNames()) if (jar.get(name)) jar.set(name, "", { ...sessionCookieOptions(new Date(0)), maxAge: 0 });
}

/** Nach erfolgreicher 2FA: alte Sitzung verwerfen und ein NEUES Token ausgeben (Session-Fixation). */
export async function markSessionVerified() {
  const jar = await cookies();
  const token = readSessionToken(jar);
  if (!token) return;
  const [old] = await db.delete(sessions).where(eq(sessions.id, sha256(token))).returning();
  if (old) await createSession(old.userId, old.organizationId, true);
}

/** Liest die Sitzung (gecacht pro Request). Gibt null zurück, wenn keine gültige Sitzung existiert. */
export const getSession = cache(async () => {
  const jar = await cookies();
  const token = readSessionToken(jar);
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
  /** billingMode: Praxis-Modus aus settings.billingMode (src/lib/features.ts); fehlt → mit Kassenzulassung */
  organization: { id: string; name: string; slug: string; smallBusiness: boolean; state: string; billingMode?: BillingMode };
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

/** Entprellung der support.view-Einträge (je Freigabe + Pfad höchstens 1× je 60 s), siehe ./support-view.ts */
const supportViews = createSupportViewLog();

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

/**
 * Ergebnis der Anmeldeprüfung: `auth` = Praxis-Zugriff; `twoFactorSetupRequired` = bestätigte Sitzung, aber die
 * Pflicht-2FA (Inhaber:in, Plattform-Admin, ggf. alle Rollen der Praxis – ./two-factor.ts) ist noch nicht aktiv.
 * Dann gibt es KEINEN Praxis-Zugriff (auch nicht für Route-Handler), Seiten leiten zur 2FA-Einrichtung.
 */
export type AuthState = { auth: AuthContext | null; twoFactorSetupRequired: boolean };
const NONE: AuthState = { auth: null, twoFactorSetupRequired: false };
const PENDING_2FA: AuthState = { auth: null, twoFactorSetupRequired: true };

export const getAuth = cache(async (): Promise<AuthContext | null> => (await getAuthState()).auth);

export const getAuthState = cache(async (): Promise<AuthState> => {
  const row = await getSession();
  if (!row || !row.session.verified) return NONE;
  if (!row.session.organizationId) return row.user.isPlatformAdmin && !row.user.totpEnabled ? PENDING_2FA : NONE;
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
    if (twoFactorPending({ totpEnabled: row.user.totpEnabled, role: m.membership.role as Role, isPlatformAdmin: row.user.isPlatformAdmin, orgSettings: m.org.settings })) return PENDING_2FA;
    org = m.org;
    role = m.membership.role as Role;
  } else {
    // Keine Mitgliedschaft: nur Plattform-Admin MIT 2FA und gültiger Freigabe der Praxis (Break-Glass)
    const grant = row.user.isPlatformAdmin && row.user.totpEnabled ? await findActiveSupportGrant(orgId, row.user.id) : null;
    const [o] = grant ? await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1) : [];
    if (!grant || !o) {
      if (!row.user.isPlatformAdmin) return NONE;
      // Freigabe abgelaufen/widerrufen: zurück in die eigene Praxis (falls vorhanden)
      const [own] = await db
        .select({ organizationId: memberships.organizationId })
        .from(memberships)
        .where(and(eq(memberships.userId, row.user.id), eq(memberships.active, true)))
        .limit(1);
      await db.update(sessions).set({ organizationId: own?.organizationId ?? null }).where(eq(sessions.id, row.session.id));
      await db.insert(auditLog).values({ organizationId: orgId, userId: row.user.id, action: "support.ended", meta: { reason: "keine gültige Freigabe (abgelaufen, widerrufen oder nie erteilt)" }, ip: row.session.ip });
      if (!own) return row.user.totpEnabled ? NONE : PENDING_2FA;
      return loadOwn(row, own.organizationId, req);
    }
    org = o;
    role = "owner"; // nur für Anzeige; die Rechte begrenzt effectiveCan()
    support = grant;
    // Seitenansichten, Downloads und jede schreibende Anfrage im Support-Modus → Audit-Log der Praxis
    // (ohne Ausnahme nach Client-Headern; derselbe Pfad je Freigabe höchstens einmal pro Minute)
    if (supportViews.shouldLog(grant.grantId, req)) {
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
  }
  return { auth: build(row, org, role, support, req.mutating), twoFactorSetupRequired: false };
});

type SessionRow = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function loadOwn(row: SessionRow, orgId: string, req: { mutating: boolean }): Promise<AuthState> {
  const [m] = await db
    .select({ membership: memberships, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, row.user.id), eq(memberships.organizationId, orgId), eq(memberships.active, true)))
    .limit(1);
  if (!m) return NONE;
  if (twoFactorPending({ totpEnabled: row.user.totpEnabled, role: m.membership.role as Role, isPlatformAdmin: row.user.isPlatformAdmin, orgSettings: m.org.settings })) return PENDING_2FA;
  return { auth: build(row, m.org, m.membership.role as Role, null, req.mutating), twoFactorSetupRequired: false };
}

function build(row: SessionRow, org: typeof organizations.$inferSelect, role: Role, support: SupportContext | null, mutating: boolean): AuthContext {
  const billing = billingOf(org);
  const access = accessMode(billing);
  const readOnly = access.mode === "readonly";
  const state = { role, readOnly, mutating, support };
  return {
    sessionId: row.session.id,
    user: { id: row.user.id, email: row.user.email, name: row.user.name, totpEnabled: row.user.totpEnabled, isPlatformAdmin: row.user.isPlatformAdmin },
    organization: { id: org.id, name: org.name, slug: org.slug, smallBusiness: org.smallBusiness, state: org.state, billingMode: billingModeOf(org.settings) },
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
  const { auth, twoFactorSetupRequired } = await getAuthState();
  if (!auth) redirect(twoFactorSetupRequired ? TWO_FACTOR_SETUP_PATH : "/login");
  if (!mutationAllowedWithoutPermission(auth)) denyAccess(auth, permission);
  if (permission && !auth.can(permission)) {
    const fixingSubscription = opts.allowReadOnly && auth.readOnly && !auth.support && can(auth.role, permission);
    if (!fixingSubscription) denyAccess(auth, permission);
  }
  return auth;
}
