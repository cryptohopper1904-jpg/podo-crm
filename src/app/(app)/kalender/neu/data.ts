import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients, services } from "@/db/schema";
import type { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { sequential } from "@/lib/seq";
import { therapists } from "@/server/appointments";
import { canCreateBlocks } from "@/server/calendar-blocks";

/** Daten für „Neuer Termin“ (Seite /kalender/neu und Fenster im Kalender) */
export async function newAppointmentData(auth: Awaited<ReturnType<typeof requireAuth>>) {
  const org = auth.organization.id;
  const [pts, svc] = await withOrg(org, (tx) =>
    sequential(
      () => tx.select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, org), isNull(patients.archivedAt))).orderBy(asc(patients.lastName)).limit(2000),
      () => tx.select({ id: services.id, code: services.code, name: services.name, durationMin: services.durationMin }).from(services).where(and(eq(services.organizationId, org), eq(services.active, true))).orderBy(asc(services.code)),
    ),
  );
  const team = (await therapists(auth)).map((t) => ({ id: t.id, name: t.name }));
  return {
    patients: pts,
    services: svc,
    team,
    todayIso: berlinDateIso(),
    /** eigene Spalte, sonst erste Behandler:in */
    defaultTherapistId: team.some((t) => t.id === auth.user.id) ? auth.user.id : (team[0]?.id ?? ""),
    blocksTab: canCreateBlocks(auth),
    canCreatePatients: auth.can("patients.write"),
  };
}
export type NewAppointmentData = Awaited<ReturnType<typeof newAppointmentData>>;
