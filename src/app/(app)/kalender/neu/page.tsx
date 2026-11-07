import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients, services } from "@/db/schema";
import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { therapists } from "@/server/appointments";
import { sequential } from "@/lib/seq";
import { AppointmentForm } from "./appointment-form";

export const metadata = { title: "Neuer Termin" };

export default async function NewAppointmentPage(props: PageProps<"/kalender/neu">) {
  const auth = await requireAuth("appointments.write");
  const sp = await props.searchParams;
  const org = auth.organization.id;
  const [pts, svc] = await withOrg(org, (tx) =>
    sequential(
      () => tx.select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, org), isNull(patients.archivedAt))).orderBy(asc(patients.lastName)).limit(2000),
      () => tx.select({ id: services.id, code: services.code, name: services.name, durationMin: services.durationMin }).from(services).where(and(eq(services.organizationId, org), eq(services.active, true))).orderBy(asc(services.code)),
    ),
  );
  const team = await therapists(auth);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Neuer Termin" />
      <AppointmentForm
        patients={pts}
        services={svc}
        team={team}
        defaults={{ patientId: typeof sp.patient === "string" ? sp.patient : "", date: typeof sp.datum === "string" ? sp.datum : berlinDateIso(), therapistId: auth.user.id }}
      />
    </div>
  );
}
