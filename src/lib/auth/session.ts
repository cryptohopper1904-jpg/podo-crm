import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { memberships, organizations, sessions, users } from "@/db/schema";
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
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
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

export async function markSessionVerified() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.update(sessions).set({ verified: true }).where(eq(sessions.id, sha256(token)));
}

export type AuthContext = {
  sessionId: string;
  user: { id: string; email: string; name: string; totpEnabled: boolean };
  organization: { id: string; name: string; slug: string; smallBusiness: boolean; state: string };
  role: Role;
  can: (p: Permission) => boolean;
};

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

export const getAuth = cache(async (): Promise<AuthContext | null> => {
  const row = await getSession();
  if (!row || !row.session.verified || !row.session.organizationId) return null;
  const [m] = await db
    .select({ membership: memberships, org: organizations })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.userId, row.user.id),
        eq(memberships.organizationId, row.session.organizationId),
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  if (!m) return null;
  const role = m.membership.role as Role;
  return {
    sessionId: row.session.id,
    user: { id: row.user.id, email: row.user.email, name: row.user.name, totpEnabled: row.user.totpEnabled },
    organization: {
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      smallBusiness: m.org.smallBusiness,
      state: m.org.state,
    },
    role,
    can: (p) => can(role, p),
  };
});

/** Für Seiten und Server Actions: erzwingt Login (und optional ein Recht). */
export async function requireAuth(permission?: Permission): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (permission && !auth.can(permission)) redirect("/kein-zugriff");
  return auth;
}
