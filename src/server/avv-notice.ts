import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/session";
import { avvAcceptedAtLeast, storedLegalAcceptance } from "@/lib/legal";

/**
 * Hinweis „AVV aktualisiert“ (src/app/(app)/einstellungen/avv-banner.tsx) – nur für die Inhaber:in, nicht per
 * Support-Freigabe, solange die aktuelle AVV-Version nicht akzeptiert ist. Ergebnis: bisher akzeptierte Version (oder
 * null, wenn keine), undefined = kein Hinweis. Genutzt in Einstellungen (Layout) und auf „Heute“.
 */
export async function pendingAvvPrevious(auth: AuthContext): Promise<string | null | undefined> {
  if (auth.role !== "owner" || auth.support) return undefined;
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, auth.organization.id));
  if (avvAcceptedAtLeast(o?.settings)) return undefined;
  return storedLegalAcceptance(o?.settings)?.avv ?? null;
}
