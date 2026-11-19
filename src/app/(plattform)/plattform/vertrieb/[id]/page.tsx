import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, Textarea, BackLink } from "@/components/ui";
import { berlinDateIso, dateDe, dateTimeDe } from "@/lib/format";
import {
  anyConsentValid,
  art14Deadline,
  art14Overdue,
  art14Text,
  CONSENT_KIND_LABEL,
  CONSENT_KINDS,
  deleteMonthsOf,
  emailConsentValid,
  isConsentKind,
  isExistingCustomerForRetention,
  minDeleteMonths,
  NO_CONSENT_CONTACT_HINT,
  originLabel,
  phoneConsentValid,
  phoneVisible,
  sourceLabel,
  type ConsentChannel,
} from "@/lib/vertrieb/dsgvo";
import type { Lead } from "@/server/vertrieb";
import { isPlanId, PLANS } from "@/lib/plans";
import { LEAD_STATUSES, SEQUENCE_STEPS, STATUS_LABEL, isLeadStatus } from "@/lib/vertrieb/constants";
import { delayBefore } from "@/lib/vertrieb/eligibility";
import { deriveStage, stageLabel, statusLabel } from "@/lib/vertrieb/pipeline";
import { requirePlatformAdmin } from "@/server/platform";
import { getLead, getSalesSettings } from "@/server/vertrieb";
import { leadOrg, leadTimeline, listCampaigns, type TimelineEntry } from "@/server/vertrieb-pipeline";
import { addNoteAction, art14NoticeAction, consentAction, deleteLeadAction, markRepliedAction, removeConsentAction, setLeadCampaignAction, setStatusAction, updateLeadAction } from "../actions";
import { LeadForm } from "../lead-form";
import { Art14Editor } from "../datenschutzhinweis/art14-editor";

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
    case "consent": {
      const ch = e.meta?.channelLabel ? ` (${String(e.meta.channelLabel)})` : e.meta?.channel === "email" ? " (E-Mail)" : "";
      return e.meta?.removed
        ? { title: `Einwilligung ${e.meta.reason ? "entfernt" : "widerrufen"}${ch}`, detail: e.meta.reason ? String(e.meta.reason) : null }
        : { title: `Einwilligung dokumentiert${ch}`, detail: [e.meta?.kindLabel ? `Erteilungsweg: ${String(e.meta.kindLabel)}` : null, e.meta?.date ? `erteilt am ${dateDe(String(e.meta.date))}` : null, e.text].filter(Boolean).join(" · ") };
    }
    case "letter":
      return { title: "Erstbrief mit Datenschutzhinweis versendet", detail: e.meta?.date ? `am ${dateDe(`${String(e.meta.date)}T12:00:00Z`)}` : null };
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
  const today = berlinDateIso();
  // Telefonnummer nur mit Telefon-Einwilligung oder bei Bestandskunden – sonst gelangt sie gar nicht erst in die Seite
  const showPhone = phoneVisible({ ...lead, org });
  // Löschlauf schont jede zugeordnete Praxis (vorsichtig), die Telefon-Anzeige zählt nur sichere Treffer (streng)
  const customer = isExistingCustomerForRetention({ status: lead.status, stage });
  const deadline = art14Deadline(lead.sourceRetrievedAt);
  const overdue = art14Overdue(lead, today);
  const { phone, ...leadWithoutPhone } = lead;
  const art14 = art14Text({
    quelle: sourceLabel(lead.source),
    abrufdatum: lead.sourceRetrievedAt ? dateDe(`${lead.sourceRetrievedAt}T12:00:00Z`) : null,
    loeschdatum: dateDe(lead.deleteAfter),
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_400px]">
      <div className="flex flex-col gap-5">
        <BackLink href="/plattform/vertrieb" label="Praxen" className="-mb-5 self-start" />
        <Card>
          <h2 className="mb-2 font-display text-xl font-semibold">{lead.name}</h2>
          {!emailConsentValid(lead) || !phoneConsentValid(lead) ? (
            <p role="note" className="mb-4 rounded-xl border-2 border-accent bg-accent-soft px-4 py-3 text-sm font-semibold text-accent-soft-text">{NO_CONSENT_CONTACT_HINT}</p>
          ) : null}
          <dl className="mb-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Herkunft</dt>
            <dd>{originLabel(lead.source, lead.sourceRetrievedAt)}</dd>
            <dt className="text-muted">Löschung</dt>
            <dd>
              {customer
                ? "entfällt (Bestandskunde)"
                : anyConsentValid(lead)
                  ? "entfällt, solange eine Einwilligung gilt (dann 24 Monate nach der letzten Antwort der Praxis)"
                  : `${dateDe(lead.deleteAfter)}${lead.deleteAfterLegacy ? " (Altbestand, Schonfrist)" : ""}`}
            </dd>
            <dt className="text-muted">Erstbrief</dt>
            <dd>
              {lead.art14NoticeAt
                ? `Datenschutzhinweis versendet am ${dateDe(`${lead.art14NoticeAt}T12:00:00Z`)}`
                : deadline
                  ? <>Erstbrief bis {dateDe(`${deadline}T12:00:00Z`)}{overdue ? <> <Badge tone="warn">überfällig</Badge></> : null}</>
                  : "Frist unbekannt (Abrufdatum fehlt)"}
            </dd>
            <dt className="text-muted">Telefon</dt>
            <dd>{showPhone ? (phone ?? "–") : phone ? "ausgeblendet (nur mit Einwilligung in Anrufe oder bei Bestandskunden)" : "–"}</dd>
          </dl>
          <LeadForm
            action={updateLeadAction}
            submit="Speichern"
            today={today}
            phoneHidden={!showPhone}
            phoneStored={!!phone}
            values={{ ...leadWithoutPhone, ...(showPhone ? { phone } : {}), deleteMonths: lead.deleteAfterLegacy ? null : deleteMonthsOf(lead.createdAt, lead.deleteAfter), deleteAfterLegacy: lead.deleteAfterLegacy, minDeleteMonths: minDeleteMonths(lead.createdAt), deleteAfterLabel: dateDe(lead.deleteAfter) }}
          />
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
          <h2 className="font-display text-lg font-semibold">Einwilligung (§ 7 UWG)</h2>
          <p className="mt-1 text-xs text-muted">Je Kanal getrennt: eine Einwilligung in E-Mails erlaubt keine Anrufe und umgekehrt.</p>
          <ConsentBlock lead={lead} channel="email" today={today} />
          <ConsentBlock lead={lead} channel="phone" today={today} />
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
        <Card>
          <h2 className="font-display text-lg font-semibold">Datenschutzhinweis (Art. 14 DSGVO)</h2>
          <p className="mt-1 text-sm">
            Für den ersten Kontakt per Brief – spätestens einen Monat nach dem Abruf der Daten
            {deadline ? ` (hier: bis ${dateDe(`${deadline}T12:00:00Z`)})` : ""}. Quelle, Abrufdatum und Löschdatum dieser Praxis sind eingesetzt.
          </p>
          <ActionForm action={art14NoticeAction} submit="Versand vermerken" className="mt-3 flex flex-col gap-2">
            <input type="hidden" name="id" value={lead.id} />
            <label className="text-sm font-medium" htmlFor="art14Date">Erstbrief versendet am</label>
            <input id="art14Date" name="date" type="date" required max={today} defaultValue={lead.art14NoticeAt ?? today} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm" />
          </ActionForm>
          <div className="mt-4">
            <Art14Editor template={art14} filename="datenschutzhinweis-art14.txt" />
          </div>
          <Link href="/plattform/vertrieb/datenschutzhinweis" className="mt-3 inline-block text-sm font-semibold text-primary">Vorlage ohne Praxisdaten</Link>
        </Card>
      </div>
    </div>
  );
}

