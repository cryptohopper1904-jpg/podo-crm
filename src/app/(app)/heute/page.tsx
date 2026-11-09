import Link from "next/link";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppointmentRow } from "@/components/appointment-row";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { OnboardingCard } from "@/components/onboarding-card";
import { Badge, Card, CardTitle, Empty, LinkButton, Stat } from "@/components/ui";
import { withOrg } from "@/db";
import { integrationConnections, invoices, messages, payments, tasks, treatmentRecords } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, berlinToUtc, money, timeDe, weekdayLong } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { listAppointments } from "@/server/appointments";
import { failingCalendarFeeds } from "@/server/calendar-feeds";
import { voiceQuotaFor } from "@/server/voice";
import { VoiceQuotaBanner } from "@/components/voice-quota-banner";

export const metadata = { title: "Heute" };

const PROVIDER_LABEL: Record<string, string> = {
  lexoffice: "lexoffice", sumup: "SumUp", doctolib: "Doctolib", google_business: "Google", email_imap: "E-Mail", whatsapp: "WhatsApp",
  sms: "SMS", voice_agent: "KI-Telefon", transcription: "Transkription", llm: "KI-Assistent", calendar_ics: "Kalender-Abo", gkv_billing: "GKV-Abrechnung", kim: "KIM",
};

