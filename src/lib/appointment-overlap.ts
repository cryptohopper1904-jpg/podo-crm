/**
 * Überschneidungen für die Anzeige (Kalender, /heute): Termine derselben Behandler:in, die sich zeitlich
 * überlappen, wenn mindestens einer aus einem Kalender-Abo stammt. Abgesagte Termine zählen nicht.
 */
export type OverlapInput = {
  a: { id: string; startsAt: Date; endsAt: Date; status: string; therapistId?: string | null };
  feed?: unknown;
};

export function feedOverlapIds(rows: readonly OverlapInput[]): Set<string> {
  const out = new Set<string>();
  const live = rows.filter((r) => r.a.status !== "cancelled" && r.a.therapistId);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const x = live[i], y = live[j];
      if (!x.feed && !y.feed) continue;
      if (x.a.therapistId !== y.a.therapistId) continue;
      if (x.a.startsAt < y.a.endsAt && y.a.startsAt < x.a.endsAt) {
        out.add(x.a.id);
        out.add(y.a.id);
      }
    }
  }
  return out;
}
