import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { dateDe, dateTimeDe } from "@/lib/format";
import { isPlanId, PLANS } from "@/lib/plans";
import { LEAD_STATUSES, SEQUENCE_STEPS, STATUS_LABEL, isLeadStatus } from "@/lib/vertrieb/constants";
import { delayBefore } from "@/lib/vertrieb/eligibility";
import { deriveStage, stageLabel, statusLabel } from "@/lib/vertrieb/pipeline";
import { requirePlatformAdmin } from "@/server/platform";
import { getLead, getSalesSettings } from "@/server/vertrieb";
import { leadOrg, leadTimeline, listCampaigns, type TimelineEntry } from "@/server/vertrieb-pipeline";
import { addNoteAction, consentAction, deleteLeadAction, markRepliedAction, removeConsentAction, setLeadCampaignAction, setStatusAction, updateLeadAction } from "../actions";
import { LeadForm } from "../lead-form";

export const metadata = { title: "Praxis · Vertrieb" };

function describe(e: TimelineEntry): { title: string; detail?: string | null; tone?: "danger" } {
  switch (e.kind) {
    case "created":
      return { title: "Eintrag angelegt" };
    case "send":
      return { title: `Mail ${e.step}`, detail: e.ok ? (e.mock ? "Testmodus – nicht wirklich versendet" : "versendet") : `Fehler: ${e.error ?? "unbekannt"}`, tone: e.ok ? undefined : "danger" };
    case "note":
      return { title: "Notiz", detail: e.text };
    case "reply":
      return { title: "Antwort erhalten", detail: e.meta?.to ? `Status ${statusLabel(String(e.meta.from))} → ${statusLabel(String(e.meta.to))}` : null };
    case "status":
      return { title: "Status geändert", detail: `${statusLabel(String(e.meta?.from ?? ""))} → ${statusLabel(String(e.meta?.to ?? ""))}${e.meta?.via === "link" ? " (Abmeldelink)" : ""}` };
    case "campaign":
      return { title: e.text ? `Kampagne „${e.text}“` : "Aus Kampagne entfernt" };
    case "consent":
      return e.meta?.removed ? { title: "Einwilligung entfernt", detail: e.meta.reason ? String(e.meta.reason) : null } : { title: "Einwilligung dokumentiert", detail: e.text };
  }
}

