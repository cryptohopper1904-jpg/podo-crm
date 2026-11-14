import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, LinkButton, Stat, cx } from "@/components/ui";
import { dateTimeDe } from "@/lib/format";
import { describeMailSettings, resolveMailSettings } from "@/integrations/mail/mail";
import { LEAD_STATUSES, MAX_PER_CLICK, MAX_PER_DAY, STATUS_LABEL, isLeadStatus } from "@/lib/vertrieb/constants";
import { isRunning } from "@/lib/vertrieb/lead-search";
import { isStage, replyRate, STAGE_HINT, STAGE_LABEL, STAGES, stageLabel, type Stage } from "@/lib/vertrieb/pipeline";
import { requirePlatformAdmin } from "@/server/platform";
import { getLeadSearch } from "@/server/lead-search";
import { getSalesSettings, sendStats, settingsProblems } from "@/server/vertrieb";
import { filterPipeline, leadSources, listCampaigns, loadPipeline, salesDashboard, stageCounts, type PipelineFilter, type PipelineItem } from "@/server/vertrieb-pipeline";
import { runLeadSearchAction } from "./actions";
import { LeadTable } from "./lead-table";

export const metadata = { title: "Vertrieb" };

const str = (v: unknown, max = 100) => (typeof v === "string" ? v.slice(0, max) : "");
const BOARD_LIMIT = 25;

const stageTone = (s: Stage) => (s === "kunde" ? "primary" : s === "test" ? "info" : s === "geantwortet" ? "warn" : s === "aus" ? "accent" : "neutral");

/** Link mit geänderten Suchparametern (leere Werte fallen weg) */
function hrefWith(sp: Record<string, string | string[] | undefined>, patch: Record<string, string | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) p.set(k, v);
  for (const [k, v] of Object.entries(patch)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  const q = p.toString();
  return `/plattform/vertrieb${q ? `?${q}` : ""}`;
}

