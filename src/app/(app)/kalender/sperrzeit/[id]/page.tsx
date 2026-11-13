import { notFound } from "next/navigation";
import { Ban } from "lucide-react";
import { BackLink, Badge, Card, CardTitle, pageTitleBox, pageTitleCls } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { BLOCK_KIND_LABELS, blockLabel, describeRepeat, occursOn, type BlockKind, type BlockRepeat } from "@/lib/calendar-blocks";
import { isValidIsoDate } from "@/lib/iso-date";
import { therapists } from "@/server/appointments";
import { canManageBlocksFor, getBlock } from "@/server/calendar-blocks";
import { BlockForm } from "../block-form";
import { DeleteBlockForm } from "../delete-block-form";

export const metadata = { title: "Sperrzeit" };

const de = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Sperrzeit ansehen, ändern und löschen (bei Serien: nur dieses Vorkommen oder ganze Serie). */
export default async function BlockPage(props: PageProps<"/kalender/sperrzeit/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("appointments.read");
  const b = await getBlock(auth, id);
  if (!b) notFound();
  const series = b.repeat !== "none";
  // angeklicktes Vorkommen (aus dem Kalender); sonst erstes Datum der Regel
  const occurrence = typeof sp.datum === "string" && isValidIsoDate(sp.datum) && occursOn(b, sp.datum) ? sp.datum : b.startsOn;
  const canEdit = canManageBlocksFor(auth, b.userId);
  const team = canEdit ? (await therapists(auth)).sort((a, c) => a.name.localeCompare(c.name, "de")) : [];
  const people = team.filter((t) => canManageBlocksFor(auth, t.id)).map((t) => ({ id: t.id, name: t.name }));
  // Person nicht mehr aktiv (oder ohne eigenen Kalender): als Auswahl behalten, sonst würde die Sperrzeit beim Speichern still umgehängt
  if (b.userId && !people.some((p) => p.id === b.userId)) people.unshift({ id: b.userId, name: `${b.personName ?? "Person"} (nicht mehr aktiv)` });
  const time = b.allDay ? "ganztägig" : `${b.startTime}–${b.endTime} Uhr`;

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div className={pageTitleBox}>
          <BackLink href={`/kalender?datum=${occurrence}`} label="Kalender" />
          <p className="text-sm text-muted">Sperrzeit · {series ? `Vorkommen am ${de(occurrence)}` : de(b.startsOn)} · {time}</p>
          <h1 className={`flex items-center gap-2 ${pageTitleCls}`}>
            <Ban size={26} className="shrink-0 text-muted" aria-hidden /> {blockLabel(b)}
          </h1>
        </div>
        <Badge tone="neutral">{BLOCK_KIND_LABELS[b.kind as BlockKind] ?? b.kind}</Badge>
        {series ? <Badge tone="info">Serie</Badge> : null}
      </header>

      <Card className="mb-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Für</dt>
            <dd className="mt-1">{b.userId ? (b.personName ?? "–") : "Ganze Praxis (alle Behandler:innen)"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Wiederholung</dt>
            <dd className="mt-1">{series ? `${describeRepeat(b)} · ab ${de(b.startsOn)}` : "einmalig"}</dd>
          </div>
          {b.exceptions.length ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Ausgelassen</dt>
              <dd className="mt-1">{[...b.exceptions].sort().map(de).join(", ")}</dd>
            </div>
          ) : null}
          {b.note ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Notiz</dt>
              <dd className="mt-1 whitespace-pre-wrap">{b.note}</dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-4 text-sm text-muted">In dieser Zeit nicht buchbar (online, Portal, KI-Telefon); interne Termine nur nach Rückfrage.</p>
      </Card>

      {canEdit ? (
        <>
          <CardTitle>Ändern</CardTitle>
          <BlockForm
            people={people}
            allowPraxis={canManageBlocksFor(auth, null)}
            edit={{ id: b.id, series, occurrence, occurrenceLabel: de(occurrence) }}
            defaults={{
              userId: b.userId ?? "praxis",
              kind: (BLOCK_KIND_LABELS[b.kind as BlockKind] ? b.kind : "sonstiges") as BlockKind,
              title: b.title ?? "",
              // „nur dieses Vorkommen“ ist vorausgewählt → Datum des Vorkommens; für die Serie bleibt der Serienbeginn erhalten (siehe Formular)
              startsOn: series ? occurrence : b.startsOn,
              endsOn: b.endsOn ?? "",
              allDay: b.allDay,
              startTime: b.startTime ?? "12:00",
              endTime: b.endTime === "24:00" ? "23:59" : (b.endTime ?? "12:30"),
              repeat: b.repeat as BlockRepeat,
              weekdays: b.weekdays,
              intervalWeeks: b.intervalWeeks,
              note: b.note ?? "",
            }}
            seriesStart={b.startsOn}
          />
          <Card className="mt-6">
            <CardTitle>Löschen</CardTitle>
            <DeleteBlockForm id={b.id} series={series} occurrence={occurrence} occurrenceLabel={de(occurrence)} />
          </Card>
        </>
      ) : (
        <p className="rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
          {auth.support ? "Support-Modus: nur lesen." : "Ändern kann nur, wer das Team verwalten darf (bzw. die Person selbst bei eigenen Sperrzeiten)."}
        </p>
      )}
    </div>
  );
}