export default async function LeadPage({ params }: PageProps<"/plattform/vertrieb/[id]">) {
  await requirePlatformAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getLead(id);
  if (!data) notFound();
  const { lead, suppressed } = data;
  const [settings, timeline, org, campaigns] = await Promise.all([getSalesSettings(), leadTimeline(lead), leadOrg(lead), listCampaigns()]);
  const stage = deriveStage({ ...lead, suppressed }, org);
  const nextStep = lead.step + 1;
  const dueAt = lead.step > 0 && lead.step < SEQUENCE_STEPS && lead.lastSentAt ? new Date(lead.lastSentAt.getTime() + delayBefore(nextStep, settings.delays) * 86_400_000) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
      <div className="flex flex-col gap-5">
        <Card>
          <h2 className="mb-4 font-display text-xl font-semibold">{lead.name}</h2>
          <LeadForm action={updateLeadAction} submit="Speichern" values={{ ...lead }} />
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Verlauf</h2>
          <ActionForm action={addNoteAction} submit="Notiz speichern" className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <label className="sr-only" htmlFor="note">Notiz</label>
            <Textarea id="note" name="text" required maxLength={2000} rows={3} placeholder="z. B. Telefonat am …, Rückruf vereinbart" />
          </ActionForm>
          <ol className="mt-4 flex flex-col gap-2 text-sm">
            {timeline.map((e, i) => {
              const d = describe(e);
              return (
                <li key={i} className="rounded-xl border border-border px-3 py-2">
                  <p className="font-semibold">{d.title} <span className="font-normal text-muted">· {dateTimeDe(e.at)}</span></p>
                  {d.detail ? <p className={d.tone === "danger" ? "whitespace-pre-wrap text-danger" : "whitespace-pre-wrap text-muted"}>{d.detail}</p> : null}
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-sm">
            {lead.step >= SEQUENCE_STEPS ? "Sequenz abgeschlossen." : dueAt ? `Mail ${nextStep} fällig ab ${dateDe(dueAt)}.` : lead.step === 0 ? "Mail 1 kann gesendet werden." : null}
          </p>
        </Card>
      </div>
      <div className="flex flex-col gap-5">
        <Card>
          <h2 className="font-display text-lg font-semibold">Stufe und Status</h2>
          <p className="mt-1 flex flex-wrap gap-2 text-sm">
            <Badge tone="primary">{stageLabel(stage, lead.step)}</Badge>
            <Badge tone="info">{isLeadStatus(lead.status) ? STATUS_LABEL[lead.status] : lead.status}</Badge>
            {suppressed ? <Badge tone="accent">auf der Sperrliste</Badge> : null}
            {lead.repliedAt ? <Badge tone="warn">Antwort {dateDe(lead.repliedAt)}</Badge> : null}
          </p>
          <form action={markRepliedAction} className="mt-3">
            <input type="hidden" name="id" value={lead.id} />
            <Button type="submit" className="h-10">Antwort erhalten</Button>
          </form>
          <form action={setStatusAction} className="mt-3 flex items-center gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <label className="sr-only" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={lead.status} className="h-10 flex-1 rounded-xl border border-border bg-surface px-3 text-sm">
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <Button type="submit" variant="secondary" className="h-10">Setzen</Button>
          </form>
          <p className="mt-2 text-xs text-muted">„Antwort erhalten“ beendet die Sequenz (Status „Geantwortet“). „Interessiert“, „Kein Interesse“, „Abgemeldet“ und „Kunde“ beenden sie ebenfalls. „Abgemeldet“ sperrt die Adresse dauerhaft und löscht diesen Eintrag samt Verlauf (Widerspruch).</p>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Einwilligung (§ 7 Abs. 2 Nr. 2 UWG)</h2>
          {lead.consentAt ? (
            <>
              <p className="mt-2 text-sm"><Badge tone="primary">dokumentiert {dateDe(lead.consentAt)}</Badge></p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{lead.consentNote}</p>
              <form action={removeConsentAction} className="mt-2">
                <input type="hidden" name="id" value={lead.id} />
                <button className="text-sm font-semibold text-danger">Einwilligung entfernen</button>
              </form>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm"><Badge tone="accent">keine Einwilligung</Badge> – an diese Praxis wird keine Mail gesendet.</p>
              {lead.email ? (
                <ActionForm action={consentAction} submit="Einwilligung dokumentieren" className="mt-3 flex flex-col gap-2">
                  <input type="hidden" name="id" value={lead.id} />
                  <label className="text-sm font-medium" htmlFor="consentNote">Wortlaut, Kanal und Datum der Einwilligung *</label>
                  <Textarea id="consentNote" name="note" required minLength={3} maxLength={500} rows={3} placeholder="z. B. E-Mail vom 12.11.2026: „Bitte schicken Sie mir weitere Infos per E-Mail.“ / Messe XY 10.11.2026, unterschriebenes Formular „Ja, ich möchte Informationen per E-Mail“" />
                  <p className="text-xs text-muted">
                    Nötig ist eine ausdrückliche Einwilligung in Informationen per E-Mail (z. B. Anfrage mit Wunsch nach weiteren Infos per E-Mail,
                    Messe mit dokumentierter Zustimmung). Eine bloße Anfrage oder eine öffentliche Adresse genügt nicht.
                  </p>
                </ActionForm>
              ) : (
                <p className="mt-1 text-xs text-muted">Zuerst eine E-Mail-Adresse eintragen.</p>
              )}
            </>
          )}
          <p className="mt-2 text-xs text-muted">Gilt für die eingetragene Adresse; ändert sich die E-Mail, wird die Einwilligung entfernt.</p>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Registrierte Praxis</h2>
          {org ? (
            <div className="mt-2 text-sm">
              <p>
                <Link href={`/plattform#praxis-${org.id}`} className="font-semibold text-primary">{org.name}</Link>{" "}
                {org.via === "domain" ? <Badge tone="warn">unsicher (Domain)</Badge> : <span className="text-muted">({org.via === "code" ? "persönlicher Aktionscode" : "gleiche E-Mail"})</span>}
              </p>
              <p className="mt-1">
                Tarif {isPlanId(org.plan) ? PLANS[org.plan].label : org.plan} · {org.converted ? "zahlt" : org.subscriptionStatus === "trialing" ? `Test bis ${dateDe(org.trialEndsAt)}` : org.subscriptionStatus} · registriert {dateDe(org.createdAt)}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Noch keine passende Registrierung (Zuordnung über persönlichen Aktionscode, E-Mail oder Domain).</p>
          )}
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Kampagne</h2>
          <form action={setLeadCampaignAction} className="mt-2 flex items-center gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <label className="sr-only" htmlFor="campaignId">Kampagne</label>
            <select id="campaignId" name="campaignId" defaultValue={lead.campaignId ?? ""} className="h-10 flex-1 rounded-xl border border-border bg-surface px-3 text-sm">
              <option value="">keine</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (beendet)"}</option>)}
            </select>
            <Button type="submit" variant="secondary" className="h-10">Setzen</Button>
          </form>
          <p className="mt-2 text-xs text-muted">Die Kampagne bestimmt Vorlagen-Variante und Aktionscode ({"{{code}}"}, {"{{link}}"}) der nächsten Mail.</p>
        </Card>
        <Card>
          <h2 className="font-display text-lg font-semibold">Löschen</h2>
          <form action={deleteLeadAction} className="mt-2 flex flex-col gap-2 text-sm">
            <input type="hidden" name="id" value={lead.id} />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="confirm" value="ja" required className="size-5" /> Eintrag endgültig löschen
            </label>
            <p className="text-xs text-muted">Eine Sperre (Abmeldung) bleibt bestehen, auch wenn der Eintrag gelöscht wird. Der Verlauf wird mit gelöscht.</p>
            <div><Button type="submit" variant="danger" className="h-10">Löschen</Button></div>
          </form>
          <p className="mt-3 text-xs text-muted">Angelegt {dateTimeDe(lead.createdAt)} · geändert {dateTimeDe(lead.updatedAt)}</p>
        </Card>
      </div>
    </div>
  );
}
