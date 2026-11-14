import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { Card, CardTitle, Empty, PageHeader } from "@/components/ui";
import { CHANGELOG } from "@/content/changelog";
import { formatChangelogDate, visibleEntries } from "@/lib/changelog";
import { changelogViewer } from "@/server/changelog";

export const metadata: Metadata = { title: "Neuigkeiten" };

/** So viele neueste Einträge stehen ausgeklappt oben; ältere als aufklappbare Liste (sonst über 17 000 px auf dem Handy) */
const OPEN_ENTRIES = 3;

export default async function NeuigkeitenPage() {
  const v = await changelogViewer();
  if (!v) redirect("/login");
  const entries = visibleEntries(CHANGELOG, v.viewer);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Neuigkeiten" subtitle="Was sich in PodoHero getan hat" />
      {entries.length ? (
        <div className="flex flex-col gap-4">
          {entries.slice(0, OPEN_ENTRIES).map((e) => (
            <Card key={e.id}>
              <ChangelogEntryView entry={e} headingLevel={2} />
            </Card>
          ))}
          {entries.length > OPEN_ENTRIES ? (
            <Card>
              <CardTitle>Frühere Neuigkeiten</CardTitle>
              <ul className="-mx-2 flex flex-col divide-y divide-border">
                {entries.slice(OPEN_ENTRIES).map((e) => (
                  <li key={e.id}>
                    <details className="group">
                      {/* summary erlaubt Text und eine Überschrift als direkte Kinder → Raster statt verschachtelter Blöcke */}
                      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg px-2 py-2.5 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                        <ChevronRight size={18} aria-hidden className="row-span-2 mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-90" />
                        <h3 className="font-semibold leading-snug">{e.title}</h3>
                        <span className="text-[13px] text-muted">
                          <time dateTime={e.date}>{formatChangelogDate(e.date)}</time> · {e.items.length} {e.items.length === 1 ? "Punkt" : "Punkte"}
                        </span>
                      </summary>
                      {/* Datum und Titel stehen schon in der Zeile darüber */}
                      <div className="px-2 pt-1 pb-4 pl-9">
                        <ChangelogEntryView entry={e} hideHeader />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : (
        <Empty title="Noch keine Neuigkeiten" />
      )}
    </div>
  );
}
