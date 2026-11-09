import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Card, CardTitle, LinkButton, PageHeader } from "@/components/ui";
import { withOrg } from "@/db";
import { appointments, calendarFeedEvents, calendarFeeds, patients } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateDe, timeDe } from "@/lib/format";
import { AssignForm } from "./assign-form";

export const metadata = { title: "Kund:in zuordnen" };

/** Importierter Termin (Kalender-Abo) → Kund:in. Zuordnung nur manuell, nie automatisch. */
export default async function AssignFeedAppointmentPage(props: PageProps<"/kalender/zuordnen/[id]">) {
  const auth = await requireAuth("appointments.write");
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [row] = await tx
      .select({ a: appointments, feedLabel: calendarFeeds.label })
      .from(appointments)
      .innerJoin(calendarFeedEvents, and(eq(calendarFeedEvents.organizationId, org), eq(calendarFeedEvents.appointmentId, appointments.id)))
      .innerJoin(calendarFeeds, eq(calendarFeeds.id, calendarFeedEvents.feedId))
      .where(and(eq(appointments.organizationId, org), eq(appointments.id, id)));
    if (!row) return null;
    const pts = await tx
      .select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.organizationId, org), isNull(patients.archivedAt)))
      .orderBy(asc(patients.lastName))
      .limit(2000);
    return { ...row, pts };
  });
  if (!data) notFound();
  const { a } = data;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Kund:in zuordnen" subtitle={`aus Kalender-Abo „${data.feedLabel}“`} actions={<LinkButton variant="secondary" href={`/kalender?datum=${berlinDateIso(a.startsAt)}`}>Zurück zum Kalender</LinkButton>} />
      <Card className="mb-4">
        <CardTitle>{a.title ?? "(ohne Titel)"}</CardTitle>
        <p className="text-sm">{dateDe(a.startsAt)}, {timeDe(a.startsAt)}–{timeDe(a.endsAt)}</p>
        {a.notes ? <p className="mt-2 whitespace-pre-line text-sm text-muted">{a.notes}</p> : null}
      </Card>
      <Card>
        <p className="mb-4 text-sm text-muted">
          PodoHero ordnet Termine aus dem Kalender-Abo <strong>nie automatisch</strong> zu – auch nicht bei gleichem Namen. Bitte die richtige
          Kund:in prüfen (z. B. Geburtsdatum in Doctolib) und hier auswählen. Uhrzeit und Titel bleiben weiterhin mit dem Kalender abgeglichen.
        </p>
        {a.patientId ? <p className="mb-4 text-sm font-semibold">Bereits zugeordnet – eine neue Auswahl ersetzt die Zuordnung.</p> : null}
        <AssignForm appointmentId={a.id} patients={data.pts} />
      </Card>
    </div>
  );
}
