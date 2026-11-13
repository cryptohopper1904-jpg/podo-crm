import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type UserPrefs } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { catalogViewOf, type CatalogKey, type CatalogView } from "@/lib/catalog";

/** Gemerkte Katalog-Darstellung der angemeldeten Person (Standard: Kacheln) */
export async function currentCatalogView(key: CatalogKey): Promise<CatalogView> {
  const row = await getSession();
  return catalogViewOf(row?.user.prefs, key);
}

/** Speichert die Darstellung in users.prefs.catalog[key] (übrige Einstellungen bleiben erhalten). */
export async function saveCatalogView(userId: string, key: CatalogKey, view: CatalogView): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!u) return false;
    const prefs: UserPrefs = { ...(u.prefs ?? {}), catalog: { ...(u.prefs?.catalog ?? {}), [key]: view } };
    await tx.update(users).set({ prefs }).where(eq(users.id, userId));
    return true;
  });
}