export default async function VertriebPage({ searchParams }: PageProps<"/plattform/vertrieb">) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const filter: PipelineFilter = {
    stage: isStage(sp.stufe) ? sp.stufe : null,
    status: typeof sp.status === "string" && isLeadStatus(sp.status) ? sp.status : null,
    q: str(sp.q) || null,
    source: str(sp.quelle, 120) || null,
    email: sp.email === "mit" || sp.email === "ohne" ? sp.email : null,
    named: sp.namen === "1",
    consent: sp.einwilligung === "mit" || sp.einwilligung === "ohne" ? sp.einwilligung : null,
    maxKm: /^\d{1,4}$/.test(str(sp.km)) ? Number(sp.km) : null,
    campaign: sp.kampagne === "ohne" || /^[0-9a-f-]{36}$/i.test(str(sp.kampagne)) ? str(sp.kampagne) : null,
  };
  const board = sp.ansicht === "board";
  const [all, stats, settings, ls, campaigns] = await Promise.all([loadPipeline(), sendStats(), getSalesSettings(), getLeadSearch(), listCampaigns()]);
  const dash = await salesDashboard(all);
  // Stufen-Zähler gelten für alle übrigen Filter (ohne den Stufen-Filter selbst)
  const withoutStage = filterPipeline(all, { ...filter, stage: null });
  const counts = stageCounts(withoutStage);
  const leads = filter.stage ? withoutStage.filter((l) => l.stage === filter.stage) : withoutStage;
  const sources = leadSources(all);
  const rate = replyRate(dash.contacted, dash.replied);

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
  const anyFilter = Object.entries(filter).some(([k, v]) => k !== "stage" && v !== null && v !== false);

  return (
    <div className="flex flex-col gap-5">
      {sp.hinweis === "abgemeldet" ? <p role="status" className="rounded-xl bg-primary-soft px-4 py-3 text-sm font-medium text-primary-soft-text">Abgemeldet: Die Adresse steht auf der Sperrliste, der Eintrag wurde samt Verlauf gelöscht.</p> : null}
      <section aria-label="Kennzahlen" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat tone="neutral" label="Leads gesamt" value={dash.leads} sub={`${dash.newThisWeek} neu diese Woche (${dash.newFromSearch} aus der Praxissuche) · ${dash.withEmail} mit E-Mail · ${dash.withConsent} mit Einwilligung`} />
        <Stat tone="info" label="Mails gesendet" value={dash.mailsSent} sub={`${dash.mailsFailed} fehlgeschlagen${dash.mailsMock ? ` · ${dash.mailsMock} im Testmodus` : ""} · ${stats.sentLast24h}/${MAX_PER_DAY} in 24 h`} />
        <Stat tone="warn" label="Antwortquote" value={rate === null ? "–" : `${rate} %`} sub={`${dash.replied} von ${dash.contacted} angeschriebenen Praxen`} />
        <Stat tone="info" label="Tests" value={dash.tests} sub={`gestartete Tests aus der Pipeline · ${dash.redemptions} Aktionscodes eingelöst`} />
        <Stat tone="primary" label="Kunden" value={dash.customers} sub="bezahltes Abo bzw. Status „Kunde“" />
      </section>

      <nav aria-label="Pipeline-Stufen" className="flex flex-wrap gap-2">
        <Link href={hrefWith(sp, { stufe: null })} aria-current={!filter.stage ? "page" : undefined} className={cx("rounded-xl border px-3 py-2 text-sm font-semibold", !filter.stage ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-surface hover:bg-surface-2")}>
          Alle <span className="tabular-nums">({withoutStage.length})</span>
        </Link>
        {STAGES.map((s) => (
          <Link
            key={s}
            href={hrefWith(sp, { stufe: s })}
            title={STAGE_HINT[s]}
            aria-current={filter.stage === s ? "page" : undefined}
            className={cx("rounded-xl border px-3 py-2 text-sm font-semibold", filter.stage === s ? "border-primary bg-primary-soft text-primary-soft-text" : "border-border bg-surface hover:bg-surface-2")}
          >
            {STAGE_LABEL[s]} <span className="tabular-nums">({counts[s]})</span>
          </Link>
        ))}
        <span className="ml-auto flex gap-2">
          <Link href={hrefWith(sp, { ansicht: null })} aria-current={!board ? "page" : undefined} className={cx("rounded-xl px-3 py-2 text-sm font-semibold", !board ? "bg-surface-2" : "hover:bg-surface-2")}>Liste</Link>
          <Link href={hrefWith(sp, { ansicht: "board" })} aria-current={board ? "page" : undefined} className={cx("rounded-xl px-3 py-2 text-sm font-semibold", board ? "bg-surface-2" : "hover:bg-surface-2")}>Board</Link>
        </span>
      </nav>

      <form className="flex flex-wrap items-end gap-2" role="search">
        {filter.stage ? <input type="hidden" name="stufe" value={filter.stage} /> : null}
        {board ? <input type="hidden" name="ansicht" value="board" /> : null}
        <label className="flex flex-col gap-1 text-sm font-medium">
          Suche
          <input name="q" defaultValue={filter.q ?? ""} placeholder="Name, E-Mail, Ort, PLZ" className="h-10 w-56 rounded-xl border border-border bg-surface px-3 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Umkreis (km)
          <input name="km" inputMode="numeric" defaultValue={filter.maxKm ?? ""} placeholder="alle" className="h-10 w-24 rounded-xl border border-border bg-surface px-3 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Quelle
          <select name="quelle" defaultValue={filter.source ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="">alle</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          E-Mail
          <select name="email" defaultValue={filter.email ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="">egal</option>
            <option value="mit">mit E-Mail</option>
            <option value="ohne">ohne E-Mail</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Einwilligung
          <select name="einwilligung" defaultValue={filter.consent ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="">egal</option>
            <option value="mit">dokumentiert</option>
            <option value="ohne">fehlt</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Kampagne
          <select name="kampagne" defaultValue={filter.campaign ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="">alle</option>
            <option value="ohne">ohne Kampagne</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (beendet)"}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Status
          <select name="status" defaultValue={filter.status ?? ""} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
            <option value="">alle</option>
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="flex h-10 items-center gap-2 text-sm font-medium">
          <input type="checkbox" name="namen" value="1" defaultChecked={filter.named} className="size-5" /> nur „Adresse mit Namensbezug“
        </label>
        <button className="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold hover:bg-surface-2">Filtern</button>
        {anyFilter ? <Link href={hrefWith({}, { stufe: filter.stage ?? null, ansicht: board ? "board" : null })} className="h-10 px-2 py-2 text-sm font-semibold text-primary">Filter zurücksetzen</Link> : null}
        <div className="ml-auto">
          <LinkButton href="/plattform/vertrieb/neu" variant="secondary">Praxis anlegen</LinkButton>
        </div>
      </form>

      <Card className="text-sm">
        <p>
          Versand: {mail} · In den letzten 24 Stunden gesendet: <strong className="tabular-nums">{stats.sentLast24h}</strong> von {MAX_PER_DAY} · höchstens {MAX_PER_CLICK} je Klick.
          Abstände: Mail 2 nach {settings.delays.delay2Days} Tagen, Mail 3 nach weiteren {settings.delays.delay3Days} Tagen. Es wird nie automatisch gesendet –
          und nur an Praxen mit dokumentierter Einwilligung (Praxissuche und Import sammeln nur Kontaktdaten).
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

      {board ? (
        <Board items={leads} filterStage={filter.stage ?? null} sp={sp} />
      ) : (
        <LeadTable
          campaigns={campaigns.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }))}
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
            named: l.named,
            stage: l.stage,
            stageLabel: stageLabel(l.stage, l.step),
            campaignName: l.campaignName,
            consent: !!l.consentAt,
            orgName: l.org ? `${l.org.name}${l.org.via === "domain" ? " – Zuordnung unsicher (Domain)" : ""}` : null,
          }))}
        />
      )}
    </div>
  );
}

