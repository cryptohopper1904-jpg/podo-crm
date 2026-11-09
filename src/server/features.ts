import "server-only";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { audit } from "@/lib/audit";
import { KIM_CONNECTION_PROVIDER } from "@/integrations/kim/provider";
import type { AuthContext } from "@/lib/auth/session";
import { billingModeOf, feature, hiddenAreaRedirect, type BillingMode, type GkvArea } from "@/lib/features";
import { loadConnection } from "./integrations";

/**
 * Seiten-Sperre für ausgeblendete Kassen-Bereiche (src/lib/features.ts): Direktaufruf → /heute mit Hinweis.
 * Aktionen prüfen zusätzlich serverseitig mit `gkvGuard()`.
 */
export function requireFeature(auth: AuthContext, area: GkvArea): void {
  if (!feature(auth.organization, area)) redirect(hiddenAreaRedirect(area));
}

/** KIM schon eingerichtet? (dann bleibt bei „nur Privat“ ein kleiner Hinweis unter TI & KIM sichtbar) */
export async function kimConnected(organizationId: string): Promise<boolean> {
  const c = await loadConnection(organizationId, KIM_CONNECTION_PROVIDER);
  return !!c && c.status !== "disconnected";
}

/** Einstellungs-Tabs, die für diese Praxis ausgeblendet werden. */
export async function hiddenSettingsTabs(auth: AuthContext): Promise<string[]> {
  if (feature(auth.organization, "gkv")) return [];
  return (await kimConnected(auth.organization.id)) ? ["ocr"] : ["ocr", "ti"];
}

/**
 * Praxis-Modus setzen (organizations.settings.billingMode) – nur über requireAuth("settings.manage") aufrufen.
 * Ändert nur den Schalter, nie Daten; protokolliert die Änderung im Zugriffsprotokoll.
 */
export async function setBillingMode(auth: AuthContext, mode: BillingMode, source: "settings" | "onboarding"): Promise<{ changed: boolean }> {
  const org = auth.organization.id;
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const from = billingModeOf(o?.settings);
  const isSet = !!o && Object.hasOwn(o.settings ?? {}, "billingMode");
  if (from === mode && isSet) return { changed: false };
  await db
    .update(organizations)
    .set({ settings: sql`coalesce(${organizations.settings}, '{}'::jsonb) || jsonb_build_object('billingMode', ${mode}::text)` })
    .where(eq(organizations.id, org));
  await audit({ organizationId: org, userId: auth.user.id, action: "settings.billing_mode", entity: "organization", entityId: org, meta: { from, to: mode, source } });
  return { changed: from !== mode };
}
