import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withOrg } from "@/db";
import { media, patients } from "@/db/schema";
import { Badge, Card, Empty, BackLink } from "@/components/ui";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { dateDe, fullName } from "@/lib/format";
import { MEDIA_PURPOSE_LABEL } from "@/lib/labels";

export const metadata = { title: "Fotoverlauf" };

const PURPOSE = MEDIA_PURPOSE_LABEL;

/** Verlauf je Körperstelle (Seite + Zehe), älteste links – für Vorher/Nachher-Vergleich. Keine KI-Bewertung (MDR). */
export default async function PhotosPage(props: PageProps<"/kunden/[id]/fotos">) {
  const { id } = await props.params;
  const auth = await requireAuth("medical.read");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [p] = await tx.select().from(patients).where(and(eq(patients.organizationId, org), eq(patients.id, id)));
    if (!p) return null;
    const rows = await tx.select().from(media).where(and(eq(media.organizationId, org), eq(media.patientId, id), eq(media.kind, "photo"), isNull(media.deletedAt))).orderBy(asc(media.takenAt));
    return { p, rows };
  });
  if (!data) notFound();
  await audit({ organizationId: org, userId: auth.user.id, action: "media.list", entity: "patient", entityId: id });
  const groups = new Map<string, typeof data.rows>();
  for (const m of data.rows) {
    const key = m.footSide ? `${m.footSide === "left" ? "Links" : "Rechts"} D${m.toe ?? "?"}` : "Ohne Zuordnung";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return (
    <div className="mx-auto max-w-7xl">
      <BackLink href={`/kunden/${id}`} label={`Akte ${fullName(data.p)}`} />
      <h1 className="mb-6 font-display text-3xl font-semibold wrap-break-word">Fotoverlauf</h1>
      {groups.size === 0 ? <Empty title="Noch keine Fotos" /> : null}
      <div className="flex flex-col gap-6">
        {[...groups.entries()].map(([key, list]) => (
          <Card key={key}>
            <h2 className="mb-3 font-display text-lg font-semibold">{key} <span className="text-sm font-normal text-muted">· {list.length} Fotos</span></h2>
            <div className="flex snap-x gap-3 overflow-x-auto pb-2">
              {list.map((m) => (
                <figure key={m.id} className="w-56 shrink-0 snap-start overflow-hidden rounded-xl bg-surface-2">
                  <a href={`/api/media/${m.id}`} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/media/${m.id}`} alt={`${key} ${PURPOSE[m.purpose]} ${dateDe(m.takenAt)}`} className="aspect-square w-full object-cover" loading="lazy" />
                  </a>
                  <figcaption className="flex flex-wrap items-center gap-1 px-2 py-2 text-xs">
                    <span className="font-semibold">{dateDe(m.takenAt)}</span>
                    <Badge tone={m.purpose.startsWith("brace") ? "accent" : "neutral"}>{PURPOSE[m.purpose]}</Badge>
                    {m.view ? <span className="text-muted">{m.view}</span> : null}
                  </figcaption>
                </figure>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
