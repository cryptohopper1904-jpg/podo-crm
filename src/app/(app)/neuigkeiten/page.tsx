import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChangelogEntryView } from "@/components/changelog-entry";
import { Card, Empty, PageHeader } from "@/components/ui";
import { CHANGELOG } from "@/content/changelog";
import { visibleEntries } from "@/lib/changelog";
import { changelogViewer } from "@/server/changelog";

export const metadata: Metadata = { title: "Neuigkeiten" };

export default async function NeuigkeitenPage() {
  const v = await changelogViewer();
  if (!v) redirect("/login");
  const entries = visibleEntries(CHANGELOG, v.viewer);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Neuigkeiten" subtitle="Was sich in PodoHero getan hat" />
      {entries.length ? (
        <div className="flex flex-col gap-4">
          {entries.map((e) => (
            <Card key={e.id}>
              <ChangelogEntryView entry={e} headingLevel={2} />
            </Card>
          ))}
        </div>
      ) : (
        <Empty title="Noch keine Neuigkeiten" />
      )}
    </div>
  );
}
