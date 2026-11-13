import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Checkbox, Field, Input, LinkButton, Stat, Textarea } from "@/components/ui";
import { promoLandingUrl, trialDaysLabel } from "@/lib/promo-codes";
import { PLACEHOLDERS, PLACEHOLDER_HELP } from "@/lib/vertrieb/constants";
import { replyRate, STAGE_LABEL, STAGES } from "@/lib/vertrieb/pipeline";
import { requirePlatformAdmin } from "@/server/platform";
import { getSalesSettings } from "@/server/vertrieb";
import { campaignStats, campaignTemplates, getCampaign, loadPipeline, stageCounts } from "@/server/vertrieb-pipeline";
import { resetCampaignTemplatesAction, saveCampaignTemplatesAction, updateCampaignAction } from "../../actions";
import { TemplatesForm } from "../../vorlagen/templates-form";

export const metadata = { title: "Kampagne · Vertrieb" };

export default async function CampaignPage({ params }: PageProps<"/plattform/vertrieb/kampagnen/[id]">) {
  await requirePlatformAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await getCampaign(id);
  if (!c) notFound();
  const [items, settings] = await Promise.all([loadPipeline(), getSalesSettings()]);
  const s = (await campaignStats(items, [c.id])).get(c.id)!;
  const counts = stageCounts(items.filter((l) => l.campaignId === c.id));
  const own = campaignTemplates(c);
  const rate = replyRate(s.contacted, s.replied);
  const activeCode = s.codes.find((x) => x.active);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h2 className="font-display text-2xl font-semibold">{c.name} {!c.active ? <Badge tone="neutral">beendet</Badge> : null}</h2>
          {c.notes ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{c.notes}</p> : null}
        </div>
        <LinkButton href={`/plattform/vertrieb?kampagne=${c.id}`} variant="secondary">Praxen der Kampagne anzeigen</LinkButton>
      </div>

      <section aria-label="Kennzahlen" className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat tone="neutral" label="Praxen" value={s.leads} sub={`${s.contacted} angeschrieben`} />
        <Stat tone="info" label="Gesendet" value={s.sent} />
        <Stat tone="accent" label="Fehlgeschlagen" value={s.failed} />
        <Stat tone="warn" label="Antworten" value={s.replied} sub={rate === null ? "manuell erfasst" : `${rate} % · manuell erfasst`} />
        <Stat tone="info" label="Tests per Code" value={s.tests} />
        <Stat tone="primary" label="Kunden" value={s.converted} sub="aus Code-Einlösungen" />
      </section>
      <p className="text-sm text-muted">Stufen: {STAGES.map((st) => `${STAGE_LABEL[st]} ${counts[st]}`).join(" · ")}</p>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-3">
          <h3 className="font-display text-xl font-semibold">Vorlagen-Variante</h3>
          <p className="text-sm text-muted">
            {own ? "Diese Kampagne nutzt eigene Vorlagen." : "Noch keine eigenen Vorlagen – es gelten die Standardvorlagen. Speichern legt eine eigene Variante an."}
            {" "}Abstände und Impressum kommen aus den Einstellungen.
          </p>
          <TemplatesForm action={saveCampaignTemplatesAction} templates={own ?? settings.templates} delays={settings.delays} hidden={{ id: c.id }} />
          {own ? (
            <form action={resetCampaignTemplatesAction}>
              <input type="hidden" name="id" value={c.id} />
              <button className="text-sm font-semibold text-primary">Eigene Vorlagen löschen (wieder Standardvorlagen)</button>
            </form>
          ) : null}
        </div>
        <div className="flex flex-col gap-5">
          <Card className="text-sm">
            <h3 className="font-display text-lg font-semibold">Aktionscode</h3>
            {activeCode ? (
              <>
                <p className="mt-2"><span className="font-mono font-semibold">{activeCode.code}</span> · {trialDaysLabel(activeCode.trialDays)} Testphase</p>
                <p className="mt-1 break-all text-muted">{promoLandingUrl(process.env.PUBLIC_URL, activeCode.code)}</p>
              </>
            ) : (
              <p className="mt-2 text-muted">Kein aktiver Code. Leads mit Vorlagen, die {"{{code}}"} oder {"{{link}}"} nutzen, werden beim Versand übersprungen.</p>
            )}
            <LinkButton href={`/plattform/vertrieb/aktionscodes?kampagne=${c.id}`} variant="secondary" className="mt-3">Aktionscodes verwalten</LinkButton>
          </Card>
          <Card>
            <h3 className="mb-3 font-display text-lg font-semibold">Kampagne bearbeiten</h3>
            <ActionForm action={updateCampaignAction}>
              <input type="hidden" name="id" value={c.id} />
              <Field label="Name *"><Input name="name" required maxLength={120} defaultValue={c.name} /></Field>
              <Field label="Notiz (intern)"><Textarea name="notes" maxLength={2000} rows={3} defaultValue={c.notes ?? ""} /></Field>
              <Checkbox name="active" defaultChecked={c.active} label="aktiv (in Sammelaktionen auswählbar)" />
            </ActionForm>
          </Card>
          <Card className="text-sm">
            <h3 className="font-display text-lg font-semibold">Platzhalter</h3>
            <ul className="mt-2 flex flex-col gap-1.5">
              {PLACEHOLDERS.map((p) => <li key={p}><code>{`{{${p}}}`}</code> – {PLACEHOLDER_HELP[p]}</li>)}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