/** Einwilligung eines Kanals: Stand (ja/nein, widerrufen) und Formular zum Dokumentieren bzw. Widerrufen. */
function ConsentBlock({ lead, channel, today }: { lead: Lead; channel: ConsentChannel; today: string }) {
  const email = channel === "email";
  const at = email ? lead.consentEmailAt : lead.consentPhoneAt;
  const kind = email ? lead.consentEmailKind : lead.consentPhoneKind;
  const note = email ? lead.consentEmailNote : lead.consentPhoneNote;
  const revoked = email ? lead.consentEmailRevokedAt : lead.consentPhoneRevokedAt;
  const valid = !!at && !revoked;
  const title = email ? "E-Mail (§ 7 Abs. 2 Nr. 2 UWG)" : "Telefon (§ 7 Abs. 2 Nr. 1 UWG)";
  const p = `consent-${channel}`;
  return (
    <section className="mt-4 border-t border-border pt-3">
      <h3 className="font-semibold">{title}</h3>
      {valid ? (
        <>
          <p className="mt-2 text-sm"><Badge tone="primary">ja – erteilt am {dateDe(at)}</Badge></p>
          <p className="mt-1 text-sm">Erteilungsweg: {isConsentKind(kind) ? CONSENT_KIND_LABEL[kind] : "nicht angegeben (vor der Erfassung des Erteilungswegs dokumentiert)"}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{note}</p>
          <form action={removeConsentAction} className="mt-2">
            <input type="hidden" name="id" value={lead.id} />
            <input type="hidden" name="channel" value={channel} />
            <button className="text-sm font-semibold text-danger">Widerruf vermerken</button>
          </form>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm">
            <Badge tone="accent">nein</Badge>
            {revoked ? ` – widerrufen am ${dateDe(revoked)} (erteilt am ${dateDe(at)})` : null}
            {email ? " – an diese Praxis wird keine Mail gesendet." : " – keine Werbeanrufe, Telefonnummer ausgeblendet (außer Bestandskunde)."}
          </p>
          {!email || lead.email ? (
            <ActionForm action={consentAction} submit={`Einwilligung (${email ? "E-Mail" : "Telefon"}) dokumentieren`} className="mt-3 flex flex-col gap-2">
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="channel" value={channel} />
              <label className="text-sm font-medium" htmlFor={`${p}-kind`}>Erteilungsweg *</label>
              <select id={`${p}-kind`} name="kind" required defaultValue="" className="h-10 rounded-xl border border-border bg-surface px-3 text-sm">
                <option value="" disabled>bitte wählen</option>
                {CONSENT_KINDS.map((k) => <option key={k} value={k}>{CONSENT_KIND_LABEL[k]}</option>)}
              </select>
              <label className="text-sm font-medium" htmlFor={`${p}-date`}>Erteilt am *</label>
              <input id={`${p}-date`} name="date" type="date" required max={today} defaultValue={today} className="h-10 rounded-xl border border-border bg-surface px-3 text-sm" />
              <label className="text-sm font-medium" htmlFor={`${p}-note`}>Wortlaut bzw. Nachweis *</label>
              <Textarea
                id={`${p}-note`}
                name="note"
                required
                minLength={3}
                maxLength={500}
                rows={3}
                placeholder={email ? "z. B. E-Mail vom 12.11.2026: „Bitte schicken Sie mir weitere Infos per E-Mail.“" : "z. B. Messe XY 10.11.2026, unterschriebenes Formular „Ja, Sie dürfen mich anrufen“"}
              />
              <p className="text-xs text-muted">
                {email
                  ? "Nötig ist eine vorherige ausdrückliche Einwilligung in Werbung per E-Mail. Eine bloße Anfrage oder eine öffentliche Adresse genügt nicht."
                  : "Nötig ist eine vorherige ausdrückliche Einwilligung in Werbeanrufe. Eine „mutmaßliche Einwilligung“ genügt nicht; eine veröffentlichte Nummer ist keine Einwilligung."}
              </p>
            </ActionForm>
          ) : (
            <p className="mt-1 text-xs text-muted">Zuerst eine E-Mail-Adresse eintragen.</p>
          )}
        </>
      )}
      {email ? <p className="mt-2 text-xs text-muted">Gilt für die eingetragene Adresse; ändert sich die E-Mail, wird die Einwilligung entfernt.</p> : null}
    </section>
  );
}
