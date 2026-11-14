import Link from "next/link";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { db, withOrg } from "@/db";
import { appointments, messages, organizations, patients } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { isMockMode } from "@/integrations/registry";
import { mapSequential } from "@/lib/seq";
import type { PatientSuggestion } from "@/lib/kim-hints";
import { kimPatientSuggestions, loadKimConnection } from "@/server/kim";
import { onlineRequestAppointmentId } from "@/lib/online-request";
import { aiReplyChannel, aiReplySettings } from "@/lib/ai-replies";
import { OnlineRequestRetentionNote } from "@/components/online-request-retention-note";
import { markDoneAction, matchPatientAction, sendReplyAction, suggestReplyAction, syncKimAction } from "./actions";

export const metadata = { title: "Posteingang" };

const CHANNEL_LABEL: Record<string, string> = { email: "E-Mail", whatsapp: "WhatsApp", sms: "SMS", phone: "Telefon", letter: "Brief", none: "–", kim: "KIM" };

type Row = { m: typeof messages.$inferSelect; patient: { id: string; number: number; firstName: string | null; lastName: string } | null };

type CardProps = {
  row: Row;
  canWrite: boolean;
  suggestions?: PatientSuggestion[];
  /** KI-Antwortvorschläge eingeschaltet (Einstellungen → Praxis) */
  aiEnabled?: boolean;
  /** Online-Anfrage, deren Termin noch unter die automatische Löschung fällt (ohne Person, geplant/abgesagt) */
  pendingRequest?: boolean;
};

function MessageCard({ row, canWrite, suggestions = [], aiEnabled = false, pendingRequest = false }: CardProps) {
  const { m, patient } = row;
  const open = m.status === "new" || m.status === "suggested";
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={m.channel === "whatsapp" ? "primary" : m.channel === "email" ? "info" : m.channel === "kim" ? "accent" : "neutral"}>{CHANNEL_LABEL[m.channel] ?? m.channel}</Badge>
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
      {/* nur gekennzeichnete /buchen-Anfragen ohne Akte, deren Termin noch löschbar ist (src/server/online-request-retention.ts) */}
      {!patient && m.direction === "inbound" && !m.externalId && pendingRequest ? <OnlineRequestRetentionNote className="mt-3" /> : null}

      {open && canWrite ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          {!patient && suggestions.length ? (
            <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
              <p className="text-sm font-semibold">Vorschläge zur Zuordnung (bitte prüfen – es wird nichts automatisch zugeordnet)</p>
              {suggestions.map((sg) => (
                <ActionForm key={sg.patient.id} action={matchPatientAction} submit={`Nr. ${sg.patient.number} zuordnen`} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={m.id} />
                  <input type="hidden" name="patientNumber" value={sg.patient.number} />
                  <span className="text-sm">
                    Nr. {sg.patient.number} · {[sg.patient.firstName, sg.patient.lastName].filter(Boolean).join(" ")} <span className="text-muted">({sg.reasons.join(", ")})</span>
                  </span>
                </ActionForm>
              ))}
            </div>
          ) : null}
          {!patient ? (
            <ActionForm action={matchPatientAction} submit="Zuordnen" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={m.id} />
              <Field label={m.channel === "kim" ? "Patientennummer" : "Patientennummer (leer = automatisch über Absender)"}><Input name="patientNumber" inputMode="numeric" className="w-40" /></Field>
            </ActionForm>
          ) : null}
          {aiEnabled && aiReplyChannel(m.channel) && (m.channel !== "kim" || patient) ? (
            <ActionForm action={suggestReplyAction} submit={m.aiSuggestion ? "Neuen KI-Vorschlag erzeugen" : "KI-Vorschlag erzeugen"} className="flex flex-col gap-2">
              <input type="hidden" name="id" value={m.id} />
            </ActionForm>
          ) : null}
          <ActionForm action={sendReplyAction} submit="Antwort senden">
            <input type="hidden" name="id" value={m.id} />
            <Field
              label="Antwort"
              hint={
                m.channel === "whatsapp" || m.channel === "sms"
                  ? "Nur Organisatorisches (Termine) – keine medizinischen Inhalte über WhatsApp/SMS."
                  : m.channel === "kim"
                    ? "Antwort per KIM an die absendende Praxis (nur Text). Vor dem Senden prüfen."
                    : "Vor dem Senden prüfen. KI-Vorschläge sind nur Entwürfe."
              }
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
  const kimConn = await loadKimConnection(org);
  // Zuordnungsvorschläge nur für offene, nicht zugeordnete KIM-Nachrichten (nie automatisch)
  const kimOpen = open.filter((r) => r.m.channel === "kim" && !r.patient).slice(0, 30);
  const suggestionMap = new Map(
    canWrite ? await mapSequential(kimOpen, async (r) => [r.m.id, await kimPatientSuggestions(org, { subject: r.m.subject, body: r.m.body })] as const) : [],
  );
  const [o] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, org));
  const aiEnabled = aiReplySettings(o?.settings).enabled;
  // Hinweis „wird nach 6 Monaten gelöscht“ nur, solange der Termin der Anfrage noch darunter fällt (ohne Person, geplant/abgesagt)
  const requestIds = [...new Set(open.map((r) => onlineRequestAppointmentId(r.m.threadKey)).filter((id): id is string => !!id))];
  const pendingKeys = new Set(
    requestIds.length
      ? (
          await withOrg(org, (tx) =>
            tx
              .select({ externalId: appointments.externalId })
              .from(appointments)
              .where(
                and(
                  eq(appointments.organizationId, org),
                  inArray(appointments.id, requestIds),
                  eq(appointments.source, "online"),
                  isNull(appointments.patientId),
                  inArray(appointments.status, ["planned", "cancelled"]),
                ),
              ),
          )
        ).map((a) => a.externalId)
      : [],
  );
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Posteingang" subtitle={`${open.length} offen`} />
      {kimConn && canWrite ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-4">
          <ActionForm action={syncKimAction} submit="KIM abrufen" className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              <Badge tone="accent">KIM</Badge> {kimConn.status === "mock" ? "Testmodus: Es werden Beispielnachrichten abgerufen (keine TI-Verbindung)." : "Neue Nachrichten aus dem KIM-Postfach holen."}
            </span>
          </ActionForm>
        </div>
      ) : null}
      {isMockMode() ? (
        <p className="mb-4 rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">Testmodus: Antworten werden gespeichert und protokolliert, aber nicht wirklich versendet.</p>
      ) : null}
      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold">Neu</h2>
        {open.length ? open.map((r) => (
              <MessageCard
                key={r.m.id}
                row={r}
                canWrite={canWrite}
                suggestions={suggestionMap.get(r.m.id)}
                aiEnabled={aiEnabled}
                pendingRequest={!!r.m.threadKey && pendingKeys.has(r.m.threadKey)}
              />
            )) : <Empty title="Keine offenen Nachrichten" />}
      </section>
      <section className="mt-8 flex flex-col gap-4">
        <h2 className="font-display text-xl font-semibold">Beantwortet</h2>
        {answered.length ? answered.map((r) => <MessageCard key={r.m.id} row={r} canWrite={false} />) : <p className="text-sm text-muted">Noch nichts beantwortet.</p>}
      </section>
    </div>
  );
}
