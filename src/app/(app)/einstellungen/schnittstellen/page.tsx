import Link from "next/link";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Field, Input, Select, Table } from "@/components/ui";
import { withOrg } from "@/db";
import { integrationConnections } from "@/db/schema";
import { HMAC_WEBHOOK_SECRET, PROVIDER_CATALOG, STATUS_LABEL, TOKEN_WEBHOOK_PROVIDERS } from "@/integrations/catalog";
import { requireAuth } from "@/lib/auth/session";
import { calendarToken } from "@/lib/calendar-token";
import { dateTimeDe } from "@/lib/format";
import { decryptSecret } from "@/lib/secrets";
import { recentSyncLog } from "@/server/integrations";
import { webhookStatus } from "@/server/webhooks";
import { saveIntegrationAction, testIntegrationAction } from "./actions";
import { MailCard } from "./mail-card";

export const metadata = { title: "Schnittstellen" };

const tone = { mock: "info", connected: "primary", error: "accent", disconnected: "neutral" } as const;

export default async function IntegrationsSettings() {
  const auth = await requireAuth("integrations.manage");
  const org = auth.organization.id;
  const rows = await withOrg(org, (tx) => tx.select().from(integrationConnections).where(eq(integrationConnections.organizationId, org)));
  const log = await recentSyncLog(org, 15);
  const hooks = await webhookStatus(org);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost"}`;
  const mockEnv = process.env.INTEGRATIONS_MODE === "mock";

  let feedUrl: string | null = null;
  try {
    feedUrl = `${origin}/api/calendar/${calendarToken(auth.user.id)}.ics`;
  } catch {
    feedUrl = null;
  }

  return (
    <div className="flex flex-col gap-4">
      {mockEnv ? (
        <p className="rounded-xl bg-info-soft p-4 text-sm text-info-soft-text">
          Diese Installation läuft im Testmodus (INTEGRATIONS_MODE=mock): Alle Schnittstellen verwenden Testdaten, es wird nichts an Fremdsysteme gesendet.
        </p>
      ) : null}
      <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
        Für jede echte Schnittstelle, über die Patientendaten fließen, ist ein Auftragsverarbeitungsvertrag (AVV, Art. 28 DSGVO) nötig.
        Zugangsdaten werden verschlüsselt gespeichert und nie wieder angezeigt.
      </p>

      <MailCard auth={auth} />

      {PROVIDER_CATALOG.map((info) => {
        const row = rows.find((r) => r.provider === info.provider);
        const status = row?.status ?? "disconnected";
        let secretValues: Record<string, string> = {};
        if (row?.secretEnc) {
          try {
            secretValues = JSON.parse(decryptSecret(row.secretEnc, org));
          } catch {
            secretValues = {};
          }
        }
        // Nur Namen der hinterlegten Felder anzeigen – Werte nie (Ausnahme: Webhook-Token in der Webhook-Adresse)
        const storedKeys = Object.keys(secretValues);
        const cfg = (row?.config ?? {}) as Record<string, unknown>;
        return (
          <Card key={info.provider}>
            <CardTitle action={<Badge tone={tone[status]}>{STATUS_LABEL[status]}</Badge>}>{info.label}</CardTitle>
            <p className="mb-2 text-sm">{info.description}</p>
            <p className="mb-4 text-sm text-muted"><strong>Datenschutz:</strong> {info.privacy}{info.docs ? <> · <a className="underline" href={info.docs} target="_blank" rel="noreferrer">Doku</a></> : null}</p>
            {row?.lastError ? <p className="mb-3 text-sm text-danger">Letzter Fehler: {row.lastError}</p> : null}
            {row?.lastSyncAt ? <p className="mb-3 text-xs text-muted">Zuletzt erfolgreich: {dateTimeDe(row.lastSyncAt)}</p> : null}
            {TOKEN_WEBHOOK_PROVIDERS.includes(info.provider) || HMAC_WEBHOOK_SECRET[info.provider] ? (
              <div className="mb-3 text-xs text-muted">
                Webhook-Adresse:{" "}
                {TOKEN_WEBHOOK_PROVIDERS.includes(info.provider) ? (
                  secretValues.webhookToken ? (
                    <code className="break-all">{`${origin}/api/webhooks/${info.provider}?org=${org}&token=${secretValues.webhookToken}`}</code>
                  ) : (
                    <span>wird beim ersten Speichern erzeugt</span>
                  )
                ) : (
                  <code className="break-all">{`${origin}/api/webhooks/${info.provider}?org=${org}`}</code>
                )}
                <span className="block">
                  {TOKEN_WEBHOOK_PROVIDERS.includes(info.provider)
                    ? "Enthält ein geheimes Token – wie ein Passwort behandeln. Ohne gültiges Token werden Aufrufe abgelehnt."
                    : `Aufrufe werden nur mit gültiger Signatur angenommen – „${info.secretFields.find((f) => f.name === HMAC_WEBHOOK_SECRET[info.provider])?.label}“ ist Pflicht.`}
                </span>
              </div>
            ) : null}
            <ActionForm action={saveIntegrationAction}>
              <input type="hidden" name="provider" value={info.provider} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Modus">
                  <Select name="status" defaultValue={status === "error" ? "connected" : status}>
                    <option value="disconnected">aus</option>
                    <option value="mock">Testmodus</option>
                    <option value="connected">verbunden (echt)</option>
                  </Select>
                </Field>
                {info.secretFields.map((f) => (
                  <Field key={f.name} label={f.label} hint={[f.hint, storedKeys.includes(f.name) ? "hinterlegt – leer lassen, um beizubehalten" : "nicht hinterlegt"].filter(Boolean).join(" · ")}>
                    <Input name={`secret_${f.name}`} type="password" autoComplete="off" placeholder={storedKeys.includes(f.name) ? "••••••••" : ""} />
                  </Field>
                ))}
                {info.configFields.map((f) => (
                  <Field key={f.name} label={f.label} hint={f.hint}>
                    <Input name={`config_${f.name}`} defaultValue={typeof cfg[f.name] === "string" ? (cfg[f.name] as string) : ""} placeholder={f.placeholder} />
                  </Field>
                ))}
              </div>
              {info.provider === "llm" || info.provider === "transcription" ? (
                <Checkbox
                  name="dataProcessingApproved"
                  defaultChecked={cfg.dataProcessingApproved === true}
                  label="Ich bestätige: Anbieter verarbeitet in der EU, AVV liegt vor, Zero Data Retention und kein Training auf unseren Daten."
                />
              ) : null}
              {TOKEN_WEBHOOK_PROVIDERS.includes(info.provider) && secretValues.webhookToken ? (
                <Checkbox name="rotateWebhookToken" label="Webhook-Token neu erzeugen (alte Adresse wird ungültig)" />
              ) : null}
              {storedKeys.length ? (
                <div className="flex flex-wrap gap-4">
                  {info.secretFields.filter((f) => storedKeys.includes(f.name)).map((f) => (
                    <Checkbox key={f.name} name={`clear_${f.name}`} label={`${f.label} löschen`} />
                  ))}
                </div>
              ) : null}
            </ActionForm>
            <div className="mt-3">
              <ActionForm action={testIntegrationAction} submit="Verbindung testen" className="flex flex-col gap-2">
                <input type="hidden" name="provider" value={info.provider} />
              </ActionForm>
            </div>
          </Card>
        );
      })}

      <Card>
        <CardTitle>Kalender-Feed (iCal, ausgehend)</CardTitle>
        <p className="mb-2 text-sm">Ihre Termine in Apple-, Google- oder Outlook-Kalender abonnieren. Der Feed enthält keine Namen – nur Initialen und Leistung.</p>
        <p className="mb-2 text-sm text-muted">Doctolib- oder Google-Termine <em>in</em> PodoHero übernehmen: <Link href="/einstellungen/kalender-abo" className="font-semibold underline">Einstellungen → Kalender-Abo</Link>.</p>
        {feedUrl ? <code className="block break-all rounded-xl bg-surface-2 p-3 text-xs">{feedUrl}</code> : <p className="text-sm text-danger">APP_ENCRYPTION_KEY fehlt – Feed nicht verfügbar.</p>}
        <p className="mt-2 text-xs text-muted">Den Link wie ein Passwort behandeln und nicht weitergeben.</p>
      </Card>

      <Card>
        <CardTitle>Eingehende Ereignisse (Webhooks)</CardTitle>
        <p className="mb-3 text-sm text-muted">
          Zahlungen und Nachrichten werden erst gespeichert und dann verarbeitet. Schlägt die Verarbeitung fehl, wird sie automatisch wiederholt
          (bis zu 6 Versuche über etwa 2,5 Stunden); danach erscheint ein Hinweis im Posteingang. Inhalte werden nach erfolgreicher Verarbeitung gelöscht,
          die Einträge nach 30 Tagen.
        </p>
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          <Badge tone="primary">verarbeitet: {hooks.counts.done ?? 0}</Badge>
          <Badge tone="info">in Arbeit: {(hooks.counts.pending ?? 0) + (hooks.counts.processing ?? 0)}</Badge>
          <Badge tone="warn">Wiederholung geplant: {hooks.counts.failed ?? 0}</Badge>
          <Badge tone="accent">aufgegeben: {hooks.counts.dead ?? 0}</Badge>
        </div>
        {hooks.problems.length ? (
          <Table>
            <thead><tr><th>Eingang</th><th>Schnittstelle</th><th>Status</th><th>Versuche</th><th>Nächster Versuch</th><th>Fehler</th></tr></thead>
            <tbody>
              {hooks.problems.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap text-sm tabular-nums">{dateTimeDe(h.receivedAt)}</td>
                  <td className="text-sm">{PROVIDER_CATALOG.find((p) => p.provider === h.provider)?.label ?? h.provider}</td>
                  <td className="text-sm">{{ pending: "wartet", processing: "in Arbeit", failed: "Wiederholung", dead: "aufgegeben" }[h.status] ?? h.status}</td>
                  <td className="text-sm tabular-nums">{h.attempts}</td>
                  <td className="whitespace-nowrap text-sm tabular-nums">{h.nextAttemptAt ? dateTimeDe(h.nextAttemptAt) : "–"}</td>
                  <td className="text-sm text-muted">{h.error ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>

      <Card>
        <CardTitle>Letzte Synchronisationen</CardTitle>
        {log.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Einträge.</p>
        ) : (
          <Table>
            <thead><tr><th>Zeit</th><th>Schnittstelle</th><th>Richtung</th><th>Ergebnis</th><th>Meldung</th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap text-sm tabular-nums">{dateTimeDe(l.at)}</td>
                  <td className="text-sm">{PROVIDER_CATALOG.find((p) => p.provider === l.provider)?.label ?? l.provider}</td>
                  <td className="text-sm">{l.direction}</td>
                  <td>{l.ok ? <Badge tone="primary">ok</Badge> : <Badge tone="accent">Fehler</Badge>}</td>
                  <td className="text-sm text-muted">{l.message ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
