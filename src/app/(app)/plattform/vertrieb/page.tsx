import { ActionForm } from "@/components/action-form";
import { Card, LinkButton } from "@/components/ui";
import { dateTimeDe } from "@/lib/format";
import { describeMailSettings, resolveMailSettings } from "@/integrations/mail/mail";
import { LEAD_STATUSES, MAX_PER_CLICK, MAX_PER_DAY, STATUS_LABEL, isLeadStatus } from "@/lib/vertrieb/constants";
import { requirePlatformAdmin } from "@/server/platform";
import { isRunning } from "@/lib/vertrieb/lead-search";
import { getLeadSearch, NAMED_NOTE } from "@/server/lead-search";
import { getSalesSettings, listLeads, sendStats, settingsProblems, statusCounts } from "@/server/vertrieb";
import { runLeadSearchAction } from "./actions";
import { LeadTable } from "./lead-table";

export const metadata = { title: "Vertrieb" };

export default async function VertriebPage({ searchParams }: PageProps<"/plattform/vertrieb">) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const status = typeof sp.status === "string" && isLeadStatus(sp.status) ? sp.status : null;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const [leads, counts, stats, settings, ls] = await Promise.all([listLeads({ status, q }), statusCounts(), sendStats(), getSalesSettings(), getLeadSearch()]);
  const run = ls.lastRun;
  const searchLine = !ls.center
    ? "Praxissuche: kein Startort hinterlegt (Einstellungen)."
    : [
        `Praxissuche nachts: ${ls.enabled ? "an" : "aus"}`,
        run
          ? `Letzter Suchlauf: ${dateTimeDe(run.at)}${run.manual ? " (manuell)" : ""}, Ring bis ${run.outerKm} km, ${run.added} neue Praxen (${run.withEmail} mit E-Mail${run.enriched ? `, ${run.enriched} nachträglich ergänzt` : ""})${run.error ? ` – Fehler: ${run.error}` : ""}`
          : "noch kein Suchlauf",
        isRunning(ls) ? "Suche läuft gerade …" : ls.doneKm >= ls.maxKm ? `Höchstradius ${ls.maxKm} km erreicht` : `nächster Ring: ${ls.doneKm}–${Math.min(ls.doneKm + ls.ringKm, ls.maxKm)} km`,
      ].join(" · ");
  const problems = settingsProblems(settings);
  const mail = describeMailSettings(resolveMailSettings({ connection: null, env: process.env, practice: { name: "PodoHero", email: null }, platform: true }));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex flex-wrap items-end gap-2" role="search">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Status
            <select name="status" defaultValue={status ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
              <option value="">Alle ({total})</option>
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]} ({counts[s] ?? 0})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Suche
            <input name="q" defaultValue={q} placeholder="Name, E-Mail, Ort, PLZ" className="h-10 w-64 rounded-xl border border-border bg-surface px-3 text-sm" />
          </label>
          <button className="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold hover:bg-surface-2">Filtern</button>
        </form>
        <div className="ml-auto">
          <LinkButton href="/plattform/vertrieb/neu" variant="secondary">Praxis anlegen</LinkButton>
        </div>
      </div>

      <Card className="text-sm">
        <p>
          Versand: {mail} · In den letzten 24 Stunden gesendet: <strong className="tabular-nums">{stats.sentLast24h}</strong> von {MAX_PER_DAY} · höchstens {MAX_PER_CLICK} je Klick.
          Abstände: Mail 2 nach {settings.delays.delay2Days} Tagen, Mail 3 nach weiteren {settings.delays.delay3Days} Tagen. Es wird nie automatisch gesendet.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
          <p className="flex-1">{searchLine}</p>
          <ActionForm action={runLeadSearchAction} submit="Jetzt suchen" className="flex items-center gap-2">{null}</ActionForm>
        </div>
        {problems.length ? (
          <div role="alert" className="mt-3 rounded-xl bg-accent-soft px-4 py-3 text-accent-soft-text">
            <p className="font-semibold">Vor dem ersten Versand ergänzen (Einstellungen):</p>
            <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        ) : null}
      </Card>

      <LeadTable
        leads={leads.map((l) => ({
          id: l.id,
          name: l.name,
          contactPerson: l.contactPerson,
          email: l.email,
          city: [l.zip, l.city].filter(Boolean).join(" ") || null,
          distanceKm: l.distanceKm,
          status: l.status,
          step: l.step,
          lastSentAt: l.lastSentAt?.toISOString() ?? null,
          suppressed: l.suppressed,
          named: !!l.notes?.startsWith(NAMED_NOTE),
        }))}
      />
    </div>
  );
}
