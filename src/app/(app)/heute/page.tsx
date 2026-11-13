import Link from "next/link";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppointmentRow } from "@/components/appointment-row";
import type { TherapistColor } from "@/lib/therapist-colors";
import { teamColors } from "@/server/therapist-colors";
import { feedOverlapIds } from "@/lib/appointment-overlap";
import { OnboardingCard } from "@/components/onboarding-card";
import { Badge, Card, CardTitle, Empty, LinkButton, Stat, pageTitleBox, pageTitleCls } from "@/components/ui";
import { withOrg } from "@/db";
import { integrationConnections, invoices, messages, payments, tasks, treatmentRecords } from "@/db/schema";
import { HiddenAreaNotice } from "@/components/hidden-area-notice";
import { requireAuth } from "@/lib/auth/session";
import { feature, isGkvArea } from "@/lib/features";
import { berlinDateIso, berlinToUtc, money, timeDe, weekdayLong } from "@/lib/format";
import { holidayOn, type StateCode } from "@/lib/holidays";
import { collectiveReminderYear } from "@/lib/year-end";
import { collectiveOverview } from "@/server/appointment-billing";
import { listAppointments } from "@/server/appointments";
import { failingCalendarFeeds } from "@/server/calendar-feeds";
import { voiceQuotaFor } from "@/server/voice";
import { VoiceQuotaBanner } from "@/components/voice-quota-banner";
import { todaySections } from "@/lib/view-level";
import { currentViewLevel } from "@/server/view-level";

export const metadata = { title: "Heute" };

const PROVIDER_LABEL: Record<string, string> = {
  lexoffice: "lexoffice", sumup: "SumUp", doctolib: "Doctolib", google_business: "Google", email_imap: "E-Mail", whatsapp: "WhatsApp",
  sms: "SMS", voice_agent: "KI-Telefon", transcription: "Transkription", llm: "KI-Assistent", calendar_ics: "Kalender-Abo", gkv_billing: "GKV-Abrechnung", kim: "KIM",
};

