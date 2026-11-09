/**
 * Auswahl der Neuigkeiten für das Popup nach der Anmeldung (rein, ohne DB – getestet in changelog.test.ts).
 *
 * Regeln (Wunsch: „bei jedem Login ein Popup mit Changelog“):
 *  - Zielgruppe: "platform" nur für Plattform-Admins, "owner" nur für Inhaber:innen, sonst alle.
 *  - Ungesehene Einträge (id > seenId) → bis zu `max` davon, neueste zuerst.
 *  - Alles gesehen → trotzdem den neuesten Eintrag zeigen, außer die Person hat
 *    „Bis zur nächsten Neuerung nicht mehr anzeigen“ für genau diesen (oder einen neueren) Eintrag gewählt.
 *  - Einmal je Anmeldung (Flag sessions.changelog_shown_at), nie im Support-Modus, nie vor bestätigter 2FA.
 */
import type { ChangelogEntry } from "@/content/changelog";
import type { Role } from "@/lib/auth/permissions";

export type ChangelogViewer = { role: Role | null; isPlatformAdmin: boolean };
export type ChangelogPrefs = { seenId?: string; mutedId?: string };
export type ChangelogSelection = { mode: "neu" | "wiederholung"; entries: ChangelogEntry[] };

const newestFirst = (a: ChangelogEntry, b: ChangelogEntry) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function canSee(entry: ChangelogEntry, viewer: ChangelogViewer): boolean {
  const audience = entry.audience ?? "all";
  if (audience === "platform") return viewer.isPlatformAdmin;
  if (audience === "owner") return viewer.role === "owner";
  return true;
}

export function visibleEntries(entries: readonly ChangelogEntry[], viewer: ChangelogViewer): ChangelogEntry[] {
  return entries.filter((e) => canSee(e, viewer)).sort(newestFirst);
}

export function selectLoginEntries(
  entries: readonly ChangelogEntry[],
  viewer: ChangelogViewer,
  prefs: ChangelogPrefs = {},
  max = 3,
): ChangelogSelection | null {
  const visible = visibleEntries(entries, viewer);
  const latest = visible[0];
  if (!latest) return null;
  const unseen = prefs.seenId ? visible.filter((e) => e.id > prefs.seenId!) : visible;
  if (unseen.length) return { mode: "neu", entries: unseen.slice(0, Math.max(1, max)) };
  if (prefs.mutedId && prefs.mutedId >= latest.id) return null;
  return { mode: "wiederholung", entries: [latest] };
}

/** Popup in dieser Sitzung anbieten? (Flag noch nicht gesetzt, 2FA bestätigt, kein Support-Modus) */
export function shouldOfferChangelog(s: { verified: boolean; changelogShownAt: Date | null; support: boolean }): boolean {
  return s.verified && !s.support && s.changelogShownAt === null;
}

/**
 * Neue Einstellungen nach dem Schließen: seenId/mutedId nur vorwärts, nur gültige (sichtbare) ids.
 * `shownId` = neuester Eintrag, der im Popup stand.
 */
export function nextPrefs(
  prev: ChangelogPrefs,
  shownId: string,
  mute: boolean,
  entries: readonly ChangelogEntry[],
  viewer: ChangelogViewer,
): ChangelogPrefs | null {
  if (!visibleEntries(entries, viewer).some((e) => e.id === shownId)) return null;
  const max = (a: string | undefined, b: string) => (a && a > b ? a : b);
  const out: ChangelogPrefs = { ...prev, seenId: max(prev.seenId, shownId) };
  if (mute) out.mutedId = max(prev.mutedId, shownId);
  return out;
}

const TAG_LABELS = { neu: "Neu", verbessert: "Verbessert", behoben: "Behoben" } as const;
export const tagLabel = (t: keyof typeof TAG_LABELS) => TAG_LABELS[t];

export function formatChangelogDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
