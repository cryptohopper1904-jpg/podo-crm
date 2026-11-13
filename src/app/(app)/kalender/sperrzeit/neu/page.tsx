import { PageHeader } from "@/components/ui";
import { denyAccess, requireAuth } from "@/lib/auth/session";
import { parseHhmm, toHhmm, toMin } from "@/lib/calendar-grid";
import { berlinDateIso } from "@/lib/format";
import { isValidIsoDate } from "@/lib/iso-date";
import { therapists } from "@/server/appointments";
import { canCreateBlocks, canManageBlocksFor } from "@/server/calendar-blocks";
import { NewEntrySwitch } from "../../calendar-blocks-view";
import { BlockForm } from "../block-form";

export const metadata = { title: "Sperrzeit eintragen" };

/** Neue Sperrzeit (Pause, Schulung, früher Feierabend, Wartung, Reinigung …) – Vorbelegung aus dem Kalender. */
export default async function NewBlockPage(props: PageProps<"/kalender/sperrzeit/neu">) {
  const auth = await requireAuth("appointments.write");
  if (!canCreateBlocks(auth)) denyAccess(auth, "users.manage");
  const sp = await props.searchParams;
  const team = (await therapists(auth)).sort((a, b) => a.name.localeCompare(b.name, "de"));
  // nur Personen, für die die angemeldete Person Sperrzeiten pflegen darf
  const people = team.filter((t) => canManageBlocksFor(auth, t.id)).map((t) => ({ id: t.id, name: t.name }));
  const allowPraxis = canManageBlocksFor(auth, null);
  const date = typeof sp.datum === "string" && isValidIsoDate(sp.datum) ? sp.datum : berlinDateIso();
  const start = parseHhmm(sp.zeit) ?? "12:00";
  const endMin = Math.min(24 * 60, toMin(start) + 30);
  const behandler = typeof sp.behandler === "string" && people.some((p) => p.id === sp.behandler) ? sp.behandler : null;
  const wd = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Sperrzeit eintragen" subtitle="Pause, Schulung, früher Feierabend, Wartung, Reinigung …" />
      <NewEntrySwitch active="sperrzeit" prefill={{ datum: date, zeit: parseHhmm(sp.zeit) ?? undefined, behandler: behandler ?? undefined }} />
      <BlockForm
        people={people}
        allowPraxis={allowPraxis}
        defaults={{
          userId: behandler ?? (people.some((p) => p.id === auth.user.id) ? auth.user.id : allowPraxis ? "praxis" : (people[0]?.id ?? "praxis")),
          kind: "pause",
          title: "",
          startsOn: date,
          endsOn: "",
          allDay: false,
          startTime: start,
          endTime: endMin >= 24 * 60 ? "23:55" : toHhmm(endMin),
          repeat: "none",
          weekdays: [wd],
          intervalWeeks: 1,
          note: "",
        }}
      />
      <p className="mt-4 text-xs text-muted">Mehrtägige Abwesenheiten (Urlaub, Krankheit) bitte weiterhin unter Team → Abwesenheiten eintragen.</p>
    </div>
  );
}
