import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users, type UserPrefs } from "@/db/schema";
import { CHANGELOG } from "@/content/changelog";
import { getAuth, getSession } from "@/lib/auth/session";
import { nextPrefs, selectLoginEntries, shouldOfferChangelog, type ChangelogSelection, type ChangelogViewer } from "@/lib/changelog";

/** Wer schaut gerade? (bestätigte Sitzung; im Support-Modus ohne Praxis-Rolle) */
export async function changelogViewer() {
  const row = await getSession();
  if (!row?.session.verified) return null;
  const auth = await getAuth();
  const support = !!auth?.support;
  const viewer: ChangelogViewer = { role: auth && !support ? auth.role : null, isPlatformAdmin: row.user.isPlatformAdmin };
  return { row, viewer, support, prefs: row.user.prefs?.changelog ?? {} };
}

/**
 * Setzt das Sitzungs-Flag atomar (nur wenn noch nicht gesetzt). true = diese Anfrage darf das Popup zeigen.
 * So erscheint es genau einmal je Anmeldung, auch bei parallelen Anfragen.
 */
export async function claimChangelogForSession(sessionId: string, now = new Date()): Promise<boolean> {
  const r = await db
    .update(sessions)
    .set({ changelogShownAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.changelogShownAt)))
    .returning({ id: sessions.id });
  return r.length > 0;
}

/** Für das App-Layout: Auswahl fürs Popup nach der Anmeldung (null = nichts zeigen). Setzt das Sitzungs-Flag. */
export async function loginChangelog(): Promise<ChangelogSelection | null> {
  const v = await changelogViewer();
  if (!v) return null;
  if (!shouldOfferChangelog({ verified: v.row.session.verified, changelogShownAt: v.row.session.changelogShownAt, support: v.support })) return null;
  const selection = selectLoginEntries(CHANGELOG, v.viewer, v.prefs);
  if (!selection) return null;
  return (await claimChangelogForSession(v.row.session.id)) ? selection : null;
}

/** Popup geschlossen: zuletzt gezeigten Eintrag merken, optional bis zur nächsten Neuerung stummschalten. */
export async function saveChangelogDismissal(userId: string, viewer: ChangelogViewer, shownId: string, mute: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ prefs: users.prefs }).from(users).where(eq(users.id, userId)).for("update").limit(1);
    if (!u) return false;
    const next = nextPrefs(u.prefs?.changelog ?? {}, shownId, mute, CHANGELOG, viewer);
    if (!next) return false;
    const prefs: UserPrefs = { ...(u.prefs ?? {}), changelog: next };
    await tx.update(users).set({ prefs }).where(eq(users.id, userId));
    return true;
  });
}
