import Link from "next/link";
import { FootRecordView } from "@/components/foot3d";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { media, patients, recordAddenda, treatmentRecords, users } from "@/db/schema";
import { Badge, Button, Card, FormSuccess, LinkButton, Textarea, BackLink } from "@/components/ui";
import { audit } from "@/lib/audit";
import { requireAuth } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { dateDe, dateTimeDe, fullName, money } from "@/lib/format";
import { BRACE_ACTION_LABEL, MEDIA_PURPOSE_LABEL } from "@/lib/labels";
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, INVOICE_STATUS_TONE, RECEIPT_COLLECTIVE_HINT } from "@/lib/invoice-labels";
import { billingFromSource } from "@/server/appointment-billing";
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
    ["Verordnung", r.prescriptionId && feature(auth.organization, "verordnungen") ? "Einheit auf GKV-Verordnung gebucht" : null],
    ["Befund", r.findings],
    ["Reaktion / Besonderheiten", r.reaction],
    ["Material", r.material],
    ["Sterilgut-Charge", r.sterileBatchCode],
    ["Empfehlung", r.recommendation],
    ["Begründung fehlendes Pflichtfoto", r.missingPhotoReason],
  ];
  const needsCountersign = r.countersignRequired && !data.add.some((a) => a.a.kind === "countersign");
  const billing = auth.can("invoices.write") ? await billingFromSource(auth, { recordId }) : null;
  // offene Anzahlung zur Behandlung (bezahlt, noch nicht angerechnet): keine Quittung, bei der Rechnung anrechnen (wie Terminseite)
  const openDeposit = billing?.patient ? (billing.documents.find((d) => d.kind === "deposit" && d.status === "paid" && !d.collectiveInvoiceId) ?? null) : null;
  return (
    <div className="mx-auto max-w-4xl">
      <BackLink href={`/kunden/${id}`} label={`Akte ${fullName(data.p)}`} />
      <h1 className="font-display text-3xl font-semibold wrap-break-word">Behandlung vom {dateTimeDe(r.treatedAt)}</h1>
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
      {billing?.patient ? (
        <Card className="mt-6">
          <h2 className="mb-3 font-display text-lg font-semibold">Abrechnung</h2>
          {billing.prescription ? (
            <p className="mb-3 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">Behandlung auf Verordnung – Abrechnung über die Krankenkasse. Eine Rechnung an die Patient:in nur für Zusatzleistungen.</p>
          ) : null}
          {billing.documents.length ? (
            <ul className="mb-3 flex flex-col gap-1 text-sm">
              {billing.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/rechnungen/${d.id}`} className="font-semibold text-primary hover:underline">{INVOICE_KIND_LABEL[d.kind]} {d.number}</Link>
                  <span className="text-muted">vom {dateDe(d.issuedAt)} · {money(d.totalCents)}</span>
                  <Badge tone={INVOICE_STATUS_TONE[d.status]}>{INVOICE_STATUS_LABEL[d.status]}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {billing.billedBy.length ? (
            <p className="text-sm text-muted">Die Behandlung ist bereits abgerechnet.</p>
          ) : openDeposit ? (
            <div className="flex flex-wrap gap-2">
              <p className="w-full text-sm text-muted">
                Bezahlt mit Anzahlung {openDeposit.number} – wird auf die Rechnung bzw. Sammelrechnung angerechnet (keine zweite Quittung).
              </p>
              <LinkButton href={`/rechnungen/neu?behandlung=${recordId}`}>Rechnung erstellen (Anzahlung anrechnen)</LinkButton>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <LinkButton href={`/rechnungen/neu?behandlung=${recordId}`}>Rechnung erstellen</LinkButton>
              <LinkButton href={`/rechnungen/neu?behandlung=${recordId}&art=quittung`} variant="secondary">Quittung</LinkButton>
              <p className="w-full text-xs text-muted">{RECEIPT_COLLECTIVE_HINT}</p>
            </div>
          )}
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
