import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { patients } from "@/db/schema";
import type { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { sequential } from "@/lib/seq";
import { therapists } from "@/server/appointments";
import { canCreateBlocks } from "@/server/calendar-blocks";
import { servicesByUsage } from "@/server/service-catalog";

/** Leistung in der Auswahl „Neuer Termin“ */
export type NewAppointmentService = { id: string; code: string; name: string; durationMin: number };

/**
 * Leistungen für „Neuer Termin“ (Seite und Fenster) – eine Stelle für die Reihenfolge: aktive Leistungen,
 * „häufig gebucht“ zuerst (gemeinsame Quelle mit der Rechnung, src/server/service-catalog.ts).
 */
export async function loadAppointmentServices(org: string, tx: Tx): Promise<NewAppointmentService[]> {
  return (await servicesByUsage(org, tx)).map((s) => ({ id: s.id, code: s.code, name: s.name, durationMin: s.durationMin }));
}

/** Daten für „Neuer Termin“ (Seite /kalender/neu und Fenster im Kalender) */
export async function newAppointmentData(auth: Awaited<ReturnType<typeof requireAuth>>) {
  const org = auth.organization.id;
  const [pts, svc] = await withOrg(org, (tx) =>
    sequential(
      () => tx.select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, org), isNull(patients.archivedAt))).orderBy(asc(patients.lastName)).limit(2000),
      () => loadAppointmentServices(org, tx),
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
