import Link from "next/link";
import { Lock, Users } from "lucide-react";
import { notFound } from "next/navigation";
import { Badge, Button, Card, CardTitle, Empty, FormSuccess, LinkButton, pageTitleBox, pageTitleCls, BackLink } from "@/components/ui";
import { RiskBadges } from "@/components/risk-badges";
import { requireAuth } from "@/lib/auth/session";
import { anamnesisSummary, initialFromRiskFlags } from "@/lib/anamnesis";
import { dateDe, dateTimeDe, fullName } from "@/lib/format";
import { listAnamneses } from "@/server/anamnesis";
import { handoverAction, revokeLinkAction } from "./actions";
import { AnamnesisForm } from "./anamnesis-form";
import { LinkPanel } from "./link-panel";

export const metadata = { title: "Anamnese" };

const LINK_STATE: Record<string, string> = { valid: "offen", used: "ausgefüllt", revoked: "widerrufen", expired: "abgelaufen" };

export default async function AnamnesisPage(props: PageProps<"/kunden/[id]/anamnese">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const auth = await requireAuth("patients.read");
  const data = await listAnamneses(auth, id);
  if (!data) notFound();
  const latest = data.versions[0];
  const latestOnline = latest?.source === "online";
  const canEdit = auth.can("medical.write");
  const editing = canEdit && (sp.neu === "1" || data.versions.length === 0);
  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className={pageTitleBox}>
          <BackLink href={`/kunden/${id}`} label={`Akte ${fullName(data.patient)}`} />
          <h1 className={pageTitleCls}>Anamnese</h1>
          <div className="mt-2"><RiskBadges flags={data.patient.riskFlags} /></div>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          {canEdit && !editing ? <LinkButton href={`/kunden/${id}/anamnese?neu=1`} variant="secondary">{latestOnline ? "Online-Angaben prüfen und übernehmen" : "Anamnese aktualisieren"}</LinkButton> : null}
          {auth.can("medical.read") ? <LinkButton href={`/kunden/${id}/anamnese/drucken`} variant="ghost">Drucken / PDF</LinkButton> : null}
        </div>
      </header>

      {/* Zwei Wege, den Bogen mit der Patient:in auszufüllen – der gesicherte (Gerät gesperrt) zuerst */}
      {auth.can("patients.write") || canEdit ? (
        <section aria-labelledby="ausfuellen-titel" className="mb-6 rounded-[var(--radius-card)] border border-border bg-surface p-4 sm:p-5">
          <h2 id="ausfuellen-titel" className="mb-3 font-display text-lg font-semibold">Bogen am Praxis-Gerät ausfüllen lassen</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {auth.can("patients.write") ? (
              <form action={handoverAction} className="flex flex-col gap-1.5">
                <input type="hidden" name="patientId" value={id} />
                <Button type="submit" className="w-full"><Lock size={18} aria-hidden /> An Patient:in übergeben</Button>
                <p className="text-[13px] leading-5 text-muted">Das Gerät wird gesperrt: Die Patient:in sieht nur den Fragebogen. Zurück in die App nur mit deiner PIN oder deinem Passwort.</p>
              </form>
            ) : null}
            {canEdit ? (
              <div className="flex flex-col gap-1.5">
                <LinkButton href={`/kunden/${id}/anamnese/bogen`} variant="secondary" className="w-full"><Users size={18} aria-hidden /> Gemeinsam ausfüllen</LinkButton>
                <p className="text-[13px] leading-5 text-muted">Ihr füllt den Bogen zusammen aus (große Felder fürs iPad). Die ganze App bleibt offen – das Gerät nicht aus der Hand geben.</p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {sp.uebergabe === "fehler" ? <p role="alert" className="mb-4 rounded-xl bg-accent-soft px-4 py-3 text-sm font-medium text-accent-soft-text">Übergabe nicht möglich (gerade parallel ein Link erzeugt?). Bitte erneut versuchen.</p> : null}
      {sp.gespeichert ? <div className="mb-4"><FormSuccess message="Anamnese als neue Version gespeichert. Frühere Versionen bleiben erhalten." /></div> : null}

      {editing ? (
        <section className="mb-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3">
            <h2 className="min-w-0 font-display text-xl font-semibold">{latest ? "Neue Version (vorausgefüllt mit der letzten Angabe)" : "Erstanamnese"}</h2>
            {data.versions.length ? <Link href={`/kunden/${id}/anamnese`} className="inline-flex min-h-11 items-center text-sm font-semibold text-primary">Abbrechen</Link> : null}
          </div>
          <AnamnesisForm patientId={id} initial={latest?.data ?? initialFromRiskFlags(data.patient.riskFlags)} />
        </section>
      ) : null}

      <div className="flex flex-wrap gap-6">
        <div className="flex min-w-0 flex-[2_1_480px] flex-col gap-6">
          {latest ? (
            <Card>
              <CardTitle action={<Badge tone={latestOnline ? "warn" : "primary"}>{latestOnline ? "online vom Patienten, ungeprüft" : "Praxis"}</Badge>}>
                Aktuell · {dateDe(latest.createdAt)}
              </CardTitle>
              {latest.data ? (
                <dl className="grid gap-3 sm:grid-cols-2">
                  {anamnesisSummary(latest.data).map(([k, v]) => (
                    <div key={k} className={k === "Medikamente" || k === "Notizen" ? "sm:col-span-2" : ""}>
                      <dt className="text-[13px] leading-5 font-semibold text-muted">{k}</dt>
                      <dd className="mt-0.5 whitespace-pre-wrap">{v}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted">Inhalte der Anamnese sind nur für Behandler:innen sichtbar.</p>
              )}
            </Card>
          ) : !editing ? (
            <Empty title="Noch keine Anamnese">Erfasse die Anamnese in der Praxis oder schick der Patient:in einen Online-Link.</Empty>
          ) : null}

          {data.versions.length > 1 ? (
            <Card>
              <CardTitle>Verlauf ({data.versions.length} Versionen)</CardTitle>
              <ol className="flex flex-col">
                {data.versions.map((v, i) => (
                  <li key={v.id} className="border-t border-border py-3 first:border-t-0">
                    {v.data ? (
                      <details>
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm">
                          <span className="font-semibold">{dateTimeDe(v.createdAt)}</span> · {v.source === "online" ? "online vom Patienten" : v.author ?? "Praxis"}{i === 0 ? " · aktuell" : ""}
                        </summary>
                        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                          {anamnesisSummary(v.data).map(([k, val]) => (
                            <div key={k}><dt className="text-muted">{k}</dt><dd className="whitespace-pre-wrap">{val}</dd></div>
                          ))}
                        </dl>
                      </details>
                    ) : (
                      <p className="text-sm"><span className="font-semibold">{dateTimeDe(v.createdAt)}</span> · {v.source === "online" ? "online vom Patienten" : v.author ?? "Praxis"}</p>
                    )}
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-6">
          {auth.can("patients.write") ? (
            <Card>
              <CardTitle>Online-Anamnese</CardTitle>
              <p className="mb-3 text-sm text-muted">Einmal-Link, 7 Tage gültig. Der Patient sieht nur seinen Vornamen und den Fragebogen.</p>
              <LinkPanel patientId={id} firstName={data.patient.firstName} practiceName={auth.organization.name} />
              {data.links.length ? (
                <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-3 text-sm">
                  {data.links.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2">
                      <span className="flex-1">{dateDe(l.createdAt)} · bis {dateDe(l.expiresAt)}</span>
                      <Badge tone={l.state === "valid" ? "info" : l.state === "used" ? "primary" : "neutral"}>{LINK_STATE[l.state]}</Badge>
                      {l.state === "valid" ? (
                        <form action={revokeLinkAction}>
                          <input type="hidden" name="patientId" value={id} />
                          <input type="hidden" name="linkId" value={l.id} />
                          <button type="submit" className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-danger hover:bg-surface-2">widerrufen</button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}
          <Card>
            <CardTitle>Hinweise</CardTitle>
            <ul className="list-disc pl-5 text-sm text-muted">
              <li>Jede Erfassung wird als neue Version gespeichert (unveränderbar).</li>
              <li>Zusatzfragen (Diabetes, Sensibilität) erscheinen nur, wenn sie zutreffen – Datensparsamkeit.</li>
              <li>Online-Angaben bitte im Gespräch prüfen und als Praxis-Version bestätigen.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
