import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, Empty, Field, Input, Table, Textarea } from "@/components/ui";
import { dateDe } from "@/lib/format";
import { replyRate } from "@/lib/vertrieb/pipeline";
import { requirePlatformAdmin } from "@/server/platform";
import { campaignStats, listCampaigns, loadPipeline } from "@/server/vertrieb-pipeline";
import { createCampaignAction } from "../actions";

export const metadata = { title: "Kampagnen · Vertrieb" };

export default async function CampaignsPage() {
  await requirePlatformAdmin();
  const [campaigns, items] = await Promise.all([listCampaigns(), loadPipeline()]);
  const stats = await campaignStats(items, campaigns.map((c) => c.id));
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Eine Kampagne bündelt Praxen, eine eigene Vorlagen-Variante (sonst die Standardvorlagen) und einen Aktionscode für {"{{code}}"}/{"{{link}}"}.
          Versendet wird weiterhin nur per Klick auf der Pipeline-Seite (Filter „Kampagne“).
        </p>
        {campaigns.length ? (
          <Table>
            <thead>
              <tr><th>Kampagne</th><th>Praxen</th><th>Gesendet</th><th>Fehler</th><th>Antworten</th><th>Tests (Code)</th><th>Kunden</th><th>Code</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const s = stats.get(c.id);
                const rate = replyRate(s?.contacted ?? 0, s?.replied ?? 0);
                return (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/plattform/vertrieb/kampagnen/${c.id}`} className="font-semibold text-primary">{c.name}</Link>
                      <p className="text-xs text-muted">seit {dateDe(c.createdAt)}{c.templates ? " · eigene Vorlagen" : ""}</p>
                      {!c.active ? <Badge tone="neutral">beendet</Badge> : null}
                    </td>
                    <td className="tabular-nums">{s?.leads ?? 0}</td>
                    <td className="tabular-nums">{s?.sent ?? 0}</td>
                    <td className="tabular-nums">{s?.failed ?? 0}</td>
                    <td className="tabular-nums">{s?.replied ?? 0}{rate !== null ? <span className="text-xs text-muted"> ({rate} %)</span> : null}</td>
                    <td className="tabular-nums">{s?.tests ?? 0}</td>
                    <td className="tabular-nums">{s?.converted ?? 0}</td>
                    <td className="text-sm">{s?.codes.find((x) => x.active)?.code ?? <span className="text-muted">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Empty title="Noch keine Kampagne">Rechts eine Kampagne anlegen, dann Praxen auf der Pipeline-Seite per Sammelaktion hinzufügen.</Empty>
        )}
      </div>
      <Card>
        <h2 className="mb-3 font-display text-xl font-semibold">Neue Kampagne</h2>
        <ActionForm action={createCampaignAction} submit="Kampagne anlegen">
          <Field label="Name *"><Input name="name" required maxLength={120} placeholder="z. B. Herbst 2026 – 3 Monate gratis" /></Field>
          <Field label="Notiz (intern)"><Textarea name="notes" maxLength={2000} rows={3} /></Field>
        </ActionForm>
      </Card>
    </div>
  );
}
