import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/session";
import { parseTiSettings, type TiSettings } from "@/lib/ti-checklist";
import { assertCan } from "./authz";

/** TI-Checkliste der Praxis (organizations.settings.ti). */
export async function loadTiSettings(auth: AuthContext): Promise<TiSettings> {
  assertCan(auth, "settings.manage");
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  return parseTiSettings((o?.settings as Record<string, unknown> | undefined)?.ti);
}

export async function saveTiSettings(auth: AuthContext, input: TiSettings): Promise<TiSettings> {
  assertCan(auth, "settings.manage");
  const clean = parseTiSettings({ ...input, updatedAt: new Date().toISOString() });
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('ti', ${JSON.stringify(clean)}::jsonb)` })
    .where(eq(organizations.id, auth.organization.id));
  await audit({
    organizationId: auth.organization.id,
    userId: auth.user.id,
    action: "settings.ti",
    meta: Object.fromEntries(Object.entries(clean.items).map(([k, v]) => [k, v.state])),
  });
  return clean;
}
