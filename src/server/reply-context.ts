import "server-only";
import { and, asc, eq, gt, gte, lt, ne } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, organizations } from "@/db/schema";
import { isoWeekday } from "@/lib/availability";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { hoursOnWeekday, practiceHours } from "@/lib/opening-hours";
import { berlinDateIso, berlinToUtc, dateTimeDe, weekdayLong, timeDe } from "@/lib/format";
import { freeSlots } from "./appointments";

/**
 * Fakten für KI-Antwortvorschläge: freie Termine der nächsten Öffnungstage (Öffnungszeiten der Praxis je
 * Wochentag, ohne Feiertage) und der nächste Termin der Person.
 * Bewusst ohne medizinische Inhalte.
 */
export async function replyFacts(organizationId: string, patientId: string | null, opts: { days?: number; durationMin?: number; maxSlots?: number } = {}) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  const week = practiceHours(org?.settings);
  const state = (org?.state ?? "BB") as StateCode;
  const duration = opts.durationMin ?? 40;
  const facts: string[] = [];
  const offered: string[] = [];

  await withOrg(organizationId, async (tx) => {
    const now = new Date();
    for (let i = 1, checked = 0; checked < (opts.days ?? 5) && i < 14; i++) {
      const day = berlinDateIso(new Date(now.getTime() + i * 86400_000));
      const ranges = hoursOnWeekday(week, isoWeekday(day));
      if (!ranges.length || holidayOn(day, state)) continue;
      checked++;
      const from = berlinToUtc(day, "00:00");
      const to = new Date(from.getTime() + 86400_000);
      const busy = await tx
        .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
        .from(appointments)
        .where(and(eq(appointments.organizationId, organizationId), ne(appointments.status, "cancelled"), gte(appointments.startsAt, from), lt(appointments.startsAt, to)));
      // je Tag höchstens zwei Vorschläge, auf volle halbe Stunden
      const slots = ranges.flatMap((r) => freeSlots(busy, day, duration, { from: r.start, to: r.end }, 30)).slice(0, 2);
      for (const s of slots) offered.push(`${weekdayLong(s)} um ${timeDe(s)} Uhr`);
      if (offered.length >= (opts.maxSlots ?? 6)) break;
    }
    if (patientId) {
      const [next] = await tx
        .select({ startsAt: appointments.startsAt })
        .from(appointments)
        .where(and(eq(appointments.organizationId, organizationId), eq(appointments.patientId, patientId), gt(appointments.startsAt, now), ne(appointments.status, "cancelled")))
        .orderBy(asc(appointments.startsAt))
        .limit(1);
      facts.push(next ? `Nächster gebuchter Termin der Person: ${dateTimeDe(next.startsAt)} Uhr.` : "Die Person hat derzeit keinen gebuchten Termin.");
    }
  });
  if (offered.length) facts.push(`Freie Termine (nur diese anbieten): ${offered.join("; ")}.`);
  else facts.push("In den nächsten Tagen sind keine freien Termine verfügbar – Rückruf anbieten.");
  return { facts, practiceName: org?.name ?? "Ihre Podologie-Praxis" };
}
