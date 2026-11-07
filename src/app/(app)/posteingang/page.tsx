import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { withOrg } from "@/db";
import { messages, patients } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { isMockMode } from "@/integrations/registry";
import { markDoneAction, matchPatientAction, sendReplyAction, suggestReplyAction } from "./actions";

export const metadata = { title: "Posteingang" };

const CHANNEL_LABEL: Record<string, string> = { email: "E-Mail", whatsapp: "WhatsApp", sms: "SMS", phone: "Telefon", letter: "Brief", none: "–" };

type Row = { m: typeof messages.$inferSelect; patient: { id: string; number: number; firstName: string | null; lastName: string } | null };

function MessageCard({ row, canWrite }: { row: Row; canWrite: boolean }) {
  const { m, patient } = row;
  const open = m.status === "new" || m.status === "suggested";
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={m.channel === "whatsapp" ? "primary" : m.channel === "email" ? "info" : "neutral"}>{CHANNEL_LABEL[m.channel]}</Badge>
        <span className="font-semibold">{m.fromAddress ?? "unbekannt"}</span>
        <span className="text-muted">{dateTimeDe(m.receivedAt)}</span>
        {m.status === "suggested" ? <Badge tone="info">Vorschlag bereit</Badge> : null}
        {patient ? (
          <Link className="ml-auto underline" href={`/kunden/${patient.id}`}>
            Nr. {patient.number} · {[patient.firstName, patient.lastName].filter(Boolean).join(" ")}
          </Link>
        ) : (
          <span className="ml-auto text-muted">nicht zugeordnet</span>
        )}
      </div>
      {m.subject ? <p className="font-semibold">{m.subject}</p> : null}
      <p className="whitespace-pre-wrap text-[15px]">{m.body}</p>

      {open && canWrite ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          {!patient ? (
            <ActionForm action={matchPatientAction} submit="Zuordnen" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={m.id} />
              <Field label="Kundennummer (leer = automatisch über Absender)"><Input name="patientNumber" inputMode="numeric" className="w-40" /></Field>
            </ActionForm>
          ) : null}
          <ActionForm action={suggestReplyAction} submit={m.aiSuggestion ? "Neuen KI-Vorschlag erzeugen" : "KI-Vorschlag erzeugen"} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={m.id} />
          </ActionForm>
          <ActionForm action={sendReplyAction} submit="Antwort senden">
            <input type="hidden" name="id" value={m.id} />
            <Field
              label="Antwort"
              hint={m.channel === "whatsapp" || m.channel === "sms" ? "Nur Organisatorisches (Termine) – keine medizinischen Inhalte über WhatsApp/SMS." : "Vor dem Senden prüfen. KI-Vorschläge sind nur Entwürfe."}
            >
              <Textarea name="body" rows={6} defaultValue={m.aiSuggestion ?? ""} key={m.aiSuggestion ?? "leer"} />
            </Field>
          </ActionForm>
          <ActionForm action={markDoneAction} submit="Ohne Antwort erledigt" className="flex flex-col gap-2">
            <input type="hidden" name="id" value={m.id} />
          </ActionForm>
        </div>
      ) : null}
    </Card>
  );
}

export default async function InboxPage() {
  const auth = await requireAuth("messages.read");
  const org = auth.organization.id;
  const rows: Row[] = await withOrg(org, (tx) =>
    tx
      .select({ m: messages, patient: { id: patients.id, number: patients.number, firstName: patients.firstName, lastName: patients.lastName } })
      .from(messages)
      .leftJoin(patients, eq(patients.id, messages.patientId))
      .where(and(eq(messages.organizationId, org), eq(messages.direction, "inbound"), inArray(messages.status, ["new", "suggested", "answered"])))
      .orderBy(desc(messages.receivedAt))
      .limit(200),
  );
  const open = rows.filter((r) => r.m.status !== "answered");
  const answered = rows.filter((r) => r.m.status === "answered").slice(0, 30);
  const canWrite = auth.can("messages.write");
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Posteingang" subtitle={`${open.length} offen`} />
      {isMockMode() ? (
        <p className="mb-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">Testmodus: Antworten werden gespeichert und protokolliert, aber nicht wirklich versendet.</p>
      ) : null}
      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold">Neu</h2>
        {open.length ? open.map((r) => <MessageCard key={r.m.id} row={r} canWrite={canWrite} />) : <Empty title="Keine offenen Nachrichten" />}
      </section>
      <section className="mt-8 flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold">Beantwortet</h2>
        {answered.length ? answered.map((r) => <MessageCard key={r.m.id} row={r} canWrite={false} />) : <p className="text-sm text-muted">Noch nichts beantwortet.</p>}
      </section>
    </div>
  );
}
