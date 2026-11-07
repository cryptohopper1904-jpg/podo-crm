import "server-only";
import { berlinToUtc, timeDe } from "@/lib/format";

/** Freie Startzeiten (HH:MM) für die Online-Buchung; mind. 15 Min Puffer zwischen Terminen. */
export function freeSlotsPublic(
  busy: { startsAt: Date; endsAt: Date }[],
  dayIso: string,
  durationMin: number,
  opening: { from: string; to: string } = { from: "08:00", to: "18:00" },
) {
  const start = berlinToUtc(dayIso, opening.from).getTime();
  const end = berlinToUtc(dayIso, opening.to).getTime();
  const out: string[] = [];
  const buffer = 15 * 60_000;
  for (let t = start; t + durationMin * 60_000 <= end; t += 30 * 60_000) {
    const s = t - buffer, e = t + durationMin * 60_000 + buffer;
    if (!busy.some((b) => b.startsAt.getTime() < e && b.endsAt.getTime() > s)) out.push(timeDe(new Date(t)));
  }
  return out;
}
