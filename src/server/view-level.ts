import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type UserPrefs } from "@/db/schema";
import { getSession } from "@/lib/auth/session";
import { viewLevelOf, type ViewLevel } from "@/lib/view-level";

/** Ansicht der angemeldeten Person (persönlich, auch im Support-Modus die eigene). Ohne Sitzung: Standard. */
export async function currentViewLevel(): Promise<ViewLevel> {
  const row = await getSession();
  return viewLevelOf(row?.user.prefs);
}

/** Speichert die Ansicht in users.prefs.view (übrige Einstellungen wie Neuigkeiten bleiben erhalten). */
export async function saveViewLevel(userId: string, level: ViewLevel): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!u) return false;
    const prefs: UserPrefs = { ...(u.prefs ?? {}), view: level };
    await tx.update(users).set({ prefs }).where(eq(users.id, userId));
    return true;
  });
}