function greeting() {
  const h = Number(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return h < 11 ? "Guten Morgen" : h < 18 ? "Guten Tag" : "Guten Abend";
}

export default async function TodayPage(props: PageProps<"/heute">) {
  const auth = await requireAuth();
  // Direktaufruf eines ausgeblendeten Kassen-Bereichs (Weiterleitung aus src/server/features.ts)
  const hiddenArea = (await props.searchParams).ausgeblendet;
  const gkv = feature(auth.organization, "gkvBilling");
  const org = auth.organization.id;
  const today = berlinDateIso();
  const dayStart = berlinToUtc(today, "00:00");
  const [appts, colors] = auth.can("appointments.read") ? await Promise.all([listAppointments(auth, today, 1), teamColors(auth)]) : [[], new Map<string, TherapistColor>()];
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
  // Jahresende: ab 1. Dezember (und im Januar fürs Vorjahr) an fehlende Sammelrechnungen erinnern
  const reminderYear = auth.can("invoices.write") ? collectiveReminderYear(today) : null;
  const openCollective = reminderYear ? await collectiveOverview(auth, reminderYear) : [];
  // Persönliche Ansicht (Einstellungen → Ansicht): blendet nur Karten aus, die Daten bleiben unverändert
  const show = todaySections(await currentViewLevel());
  const quickActions = [
    auth.can("patients.read") ? { href: "/kunden", label: "Patient:in suchen" } : null,
    auth.can("patients.write") ? { href: "/kunden/neu", label: "Neue Patient:in" } : null,
    auth.can("medical.write") ? { href: "/doku", label: "Behandlung dokumentieren" } : null,
    auth.can("invoices.write") ? { href: "/rechnungen/neu", label: "Rechnung schreiben" } : null,
    auth.can("cash.read") ? { href: "/kasse", label: "Kasse" } : null,
  ].filter((a) => a !== null);
  const hasTasks = stats.openTasks.length > 0 || stats.countersign > 0;
  const showTasks = show.tasks === "always" || hasTasks;
  const sideColumn = (show.inbox && stats.recent.length > 0) || (show.collective && !!reminderYear && openCollective.length > 0) || showTasks || show.integrations;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <p className="text-sm text-muted">{weekdayLong(new Date())}{holiday ? ` · ${holiday}` : ""}</p>
          <h1 className={pageTitleCls}>{greeting()}, {auth.user.name.split(" ")[0]}</h1>
        </div>
        {auth.can("appointments.write") ? <LinkButton href="/kalender/neu">+ Termin</LinkButton> : null}
      </header>

      {isGkvArea(hiddenArea) && !feature(auth.organization, hiddenArea) ? <HiddenAreaNotice area={hiddenArea} settingsLink={auth.can("settings.manage")} /> : null}
      <OnboardingCard auth={auth} />
      {voiceQuota?.entitlement.enabled && (voiceQuota.usage.exceeded || voiceQuota.usage.warn) ? <div className="mb-6"><VoiceQuotaBanner usage={voiceQuota.usage} /></div> : null}

      {show.stats ? (
        <section aria-label="Kennzahlen" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Termine heute" value={active.length} sub={homeVisits ? `davon ${homeVisits} Hausbesuch${homeVisits > 1 ? "e" : ""}` : "keine Hausbesuche"} tone="primary" />
          <Stat label="Eingenommen heute" value={money(Number(stats.paidToday.sum))} sub="alle Zahlarten" tone="info" />
          <Stat label="Offene Posten" value={stats.open.n} sub={money(Number(stats.open.sum))} tone="accent" />
          <Stat label="Neue Nachrichten" value={stats.newMsgs.n} sub="mit KI-Antwortvorschlag" tone="warn" />
        </section>
      ) : null}

      {show.quickActions && quickActions.length ? (
        <nav aria-label="Schnellzugriff" className="mb-6 flex flex-wrap gap-2">
          {quickActions.map((a) => (
            <Link key={a.href} href={a.href} className="inline-flex min-h-11 items-center rounded-xl border border-border bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
              {a.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start gap-6">
        <Card className="min-w-0 flex-[3_1_480px]">
          <CardTitle action={<Link href="/kalender" className="text-sm font-semibold text-primary">Kalender</Link>}>
            Heute{show.stats ? null : <span className="ml-2 text-sm font-normal text-muted">{active.length} Termin{active.length === 1 ? "" : "e"}{homeVisits ? ` · ${homeVisits} Hausbesuch${homeVisits > 1 ? "e" : ""}` : ""}</span>}
          </CardTitle>
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
          {appts.length === 0 ? <Empty title="Heute keine Termine" /> : appts.map((r) => <AppointmentRow key={r.a.id} row={r} canDoc={auth.can("medical.write")} canEdit={auth.can("appointments.write")} overlap={overlaps.has(r.a.id)} from="/heute" color={r.a.therapistId ? colors.get(r.a.therapistId) : undefined} />)}
        </Card>

        {sideColumn ? (
        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-6">
          {show.inbox && stats.recent.length ? (
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

          {show.collective && reminderYear && openCollective.length ? (
            <Card className="border-accent/40">
              <CardTitle action={<Link href={`/rechnungen/sammelrechnungen?jahr=${reminderYear}`} className="text-sm font-semibold text-primary">Alle</Link>}>
                Sammelrechnungen {reminderYear}
              </CardTitle>
              <p className="mb-3 text-sm text-muted">
                {openCollective.length === 1 ? "1 Patient:in hat" : `${openCollective.length} Patient:innen haben`} noch Behandlungen oder Quittungen aus {reminderYear} ohne Rechnung.
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {openCollective.slice(0, 5).map((r) => (
                  <li key={r.patientId} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="text-muted tabular-nums">{r.items} Beh.{r.receiptCount ? ` · ${r.receiptCount} Quittung${r.receiptCount > 1 ? "en" : ""}` : ""}{r.depositCount ? ` · ${r.depositCount} Anzahlung${r.depositCount > 1 ? "en" : ""}` : ""}</span>
                    <Link href={`/rechnungen/neu?sammel=${r.patientId}&jahr=${reminderYear}`} className="font-semibold text-primary">Erstellen</Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {showTasks ? (
          <Card>
            <CardTitle>Aufgaben</CardTitle>
            {stats.countersign ? <p className="mb-2 text-sm"><Badge tone="warn">{stats.countersign} Einträge warten auf Gegenzeichnung</Badge></p> : null}
            {stats.openTasks.length === 0 && !stats.countersign ? <p className="text-sm text-muted">Alles erledigt.</p> : (
              <ul className="flex flex-col gap-2 text-sm">
                {stats.openTasks.map((t) => <li key={t.id} className="flex items-center gap-2"><span className="size-2 rounded-full bg-accent" aria-hidden />{t.title}</li>)}
              </ul>
            )}
          </Card>
          ) : null}

          {show.integrations ? (
          <Card>
            <CardTitle action={auth.can("integrations.manage") ? <Link href="/einstellungen/schnittstellen" className="text-sm font-semibold text-primary">Verwalten</Link> : null}>Schnittstellen</CardTitle>
            <div className="grid grid-cols-2 gap-2">
              {stats.integ.filter((i) => gkv || i.provider !== "gkv_billing").map((i) => (
                <div key={i.id} className="flex items-center gap-2 rounded-xl bg-bg px-3 py-2.5">
                  <span className={`size-2.5 rounded-full ${i.status === "connected" ? "bg-primary" : i.status === "error" ? "bg-danger" : i.status === "mock" ? "bg-[#e9b931]" : "bg-border-strong"}`} aria-hidden />
                  <span className="flex-1 text-sm font-medium">{PROVIDER_LABEL[i.provider] ?? i.provider}</span>
                  <span className="text-xs text-muted">{i.status === "connected" ? "verbunden" : i.status === "mock" ? "Testmodus" : i.status === "error" ? "Fehler" : "aus"}</span>
                </div>
              ))}
            </div>
          </Card>
          ) : null}
        </div>
        ) : null}
      </div>
    </div>
  );
}
