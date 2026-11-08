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

