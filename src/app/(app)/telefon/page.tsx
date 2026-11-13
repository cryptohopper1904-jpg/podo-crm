import { randomBytes } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Empty, PageHeader, Table } from "@/components/ui";
import { VoiceQuotaBanner, VoiceUsageBar } from "@/components/voice-quota-banner";
import { retellAgentConfig, vapiAssistantConfig } from "@/integrations/voice/assistant-config";
import { OUTCOME_LABEL } from "@/integrations/voice/core";
import { VOICE_VENDOR_LABEL } from "@/integrations/voice/voice-agent";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateTimeDe } from "@/lib/format";
import { NO_HOURS_NOTE } from "@/lib/opening-hours";
import { loadConnection } from "@/server/integrations";
import { listVoiceCalls, simulationAllowed, voiceMonthlyReport, voicePageInfo, voiceSetupState } from "@/server/voice";
import { saveVoiceSettingsAction } from "./actions";
import { CallSimulator } from "./call-simulator";
import { CopyField, DownloadButton, LiveToggle, VendorSetupForm } from "./setup-wizard";

export const metadata = { title: "Telefon" };

const OUTCOME_TONE: Record<string, "primary" | "info" | "accent" | "neutral"> = { booked: "primary", cancelled: "accent", callback: "info", failed: "accent" };

const duration = (s: number | null) => (s === null ? "–" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} Min.`);
const monthLabel = (m: string) => new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-15T12:00:00Z`));

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-soft-text">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
        <p className="font-semibold">{title}</p>
        {children}
      </div>
    </li>
  );
}

