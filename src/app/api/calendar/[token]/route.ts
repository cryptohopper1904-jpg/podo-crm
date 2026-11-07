import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db, withOrg } from "@/db";
import { appointments, appointmentServices, memberships, organizations, patients, services } from "@/db/schema";
import { verifyCalendarToken } from "@/lib/calendar-token";
import { buildIcs, initials, type IcsEvent } from "@/lib/ical";

/**
 * Persönlicher iCal-Feed (Termine der letzten 30 und nächsten 120 Tage).
 * Datenschutz: KEINE Patientennamen – nur Initialen und Leistungskürzel; keine Notizen.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/calendar/[token]">) {
  const { token } = await ctx.params;
  let userId: string | null = null;
  try {
    userId = verifyCalendarToken(token);
  } catch {
    userId = null;
  }
  if (!userId) return new NextResponse("Not found", { status: 404 });

  const orgs = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
  if (orgs.length === 0) return new NextResponse("Not found", { status: 404 });

  const from = new Date(Date.now() - 30 * 86400_000);
  const to = new Date(Date.now() + 120 * 86400_000);
  const events: IcsEvent[] = [];
  for (const org of orgs) {
    await withOrg(org.id, async (tx) => {
      const rows = await tx
        .select({ a: appointments, firstName: patients.firstName, lastName: patients.lastName })
        .from(appointments)
        .leftJoin(patients, eq(patients.id, appointments.patientId))
        .where(and(eq(appointments.organizationId, org.id), eq(appointments.therapistId, userId), gte(appointments.startsAt, from), lt(appointments.startsAt, to)));
      const ids = rows.map((r) => r.a.id);
      const svc = ids.length
        ? await tx
            .select({ appointmentId: appointmentServices.appointmentId, code: services.code })
            .from(appointmentServices)
            .innerJoin(services, eq(services.id, appointmentServices.serviceId))
            .where(and(eq(appointmentServices.organizationId, org.id), inArray(appointmentServices.appointmentId, ids)))
        : [];
      for (const r of rows) {
        const codes = svc.filter((s) => s.appointmentId === r.a.id).map((s) => s.code);
        const who = initials(r.firstName, r.lastName) || "Termin";
        events.push({
          uid: `${r.a.id}@podocrm`,
          start: r.a.startsAt,
          end: r.a.endsAt,
          summary: `${who}${codes.length ? ` · ${codes.join(", ")}` : ""}${r.a.homeVisit ? " · Hausbesuch" : ""}`,
          description: orgs.length > 1 ? org.name : undefined,
          status: r.a.status === "cancelled" ? "CANCELLED" : r.a.status === "planned" ? "TENTATIVE" : "CONFIRMED",
        });
      }
    });
  }
  return new NextResponse(buildIcs("PodoCRM Termine", events), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300" },
  });
}