function greeting() {
  const h = Number(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
}

export default async function TodayPage() {
  const auth = await requireAuth();
  const org = auth.organization.id;
  const today = berlinDateIso();
  const dayStart = berlinToUtc(today, "00:00");
  const appts = auth.can("appointments.read") ? await listAppointments(auth, today, 1) : [];
  const stats = await withOrg(org, async (tx) => {
    const [open] = auth.can("invoices.read")
      ? await tx.select({ n: count(), sum: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.paidCents}),0)` }).from(invoices).where(and(eq(invoices.organizationId, org), inArray(invoices.status, ["issued", "partially_paid"])))
      : [{ n: 0, sum: 0 }];
    const [paidToday] = auth.can("invoices.read")
      ? await tx.select({ sum: sql<number>`coalesce(sum(${payments.amountCents}),0)` }).from(payments).where(and(eq(payments.organizationId, org), sql`${payments.paidAt} >= ${dayStart}`))
      : [{ sum: 0 }];
    const [newMsgs] = auth.can("messages.read")
      ? await tx.select({ n: count() }).from(messages).where(and(eq(messages.organizationId, org), eq(messages.status, "new")))
      : [{ n: 0 }];
    const openTasks = await tx.select().from(tasks).where(and(eq(tasks.organizationId, org), isNull(tasks.doneAt))).orderBy(tasks.dueAt).limit(8);
    const countersign = auth.can("medical.write")
      ? await tx.select({ n: count() }).from(treatmentRecords).where(and(eq(treatmentRecords.organizationId, org), eq(treatmentRecords.countersignRequired, true), sql`not exists (select 1 from record_addenda ra where ra.record_id = ${treatmentRecords.id} and ra.kind = 'countersign')`))
      : [{ n: 0 }];
    const integ = await tx.select().from(integrationConnections).where(eq(integrationConnections.organizationId, org));
    const recent = auth.can("messages.read")
      ? await tx.select().from(messages).where(and(eq(messages.organizationId, org), eq(messages.status, "new"))).orderBy(desc(messages.receivedAt)).limit(3)
      : [];
    return { open, paidToday, newMsgs, openTasks, countersign: countersign[0]?.n ?? 0, integ, recent };
  });
  const active = appts.filter((r) => r.a.status !== "cancelled");
  const overlaps = feedOverlapIds(appts);
  const feedErrors = auth.can("integrations.manage") ? await failingCalendarFeeds(org) : [];
  const homeVisits = active.filter((r) => r.a.homeVisit).length;
  const holiday = holidayOn(today, auth.organization.state as StateCode);
  // Inhaber:innen: Hinweis, wenn das KI-Telefon-Kontingent (fast) erschöpft ist
  const voiceQuota =
    auth.role === "owner" && stats.integ.some((i) => i.provider === "voice_agent" && i.status === "connected") ? await voiceQuotaFor(auth) : null;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <p className="text-sm text-muted">{weekdayLong(new Date())}{holiday ? ` · ${holiday}` : ""}</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{greeting()}, {auth.user.name.split(" ")[0]}</h1>
        </div>
        {auth.can("appointments.write") ? <LinkButton href="/kalender/neu">+ Termin</LinkButton> : null}
      </header>

      <OnboardingCard auth={auth} />
      {voiceQuota?.entitlement.enabled && (voiceQuota.usage.exceeded || voiceQuota.usage.warn) ? <div className="mb-6"><VoiceQuotaBanner usage={voiceQuota.usage} /></div> : null}

      <section aria-label="Kennzahlen" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Termine heute" value={active.length} sub={homeVisits ? `davon ${homeVisits} Hausbesuch${homeVisits > 1 ? "e" : ""}` : "keine Hausbesuche"} tone="primary" />
        <Stat label="Eingenommen heute" value={money(Number(stats.paidToday.sum))} sub="alle Zahlarten" tone="info" />
        <Stat label="Offene Posten" value={stats.open.n} sub={money(Number(stats.open.sum))} tone="accent" />
        <Stat label="Neue Nachrichten" value={stats.newMsgs.n} sub="mit KI-Antwortvorschlag" tone="warn" />
      </section>

      <div className="flex flex-wrap items-start gap-6">
        <Card className="min-w-0 flex-[3_1_480px]">
          <CardTitle action={<Link href="/kalender" className="text-sm font-semibold text-primary">Kalender</Link>}>Heute</CardTitle>
          {overlaps.size ? (
            <p className="mb-3 rounded-xl bg-accent-soft p-3 text-sm text-accent-soft-text">
              <strong>Überschneidung:</strong> {overlaps.size} Termine heute überschneiden sich mit Terminen aus dem Kalender-Abo (gleiche Behandler:in).
            </p>
          ) : null}
          {feedErrors.length ? (
            <p className="mb-3 rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">
              Kalender-Abo {feedErrors.map((f) => `„${f.label}“`).join(", ")}: letzter Abruf fehlgeschlagen –{" "}
              <Link href="/einstellungen/kalender-abo" className="font-semibold underline">prüfen</Link>
            </p>
          ) : null}
          {appts.length === 0 ? <Empty title="Heute keine Termine" /> : appts.map((r) => <AppointmentRow key={r.a.id} row={r} canDoc={auth.can("medical.write")} canEdit={auth.can("appointments.write")} overlap={overlaps.has(r.a.id)} />)}
        </Card>

        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-6">
          {stats.recent.length ? (
            <Card>
              <CardTitle action={<Link href="/posteingang" className="text-sm font-semibold text-primary">Alle</Link>}>Posteingang</CardTitle>
              <ul className="flex flex-col gap-3">
                {stats.recent.map((m) => (
                  <li key={m.id} className="rounded-xl bg-bg p-3">
                    <p className="text-xs text-muted">{m.channel} · {timeDe(m.receivedAt)}</p>
                    <p className="mt-1 line-clamp-2 text-sm">{m.body}</p>
                    {m.aiSuggestion ? <p className="mt-2 text-xs font-semibold text-primary">KI-Vorschlag bereit</p> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardTitle>Aufgaben</CardTitle>
            {stats.countersign ? <p className="mb-2 text-sm"><Badge tone="warn">{stats.countersign} Einträge warten auf Gegenzeichnung</Badge></p> : null}
            {stats.openTasks.length === 0 && !stats.countersign ? <p className="text-sm text-muted">Alles erledigt.</p> : (
              <ul className="flex flex-col gap-2 text-sm">
                {stats.openTasks.map((t) => <li key={t.id} className="flex items-center gap-2"><span className="size-2 rounded-full bg-accent" aria-hidden />{t.title}</li>)}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle action={auth.can("integrations.manage") ? <Link href="/einstellungen/schnittstellen" className="text-sm font-semibold text-primary">Verwalten</Link> : null}>Schnittstellen</CardTitle>
            <div className="grid grid-cols-2 gap-2">
              {stats.integ.map((i) => (
                <div key={i.id} className="flex items-center gap-2 rounded-xl bg-bg px-3 py-2.5">
                  <span className={`size-2.5 rounded-full ${i.status === "connected" ? "bg-primary" : i.status === "error" ? "bg-danger" : i.status === "mock" ? "bg-[#e9b931]" : "bg-border-strong"}`} aria-hidden />
                  <span className="flex-1 text-sm font-medium">{PROVIDER_LABEL[i.provider] ?? i.provider}</span>
                  <span className="text-xs text-muted">{i.status === "connected" ? "verbunden" : i.status === "mock" ? "Testmodus" : i.status === "error" ? "Fehler" : "aus"}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
