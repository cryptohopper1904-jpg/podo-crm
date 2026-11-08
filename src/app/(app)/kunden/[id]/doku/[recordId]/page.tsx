import Link from "next/link";
import { FootRecordView } from "@/components/foot3d";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { media, patients, recordAddenda, treatmentRecords, users } from "@/db/schema";
import { Badge, Button, Card, FormSuccess, Textarea } from "@/components/ui";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe, fullName } from "@/lib/format";
import { BRACE_ACTION_LABEL, MEDIA_PURPOSE_LABEL } from "@/lib/labels";
import { addAddendumAction } from "../actions";

export const metadata = { title: "Behandlungseintrag" };

export default async function RecordPage(props: PageProps<"/kunden/[id]/doku/[recordId]">) {
  const { id, recordId } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("medical.read");
  const org = auth.organization.id;
  const data = await withOrg(org, async (tx) => {
    const [r] = await tx
      .select({ r: treatmentRecords, author: users.name })
      .from(treatmentRecords)
      .innerJoin(users, eq(users.id, treatmentRecords.authorId))
      .where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.id, recordId), eq(treatmentRecords.patientId, id)));
    if (!r) return null;
    const [p] = await tx.select().from(patients).where(eq(patients.id, id));
    const add = await tx.select({ a: recordAddenda, author: users.name }).from(recordAddenda).innerJoin(users, eq(users.id, recordAddenda.authorId)).where(and(eq(recordAddenda.organizationId, org), eq(recordAddenda.recordId, recordId))).orderBy(asc(recordAddenda.createdAt));
    const photos = await tx.select().from(media).where(and(eq(media.organizationId, org), eq(media.recordId, recordId)));
    return { ...r, p, add, photos };
  });
  if (!data) notFound();
  await audit({ organizationId: org, userId: auth.user.id, action: "record.read", entity: "treatment_record", entityId: recordId });
  const r = data.r;
  const st = r.structured as { braceAction?: string; braceChange?: string | null };
  const rows: [string, string | null][] = [
    ["Nagelspange", st.braceAction && st.braceAction !== "none" ? `${BRACE_ACTION_LABEL[st.braceAction] ?? st.braceAction}${st.braceChange ? ` – Wechsel: ${st.braceChange}` : ""}` : null],
    ["Durchgeführte Behandlung", r.servicesText],
    ["Verordnung", r.prescriptionId ? "Einheit auf GKV-Verordnung gebucht" : null],
    ["Befund", r.findings],
    ["Reaktion / Besonderheiten", r.reaction],
    ["Material", r.material],
    ["Sterilgut-Charge", r.sterileBatchCode],
    ["Empfehlung", r.recommendation],
    ["Begründung fehlendes Pflichtfoto", r.missingPhotoReason],
  ];
  const needsCountersign = r.countersignRequired && !data.add.some((a) => a.a.kind === "countersign");
  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm text-muted"><Link href={`/kunden/${id}`} className="hover:text-primary">← {fullName(data.p)}</Link></p>
      <h1 className="mt-1 font-display text-3xl font-semibold">Behandlung vom {dateTimeDe(r.treatedAt)}</h1>
      <p className="mt-1 flex flex-wrap gap-2 text-sm text-muted">
        dokumentiert von {data.author}
        {r.aiAssisted ? <Badge tone="info">KI-unterstützt, geprüft</Badge> : null}
        {needsCountersign ? <Badge tone="warn">Gegenzeichnung offen</Badge> : null}
        <Badge>unveränderbar · {r.hash.slice(0, 10)}…</Badge>
      </p>
      {sp.gespeichert ? <div className="mt-4"><FormSuccess message="Gespeichert. Der Eintrag ist jetzt unveränderbar, Ergänzungen gehen als Nachtrag." /></div> : null}
      <Card className="mt-6">
        <dl className="grid gap-4 sm:grid-cols-2">
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className={k === "Befund" || k === "Durchgeführte Behandlung" ? "sm:col-span-2" : ""}>
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k}</dt>
              <dd className="mt-1 whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
          {r.footPoints.length ? (
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-muted">Befund am Fuß</dt>
              <dd className="mt-1">
                <FootRecordView points={r.footPoints} />
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>
      {data.photos.length ? (
        <Card className="mt-6">
          <h2 className="mb-3 font-display text-lg font-semibold">Fotos</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {data.photos.map((m) => (
              <figure key={m.id} className="overflow-hidden rounded-xl bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/media/${m.id}`} alt={MEDIA_PURPOSE_LABEL[m.purpose] ?? "Foto"} className="aspect-square w-full object-cover" />
                <figcaption className="px-2 py-1 text-xs">{MEDIA_PURPOSE_LABEL[m.purpose] ?? m.purpose} · {m.footSide === "left" ? "li" : "re"} D{m.toe} · {m.view}</figcaption>
              </figure>
            ))}
          </div>
        </Card>
      ) : null}
      <Card className="mt-6">
        <h2 className="mb-3 font-display text-lg font-semibold">Nachträge</h2>
        {data.add.length === 0 ? <p className="text-sm text-muted">Keine Nachträge.</p> : (
          <ol className="mb-4 flex flex-col gap-3">
            {data.add.map(({ a, author }) => (
              <li key={a.id} className="rounded-xl bg-surface-2 p-3 text-sm">
                <p className="text-xs text-muted">{dateTimeDe(a.createdAt)} · {author} · {a.kind === "countersign" ? "Gegenzeichnung" : "Nachtrag"}</p>
                <p className="mt-1 whitespace-pre-wrap">{a.text}</p>
              </li>
            ))}
          </ol>
        )}
        {auth.can("medical.write") ? (
          <form action={addAddendumAction} className="flex flex-col gap-3">
            <input type="hidden" name="recordId" value={recordId} />
            <input type="hidden" name="patientId" value={id} />
            <label className="sr-only" htmlFor="addendum">Nachtrag</label>
            <Textarea id="addendum" name="text" required minLength={3} placeholder="Ergänzung oder Korrektur (der ursprüngliche Eintrag bleibt sichtbar)" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary">Nachtrag speichern</Button>
              {needsCountersign && (auth.role === "owner" || auth.role === "therapist") && r.authorId !== auth.user.id ? (
                <Button type="submit" name="kind" value="countersign">Gegenzeichnen</Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
