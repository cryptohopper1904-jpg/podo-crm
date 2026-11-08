import { randomBytes } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Empty, PageHeader, Table } from "@/components/ui";
import { OUTCOME_LABEL } from "@/integrations/voice/core";
import { VapiVoiceAgent } from "@/integrations/voice/vapi";
import assistantTemplate from "@/integrations/voice/vapi-assistant.json";
import { requireAuth } from "@/lib/auth/session";
import { berlinDateIso, dateTimeDe } from "@/lib/format";
import { decryptSecret } from "@/lib/secrets";
import { loadConnection } from "@/server/integrations";
import { listVoiceCalls, simulationAllowed, voicePageInfo } from "@/server/voice";
import { saveVoiceSettingsAction } from "./actions";
import { CallSimulator } from "./call-simulator";

export const metadata = { title: "Telefon" };

const OUTCOME_TONE: Record<string, "primary" | "info" | "accent" | "neutral"> = { booked: "primary", cancelled: "accent", callback: "info", failed: "accent" };

const duration = (s: number | null) => (s === null ? "–" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} Min.`);

export default async function TelefonPage() {
  const auth = await requireAuth("messages.read");
  const org = auth.organization.id;
  const [calls, info, conn] = await Promise.all([listVoiceCalls(auth), voicePageInfo(auth), loadConnection(org, "voice_agent")]);
  const canSettings = auth.can("settings.manage");
  const canIntegrations = auth.can("integrations.manage");
  const canSimulate = auth.can("messages.write") && (await simulationAllowed(org));

  // Server-Adresse + Secret nur für Personen, die Schnittstellen verwalten dürfen (Secret wie ein Passwort behandeln)
  let secret: string | null = null;
  if (canIntegrations && conn?.secretEnc) {
    try {
      secret = VapiVoiceAgent.sharedSecret(JSON.parse(decryptSecret(conn.secretEnc, org)));
    } catch {
      secret = null;
    }
  }
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost"}`;
  const serverUrl = `${origin}/api/voice/vapi?org=${org}`;
  const filledTemplate =
    canIntegrations && secret
      ? JSON.stringify(assistantTemplate.assistant, null, 2)
          .replaceAll("<SERVER_URL>", serverUrl)
          .replaceAll("<SERVER_SECRET>", secret)
          .replaceAll("<PRAXISNAME>", auth.organization.name.replace(/["\\]/g, ""))
      : null;
  const tomorrow = new Date(Date.parse(`${berlinDateIso()}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const statusText = !conn || conn.status === "disconnected" ? "aus" : conn.status === "mock" ? "Testmodus" : conn.status === "connected" ? "verbunden" : "Fehler";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <PageHeader title="Telefon" subtitle="KI-Telefonassistent (Pilot) – Anrufe, Terminwünsche und Rückrufbitten" actions={<Badge tone={conn?.status === "connected" ? "primary" : "neutral"}>Schnittstelle: {statusText}</Badge>} />

      <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
        Der Assistent meldet sich immer als KI (EU AI Act), gibt keine medizinischen Auskünfte und verweist bei Notfällen an Ärztin/Arzt bzw. 112.
        Terminwünsche sind unbestätigt und keiner Akte zugeordnet – bitte im <Link className="underline" href="/posteingang">Posteingang</Link> zuordnen und bestätigen.
        Absagewünsche ändern nichts automatisch.
      </p>

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

      <Card>
        <CardTitle>Einstellungen</CardTitle>
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <p className="font-semibold">Öffnungszeiten für den Assistenten</p>
            <p>Mo–Fr {info.opening.start}–{info.opening.end} Uhr, an Feiertagen geschlossen. Freie Termine richten sich nach den Arbeitszeiten und Abwesenheiten im Team.</p>
            {canSettings ? <Link className="text-xs underline" href="/einstellungen/praxis">Öffnungszeiten ändern</Link> : null}
            <p className="mt-3 font-semibold">Telefonisch buchbare Leistungen</p>
            <p>{info.services.length ? info.services.map((s) => `${s.code} – ${s.name} (${s.durationMin} Min.)`).join(" · ") : "keine"}</p>
          </div>
          <div>
            {canSettings ? (
              <ActionForm action={saveVoiceSettingsAction} className="flex flex-col gap-2">
                <Checkbox name="storeTranscripts" defaultChecked={info.settings.storeTranscripts} label="Transkripte speichern" />
                <p className="text-xs text-muted">
                  Wird nur wirksam, wenn die erste Ansage auf die Aufzeichnung hinweist (Vorlage „firstMessageMitAufzeichnung“). Sonst werden nur Zusammenfassung, Dauer und Ergebnis gespeichert.
                  Datenschutz: Zweck, Speicherdauer und AVV mit dem Anbieter im Verzeichnis der Verarbeitungstätigkeiten dokumentieren.
                </p>
              </ActionForm>
            ) : (
              <p>Transkripte speichern: {info.settings.storeTranscripts ? "ja" : "nein"}</p>
            )}
          </div>
        </div>
        {canIntegrations ? (
          <div className="mt-4 border-t border-border pt-4 text-sm">
            <p className="font-semibold">Server-Adresse für Vapi</p>
            <code className="block break-all rounded-xl bg-surface-2 p-3 text-xs">{serverUrl}</code>
            <p className="mt-3 font-semibold">Server-URL-Secret (Header x-vapi-secret)</p>
            {secret ? (
              <code className="block break-all rounded-xl bg-surface-2 p-3 text-xs">{secret}</code>
            ) : (
              <p className="text-danger">Noch kein Secret – unter <Link className="underline" href="/einstellungen/schnittstellen">Einstellungen → Schnittstellen</Link> „KI-Telefonagent“ einmal speichern (Anbieter vapi).</p>
            )}
            <p className="mt-1 text-xs text-muted">Wie ein Passwort behandeln. Ohne gültiges Secret und ohne verbundene Schnittstelle werden alle Aufrufe abgelehnt.</p>
            {filledTemplate ? (
              <details className="mt-3">
                <summary className="cursor-pointer font-semibold">Assistenten-Vorlage für Vapi (Prompt + Werkzeuge, ausgefüllt)</summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{filledTemplate}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </Card>

      {canSimulate ? (
        <Card>
          <CardTitle>Anruf simulieren</CardTitle>
          <p className="mb-3 text-sm text-muted">Nur Entwicklung/Testmodus. Läuft durch denselben Code wie echte Vapi-Aufrufe und legt echte (Test-)Einträge an.</p>
          <CallSimulator initialCallId={`sim-${randomBytes(6).toString("hex")}`} tomorrow={tomorrow} service={info.services[0]?.code ?? "PK"} />
        </Card>
      ) : null}
    </div>
  );
}
