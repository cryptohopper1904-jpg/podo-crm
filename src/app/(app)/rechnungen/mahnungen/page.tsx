import Link from "next/link";
import { Empty, PageHeader, Stat } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { DUNNING_STAGE_LABEL } from "@/lib/dunning";
import { dateDe, money } from "@/lib/format";
import { dunningOverview } from "@/server/dunning";
import { DunningOverviewTable, type OverviewItem } from "./dunning-actions";

export const metadata = { title: "Mahnungen" };

export default async function DunningPage() {
  const auth = await requireAuth("invoices.read");
  const { rows, settings, today } = await dunningOverview(auth);
  const items: OverviewItem[] = rows.map((r) => {
    const s = r.state;
    const daysOverdue = "daysOverdue" in s ? s.daysOverdue : 0;
    let nextLabel = "–";
    let due = false;
    let warn = false;
    if (s.state === "due") {
      nextLabel = `${DUNNING_STAGE_LABEL[s.next]} fällig`;
      due = true;
    } else if (s.state === "waiting") nextLabel = `${DUNNING_STAGE_LABEL[s.next]} ab ${dateDe(s.dueOn)}`;
    else if (s.state === "exhausted") nextLabel = "alle Stufen erstellt";
    else if (s.state === "unsent") {
      nextLabel = `${DUNNING_STAGE_LABEL[s.last]} noch nicht versendet`;
      warn = true;
    }
    return {
      invoiceId: r.invoiceId,
      number: r.number,
      name: r.name,
      dueAt: dateDe(r.dueAt),
      daysOverdue,
      openLabel: money(r.openCents),
      nextLabel,
      due,
      warn,
      hasEmail: r.hasEmail,
      last: r.last
        ? {
            id: r.last.id,
            label: DUNNING_STAGE_LABEL[r.last.stage],
            date: dateDe(r.last.letterDate),
            sentLabel: r.last.sentVia === "email" ? "per E-Mail versendet" : r.last.sentVia === "post" ? "per Post versendet" : null,
          }
        : null,
    };
  });
  const dueCount = items.filter((i) => i.due).length;
  const openCents = rows.reduce((s, r) => s + r.openCents, 0);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        back={{ href: "/rechnungen", label: "Rechnungen" }}
        title="Mahnungen"
        subtitle={`Überfällige Privatrechnungen · Stand ${dateDe(today)}`}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Überfällige Rechnungen" value={String(items.length)} tone={items.length ? "accent" : "neutral"} />
        <Stat label="Mahnstufe fällig" value={String(dueCount)} tone={dueCount ? "accent" : "neutral"} />
        <Stat label="Offen (überfällig)" value={money(openCents)} tone="info" />
      </div>
      <p className="mb-4 text-sm text-muted">
        Zahlungserinnerung {settings.stages.reminder.days} Tage nach dem Zahlungsziel, 1. Mahnung {settings.stages.dunning1.days} Tage nach der
        Zahlungserinnerung, 2. Mahnung (letzte) {settings.stages.dunning2.days} Tage nach der 1. Mahnung.
        {auth.can("settings.manage") ? (
          <>
            {" "}
            <Link href="/einstellungen/praxis#mahnwesen" className="font-semibold text-primary underline">Fristen, Gebühren und Texte ändern</Link>
          </>
        ) : null}
        {" "}Bezahlte oder stornierte Rechnungen, Quittungen und Anzahlungen erscheinen hier nicht. Teilzahlungen verringern den offenen Betrag. Die nächste Stufe gibt es erst, wenn das vorige Schreiben versendet ist
        (E-Mail oder Vermerk „per Post“) und dessen Zahlungsfrist abgelaufen ist.
      </p>
      {items.length === 0 ? (
        <Empty title="Keine überfälligen Rechnungen">Alle ausgestellten Rechnungen sind bezahlt oder noch nicht fällig.</Empty>
      ) : (
        <DunningOverviewTable items={items} canWrite={auth.can("invoices.write")} />
      )}
      <p className="mt-4 text-xs text-muted">Erstellte Schreiben öffnen Sie über „Letztes Schreiben“ oder auf der Rechnung (Drucken, E-Mail, Versandvermerk).</p>
    </div>
  );
}