export default async function TelefonPage() {
  const auth = await requireAuth("messages.read");
  const org = auth.organization.id;
  const canSettings = auth.can("settings.manage");
  const canIntegrations = auth.can("integrations.manage");
  const calls = await listVoiceCalls(auth);
  const info = await voicePageInfo(auth);
  const report = await voiceMonthlyReport(auth, 6);
  const setup = canIntegrations ? await voiceSetupState(auth) : null;
  const canSimulate = auth.can("messages.write") && (await simulationAllowed(org));
  const { entitlement, usage } = info.quota;

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost"}`;
  const vendor = setup?.vendor ?? "vapi";
  const serverUrl = `${origin}/api/voice/${vendor}?org=${org}`;
  // Vorlage nur für Personen, die Schnittstellen verwalten dürfen (Vapi-Vorlage enthält das Secret)
  const config =
    setup && setup.hasSecret
      ? vendor === "vapi" && setup.vapiSecret
        ? { filename: "podocrm-vapi-assistant.json", content: vapiAssistantConfig({ serverUrl, secret: setup.vapiSecret, practiceName: auth.organization.name }) }
        : vendor === "retell"
          ? { filename: "podocrm-retell-agent.json", content: JSON.stringify(retellAgentConfig({ serverUrl, practiceName: auth.organization.name, recordingNotice: info.settings.storeTranscripts }), null, 2) }
          : null
      : null;
  const tomorrow = new Date(Date.parse(`${berlinDateIso()}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const status = setup?.status ?? (await loadConnection(org, "voice_agent"))?.status;
  const statusText = !status || status === "disconnected" ? "aus" : status === "mock" ? "Testmodus" : status === "connected" ? "live" : "Fehler";
  const isOwner = auth.role === "owner";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <PageHeader
        title="Telefon"
        subtitle="KI-Telefonassistent – Anrufe, Terminwünsche und Rückrufbitten"
        actions={<Badge tone={status === "connected" ? "primary" : "neutral"}>KI-Telefon: {statusText}</Badge>}
      />

      {isOwner && entitlement.enabled ? <VoiceQuotaBanner usage={usage} link={false} /> : null}

      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Der Assistent meldet sich immer als KI (EU AI Act), gibt keine medizinischen Auskünfte und verweist bei Notfällen an Ärztin/Arzt bzw. 112.
        Terminwünsche sind unbestätigt und keiner Akte zugeordnet – bitte im <Link className="underline" href="/posteingang">Posteingang</Link> zuordnen und bestätigen.
        Absagewünsche ändern nichts automatisch.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle action={entitlement.source === "addon" ? <Badge tone="info">Zusatzmodul</Badge> : null}>Nutzung diesen Monat</CardTitle>
          {entitlement.enabled ? (
            <>
              <VoiceUsageBar usage={usage} />
              <p className="mt-2 text-xs text-muted">
                Gezählt wird die Gesprächsdauer laut Anbieter (angefangene Minuten, Kalendermonat). Ist das Kontingent erschöpft, nimmt der Assistent keine
                Terminwünsche mehr an, sondern bittet um Geduld und legt eine Rückrufbitte in den Posteingang. Testanrufe zählen nicht.
              </p>
            </>
          ) : (
            <p className="text-sm">
              {entitlement.reason}{" "}
              {canSettings ? <Link className="underline" href="/einstellungen/abo">Abo & Tarif</Link> : null}
            </p>
          )}
        </Card>
        <Card>
          <CardTitle>Monatsbericht</CardTitle>
          <Table>
            <thead><tr><th>Monat</th><th>Anrufe</th><th>Gebucht</th><th>Rückrufe</th><th>Ø Dauer</th><th>Minuten</th></tr></thead>
            <tbody>
              {report.map((r) => (
                <tr key={r.month}>
                  <td className="whitespace-nowrap text-sm">{monthLabel(r.month)}</td>
                  <td className="text-sm tabular-nums">{r.calls}</td>
                  <td className="text-sm tabular-nums">{r.booked}</td>
                  <td className="text-sm tabular-nums">{r.callbacks}</td>
                  <td className="whitespace-nowrap text-sm tabular-nums">{duration(r.avgSec)}</td>
                  <td className="text-sm tabular-nums">{Math.ceil(r.totalSec / 60)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      {setup ? (
        <Card>
          <CardTitle action={<Badge tone={status === "connected" ? "primary" : "info"}>{VOICE_VENDOR_LABEL[vendor]} · {statusText}</Badge>}>Einrichtung</CardTitle>
          <ol className="flex flex-col gap-4">
            <Step n={1} title="Anbieter wählen und Zugang hinterlegen">
              <p className="text-muted">Konto beim Anbieter anlegen, AVV abschließen, deutsche Telefonnummer buchen. Unterstützt: Vapi und Retell AI.</p>
              <VendorSetupForm vendor={vendor} hasSecret={setup.hasSecret} />
            </Step>
            <Step n={2} title="Server-Adresse beim Anbieter eintragen">
              <p className="text-muted">
                {vendor === "retell"
                  ? "In Retell als Webhook-URL des Agenten und als URL jeder Custom Function (ist in der Vorlage schon eingetragen)."
                  : "In Vapi als Server URL des Assistenten und der Werkzeuge (ist in der Vorlage schon eingetragen)."}
              </p>
              <CopyField value={serverUrl} label="Adresse kopieren" />
              {vendor === "vapi" && setup.vapiSecret ? (
                <>
                  <p className="font-semibold">Server-URL-Secret (Header x-vapi-secret)</p>
                  <CopyField value={setup.vapiSecret} label="Secret kopieren" />
                  <p className="text-xs text-muted">Wie ein Passwort behandeln. Neu erzeugen: Schritt 1 mit neuem Secret speichern.</p>
                </>
              ) : null}
            </Step>
            <Step n={3} title="Fertige Assistenten-Konfiguration herunterladen">
              {config ? (
                <>
                  <p className="text-muted">
                    {vendor === "retell"
                      ? "Enthält Prompt (KI-Hinweis, keine medizinische Beratung, Notfall → 116 117/112), Begrüßung und alle Funktionen. Der API-Schlüssel steht nicht in der Datei."
                      : "Enthält Prompt (KI-Hinweis, keine medizinische Beratung, Notfall → 116 117/112), Werkzeuge, Server-Adresse und Secret. In Vapi unter Assistant → JSON einfügen."}
                  </p>
                  <div><DownloadButton filename={config.filename} content={config.content} label={`Vorlage für ${VOICE_VENDOR_LABEL[vendor]} herunterladen`} /></div>
                  <details>
                    <summary className="cursor-pointer text-xs font-semibold">Vorschau</summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{config.content}</pre>
                  </details>
                </>
              ) : (
                <p className="text-danger">Erst Schritt 1 speichern{vendor === "retell" ? " (API-Schlüssel ist Pflicht)" : ""}.</p>
              )}
            </Step>
            <Step n={4} title="Testanruf simulieren">
              {canSimulate ? (
                <>
                  <p className="text-muted">Läuft durch denselben Code wie echte {VOICE_VENDOR_LABEL[vendor]}-Aufrufe (inkl. Kontingent) und legt echte Test-Einträge an. Zählt nicht zum Kontingent.</p>
                  <CallSimulator initialCallId={`sim-${randomBytes(6).toString("hex")}`} tomorrow={tomorrow} service={info.services[0]?.code ?? "PK"} vendor={vendor} />
                </>
              ) : (
                <p className="text-muted">Nur im Testmodus möglich. Für einen echten Testanruf die gebuchte Nummer anrufen.</p>
              )}
            </Step>
            <Step n={5} title="Live schalten">
              {!entitlement.enabled ? <p className="text-danger">{entitlement.reason}</p> : null}
              <LiveToggle live={status === "connected"} disabled={!entitlement.enabled && status !== "connected"} />
              <p className="text-xs text-muted">Im Testmodus werden Aufrufe des Anbieters in Produktion abgelehnt. Live nur mit hinterlegtem Zugang und freigeschaltetem Tarif.</p>
            </Step>
          </ol>
        </Card>
      ) : canSimulate ? (
        <Card>
          <CardTitle>Testanruf simulieren</CardTitle>
          <p className="mb-3 text-sm text-muted">Nur Entwicklung/Testmodus. Läuft durch denselben Code wie echte Aufrufe und legt echte Test-Einträge an.</p>
          <CallSimulator initialCallId={`sim-${randomBytes(6).toString("hex")}`} tomorrow={tomorrow} service={info.services[0]?.code ?? "PK"} />
        </Card>
      ) : null}

      <Card>
        <CardTitle>Was der Assistent weiß</CardTitle>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="font-semibold">Öffnungszeiten</p>
            <p>{info.opening ? `${info.opening}; an Feiertagen geschlossen.` : `${NO_HOURS_NOTE}. Der Assistent nennt keine Öffnungszeiten.`} Freie Termine richten sich nach den Arbeitszeiten und Abwesenheiten im Team.</p>
            {canSettings ? <Link className="text-xs underline" href="/einstellungen/oeffnungszeiten">Öffnungszeiten ändern</Link> : null}
            <p className="mt-3 font-semibold">Telefonisch buchbare Leistungen</p>
            <p>{info.services.length ? info.services.map((s) => `${s.code} – ${s.name} (${s.durationMin} Min.)`).join(" · ") : "keine"}</p>
            {canSettings ? <Link className="text-xs underline" href="/einstellungen/leistungen">Leistungen verwalten</Link> : null}
          </div>
          <div>
            {canSettings ? (
              <ActionForm action={saveVoiceSettingsAction} className="flex flex-col gap-2">
                <Checkbox name="storeTranscripts" defaultChecked={info.settings.storeTranscripts} label="Transkripte speichern" />
                <p className="text-xs text-muted">
                  Wird nur wirksam, wenn die erste Ansage auf die Aufzeichnung hinweist (Vorlage „firstMessageMitAufzeichnung“ bzw. Retell-Vorlage nach dem Speichern neu herunterladen). Sonst werden nur Zusammenfassung, Dauer und Ergebnis gespeichert.
                  Datenschutz: Zweck, Speicherdauer und AVV mit dem Anbieter im Verzeichnis der Verarbeitungstätigkeiten dokumentieren.
                </p>
              </ActionForm>
            ) : (
              <p>Transkripte speichern: {info.settings.storeTranscripts ? "ja" : "nein"}</p>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>Anrufe</CardTitle>
        {calls.length === 0 ? (
          <Empty title="Noch keine Anrufe">Sobald der Assistent Anrufe annimmt, erscheinen sie hier.</Empty>
        ) : (
          <Table>
            <thead><tr><th>Zeit</th><th>Anrufer</th><th>Dauer</th><th>Ergebnis</th><th>Zusammenfassung</th><th>Termin</th></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap text-sm tabular-nums">{dateTimeDe(c.startedAt)}</td>
                  <td className="whitespace-nowrap text-sm tabular-nums">{c.callerMasked ?? "unbekannt"}</td>
                  <td className="whitespace-nowrap text-sm">{duration(c.durationSec)}</td>
                  <td>{c.outcome ? <Badge tone={OUTCOME_TONE[c.outcome] ?? "neutral"}>{OUTCOME_LABEL[c.outcome] ?? c.outcome}</Badge> : "–"}</td>
                  <td className="text-sm text-muted">{c.summary ?? "–"}{c.hasTranscript ? <span className="block text-xs">Transkript gespeichert</span> : null}</td>
                  <td className="whitespace-nowrap text-sm">
                    {c.appointmentId && c.appointmentStartsAt ? (
                      <Link className="underline" href={`/kalender?datum=${berlinDateIso(c.appointmentStartsAt)}`}>{dateTimeDe(c.appointmentStartsAt)}</Link>
                    ) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