function Board({ items, filterStage, sp }: { items: PipelineItem[]; filterStage: Stage | null; sp: Record<string, string | string[] | undefined> }) {
  const stages = filterStage ? [filterStage] : STAGES;
  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
      {stages.map((s) => {
        const col = items.filter((l) => l.stage === s);
        return (
          <section key={s} aria-label={STAGE_LABEL[s]} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-surface-2 p-3">
            <h2 className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span>{STAGE_LABEL[s]}</span>
              <Badge tone={stageTone(s)}>{col.length}</Badge>
            </h2>
            <p className="text-xs text-muted">{STAGE_HINT[s]}</p>
            {col.slice(0, BOARD_LIMIT).map((l) => (
              <Link key={l.id} href={`/plattform/vertrieb/${l.id}`} className="rounded-xl border border-border bg-surface px-3 py-2 text-sm hover:border-primary">
                <p className="truncate font-semibold">{l.name}</p>
                <p className="truncate text-xs text-muted">
                  {[l.city, l.distanceKm != null ? `${l.distanceKm} km` : null, s === "angeschrieben" ? `Mail ${l.step}` : null, l.org ? `Praxis: ${l.org.name}${l.org.via === "domain" ? " (unsicher, Domain)" : ""}` : null].filter(Boolean).join(" · ") || "–"}
                </p>
                {l.campaignName ? <p className="truncate text-xs text-muted">Kampagne: {l.campaignName}</p> : null}
              </Link>
            ))}
            {col.length > BOARD_LIMIT ? (
              <Link href={hrefWith(sp, { stufe: s, ansicht: null })} className="text-sm font-semibold text-primary">alle {col.length} als Liste</Link>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
