import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { patients } from "@/db/schema";
import { servicesByUsage } from "@/server/service-catalog";
import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { therapists } from "@/server/appointments";
import { sequential } from "@/lib/seq";
import { parseHhmm } from "@/lib/calendar-grid";
import { AppointmentForm } from "./appointment-form";
import { NewEntrySwitch } from "../calendar-blocks-view";
import { canCreateBlocks } from "@/server/calendar-blocks";

export const metadata = { title: "Neuer Termin" };

export default async function NewAppointmentPage(props: PageProps<"/kalender/neu">) {
  const auth = await requireAuth("appointments.write");
  const sp = await props.searchParams;
  const org = auth.organization.id;
  const [pts, svc] = await withOrg(org, (tx) =>
    sequential(
      () => tx.select({ id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName }).from(patients).where(and(eq(patients.organizationId, org), isNull(patients.archivedAt))).orderBy(asc(patients.lastName)).limit(2000),
      // „häufig gebucht“ zuerst (gemeinsame Quelle mit Termin-Dialog und Rechnung, src/server/service-catalog.ts)
      async () => (await servicesByUsage(org, tx)).map((s) => ({ id: s.id, code: s.code, name: s.name, durationMin: s.durationMin })),
    ),
  );
  const team = await therapists(auth);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Neuer Termin" />
      {canCreateBlocks(auth) ? (
        <NewEntrySwitch
          active="termin"
          prefill={{
            datum: typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? sp.datum : undefined,
            zeit: parseHhmm(sp.zeit) ?? undefined,
            behandler: typeof sp.behandler === "string" && team.some((t) => t.id === sp.behandler) ? sp.behandler : undefined,
          }}
        />
      ) : null}
      <AppointmentForm
        cancelHref={`/kalender${typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? `?datum=${sp.datum}` : ""}`}
        blocksTab={canCreateBlocks(auth)}
        patients={pts}
        services={svc}
        team={team}
        defaults={{
          patientId: typeof sp.patient === "string" ? sp.patient : "",
          date: typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? sp.datum : berlinDateIso(),
          // Vorbelegung aus dem Kalender (Klick auf freien Slot): Uhrzeit und Behandler:in-Spalte
          time: parseHhmm(sp.zeit) ?? "09:00",
          therapistId: typeof sp.behandler === "string" && team.some((t) => t.id === sp.behandler) ? sp.behandler : team.some((t) => t.id === auth.user.id) ? auth.user.id : (team[0]?.id ?? ""),
          durationMin: typeof sp.dauer === "string" && /^\d{1,3}$/.test(sp.dauer) && Number(sp.dauer) >= 5 && Number(sp.dauer) <= 480 ? Number(sp.dauer) : 30,
          serviceIds: typeof sp.leistung === "string" && svc.some((s) => s.id === sp.leistung) ? [sp.leistung] : [],
          todayIso: berlinDateIso(),
        }}
      />
    </div>
  );
}
