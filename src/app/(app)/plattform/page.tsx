import { Badge, Card, Table } from "@/components/ui";
import { dateDe } from "@/lib/format";
import { PLAN_IDS, PLANS, isPlanId, VOICE_ADDON_PLANS } from "@/lib/plans";
import { audit } from "@/lib/audit";
import { listPractices, requirePlatformAdmin } from "@/server/platform";
import { platformUsage } from "@/server/platform-stats";
import { UsageDashboard } from "./usage-dashboard";
import { OpenDemoButton } from "@/components/org-switcher";
import { loadSwitcherModel } from "@/server/org-switcher";
import { ResetButton } from "./reset-button";
import { WEBSITE_ADDON_PLANS } from "@/lib/website";
import { enterSupportAction, extendTrialAction, setPlanAction, setVoiceAddonAction, setWebsiteAddonAction } from "./actions";

export const metadata = { title: "Plattform" };

const ERR: Record<string, string> = {
  "keine-freigabe": "Für diese Praxis gibt es keine gültige Support-Freigabe. Ohne Freigabe der Praxis ist kein Zugriff möglich.",
  eingabe: "Eingaben ungültig.",
};

export default async function PlatformPage({ searchParams }: PageProps<"/plattform">) {
  const row = await requirePlatformAdmin();
  const { fehler } = await searchParams;
  const practices = await listPractices(row.user.id);
  const usage = await platformUsage();
  const { demoOrgId } = await loadSwitcherModel({ userId: row.user.id, currentOrgId: row.session.organizationId, isPlatformAdmin: true, totpEnabled: true, support: false });
  // Plattform-weiter Eintrag (ohne Praxisbezug): wer hat wann die Nutzungsdaten angesehen
  await audit({ userId: row.user.id, action: "platform.view", entity: "platform", meta: { practices: usage.summary.practices } });
  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-semibold">Plattform</h1>
        {demoOrgId ? <OpenDemoButton organizationId={demoOrgId} /> : null}
      </div>
      <p className="mt-1 text-sm text-muted">
        Betreiber-Konsole. Keine Patientendaten – nur Abo-Daten und Anzahlen. Änderungen werden im Protokoll der jeweiligen Praxis vermerkt.
        Support-Zugriff ist nur mit Freigabe der Praxis möglich.
      </p>
      {typeof fehler === "string" && ERR[fehler] ? <p role="alert" className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">{ERR[fehler]}</p> : null}
      <UsageDashboard usage={usage} />
      <h2 className="mt-10 font-display text-2xl font-semibold">Praxen verwalten</h2>
      <Card className="mt-4 p-0">
        <Table>
          <thead>
            <tr><th>Praxis</th><th>Tarif</th><th>Test bis</th><th>Plätze</th><th>Kund:innen</th><th>Termine 30 T.</th><th>Angelegt</th><th>Aktionen</th></tr>
          </thead>
          <tbody>
            {practices.map((p) => (
              <tr key={p.id}>
                <td className="font-semibold">{p.name}{p.demo ? <> <Badge tone="info">Demo</Badge></> : null}</td>
                <td><p>{isPlanId(p.plan) ? PLANS[p.plan].label : p.plan}</p><Badge tone={p.subscriptionStatus === "active" ? "primary" : p.subscriptionStatus === "trialing" ? "info" : "accent"}>{p.subscriptionStatus}</Badge></td>
                <td>{dateDe(p.trialEndsAt)}</td>
                <td className="tabular-nums">{p.usedSeats} / {p.seats}</td>
                <td className="tabular-nums">{p.patients}</td>
                <td className="tabular-nums">{p.appointments30d}</td>
                <td>{dateDe(p.createdAt)}</td>
                <td>
                  <div className="flex min-w-72 flex-col gap-2">
                    <form action={setPlanAction} className="flex items-center gap-2">
                      <input type="hidden" name="organizationId" value={p.id} />
                      <label className="sr-only" htmlFor={`plan-${p.id}`}>Tarif</label>
                      <select id={`plan-${p.id}`} name="plan" defaultValue={p.plan} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm">
                        {PLAN_IDS.map((id) => <option key={id} value={id}>{PLANS[id].label}</option>)}
                      </select>
                      <label className="sr-only" htmlFor={`seats-${p.id}`}>Plätze</label>
                      <input id={`seats-${p.id}`} name="seats" type="number" min={1} max={999} defaultValue={p.seats} className="h-9 w-16 rounded-lg border border-border bg-surface px-2 text-sm" />
                      <button className="text-sm font-semibold text-primary">setzen</button>
                    </form>
                    <form action={extendTrialAction} className="flex items-center gap-2">
                      <input type="hidden" name="organizationId" value={p.id} />
                      <label className="sr-only" htmlFor={`days-${p.id}`}>Tage</label>
                      <input id={`days-${p.id}`} name="days" type="number" min={1} max={90} defaultValue={14} className="h-9 w-16 rounded-lg border border-border bg-surface px-2 text-sm" />
                      <button className="text-sm font-semibold text-primary">Test verlängern</button>
                    </form>
                    {isPlanId(p.plan) && VOICE_ADDON_PLANS.includes(p.plan) ? (
                      <form action={setVoiceAddonAction} className="flex items-center gap-2">
                        <input type="hidden" name="organizationId" value={p.id} />
                        <input type="hidden" name="on" value={p.voiceAddon ? "0" : "1"} />
                        <span className="text-xs">KI-Telefon-Zusatzmodul: {p.voiceAddon ? "aktiv" : "aus"}</span>
                        <button className="text-sm font-semibold text-primary">{p.voiceAddon ? "abschalten" : "aktivieren"}</button>
                      </form>
                    ) : null}
                    {isPlanId(p.plan) && WEBSITE_ADDON_PLANS.includes(p.plan) ? (
                      <form action={setWebsiteAddonAction} className="flex items-center gap-2">
                        <input type="hidden" name="organizationId" value={p.id} />
                        <input type="hidden" name="on" value={p.websiteAddon ? "0" : "1"} />
                        <span className="text-xs">Website-Zusatzmodul: {p.websiteAddon ? "aktiv" : "aus"}</span>
                        <button className="text-sm font-semibold text-primary">{p.websiteAddon ? "abschalten" : "aktivieren"}</button>
                      </form>
                    ) : null}
                    {p.activeGrantForMe ? (
                      <form action={enterSupportAction}>
                        <input type="hidden" name="organizationId" value={p.id} />
                        <button className="text-sm font-semibold text-danger">Support-Zugriff starten</button>
                      </form>
                    ) : <span className="text-xs text-muted">keine Support-Freigabe</span>}
                    {p.owners.map((o) => <ResetButton key={o.id} userId={o.id} label={o.email} />)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
