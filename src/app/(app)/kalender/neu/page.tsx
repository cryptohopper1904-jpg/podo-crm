import { PageHeader } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso } from "@/lib/format";
import { newAppointmentData } from "./data";
import { parseHhmm } from "@/lib/calendar-grid";
import { AppointmentForm } from "./appointment-form";
import { NewEntrySwitch } from "../calendar-blocks-view";
import { canCreateBlocks } from "@/server/calendar-blocks";

export const metadata = { title: "Neuer Termin" };

export default async function NewAppointmentPage(props: PageProps<"/kalender/neu">) {
  const auth = await requireAuth("appointments.write");
  const sp = await props.searchParams;
  const { patients: pts, services: svc, team, defaultTherapistId, canCreatePatients } = await newAppointmentData(auth);
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
        canCreatePatients={canCreatePatients}
        patients={pts}
        services={svc}
        team={team}
        defaults={{
          patientId: typeof sp.patient === "string" ? sp.patient : "",
          date: typeof sp.datum === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.datum) ? sp.datum : berlinDateIso(),
          // Vorbelegung aus dem Kalender (Klick auf freien Slot): Uhrzeit und Behandler:in-Spalte
          time: parseHhmm(sp.zeit) ?? "09:00",
          therapistId: typeof sp.behandler === "string" && team.some((t) => t.id === sp.behandler) ? sp.behandler : defaultTherapistId,
          durationMin: typeof sp.dauer === "string" && /^\d{1,3}$/.test(sp.dauer) && Number(sp.dauer) >= 5 && Number(sp.dauer) <= 480 ? Number(sp.dauer) : 30,
          serviceIds: typeof sp.leistung === "string" && svc.some((s) => s.id === sp.leistung) ? [sp.leistung] : [],
          todayIso: berlinDateIso(),
        }}
      />
    </div>
  );
}
