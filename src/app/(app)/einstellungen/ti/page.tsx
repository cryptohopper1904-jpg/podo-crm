import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Field, Input, Select } from "@/components/ui";
import { withOrg } from "@/db";
import { integrationConnections } from "@/db/schema";
import { STATUS_LABEL } from "@/integrations/catalog";
import { KIM_CONNECTION_PROVIDER } from "@/integrations/kim/provider";
import { isMockMode } from "@/integrations/registry";
import { HiddenAreaNotice } from "@/components/hidden-area-notice";
import { requireAuth } from "@/lib/auth/session";
import { feature } from "@/lib/features";
import { dateTimeDe } from "@/lib/format";
import { TI_ITEM_STATES, TI_ITEMS, TI_STATE_LABEL, tiProgress } from "@/lib/ti-checklist";
import { loadConnection } from "@/server/integrations";
import { loadTiSettings } from "@/server/ti";
import { saveTiChecklistAction, testKimAction } from "./actions";

export const metadata = { title: "TI & KIM" };

const tone = { done: "primary", requested: "info", open: "neutral" } as const;

export default async function TiSettingsPage() {
  const auth = await requireAuth("settings.manage");
  const org = auth.organization.id;
  if (!feature(auth.organization, "ti")) {
    // nur Privat-/Selbstzahler: TI wird nicht gebraucht; ist KIM schon eingerichtet, bleibt ein kurzer Hinweis
    const kimConn = await loadConnection(org, KIM_CONNECTION_PROVIDER);
    return (
      <div className="flex flex-col gap-4">
        <HiddenAreaNotice area="ti" />
        {kimConn && kimConn.status !== "disconnected" ? (
          <Card>
            <CardTitle action={<Badge tone={kimConn.status === "connected" ? "primary" : "neutral"}>{STATUS_LABEL[kimConn.status]}</Badge>}>KIM ist eingerichtet</CardTitle>
            <p className="text-sm text-muted">
              Die KIM-Verbindung bleibt bestehen und wird weiter im Posteingang abgerufen. Zugangsdaten ändern oder trennen unter{" "}
              <Link className="underline" href="/einstellungen/schnittstellen">Einstellungen → Schnittstellen → KIM</Link>.
            </p>
          </Card>
        ) : null}
      </div>
    );
  }
  const ti = await loadTiSettings(auth);
  const progress = tiProgress(ti);
  const kim = await loadConnection(org, KIM_CONNECTION_PROVIDER);
  const kimMock = isMockMode(kim);
  const kimAddress = typeof kim?.config?.address === "string" ? kim.config.address : null;
  const [lastSync] = kim
    ? await withOrg(org, (tx) =>
        tx
          .select({ lastSyncAt: integrationConnections.lastSyncAt, lastError: integrationConnections.lastError })
          .from(integrationConnections)
          .where(and(eq(integrationConnections.organizationId, org), eq(integrationConnections.provider, KIM_CONNECTION_PROVIDER))),
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn-soft-text">
        <strong>Wichtig:</strong> PodoHero ist <strong>kein zertifiziertes TI-Produkt</strong> und stellt selbst keine Verbindung zur
        Telematikinfrastruktur her. Für den echten Anschluss braucht Ihre Praxis SMC-B (Praxisausweis), ggf. eHBA, einen Konnektor oder ein
        TI-Gateway und einen KIM-Anbieter. PodoHero nutzt die Standard-Schnittstellen dieser Komponenten (KIM: POP3/SMTP über TLS;
        eVerordnung: Import von FHIR-Dateien). Hintergrund und Ablauf: <code>docs/TI.md</code>.
      </p>

      <Card>
        <CardTitle action={<Badge tone={progress.done === progress.total ? "primary" : "info"}>{progress.done} von {progress.total} erledigt</Badge>}>Checkliste TI-Anschluss</CardTitle>
        <p className="mb-4 text-sm text-muted">Selbstauskunft der Praxis zur Orientierung – wird nicht gegen die TI geprüft. Kosten bitte beim jeweiligen Anbieter erfragen.</p>
        <ActionForm action={saveTiChecklistAction}>
          <div className="flex flex-col gap-4">
            {TI_ITEMS.map((i) => {
              const it = ti.items[i.key];
              return (
                <div key={i.key} className="grid gap-3 rounded-xl border border-border p-3 md:grid-cols-[1fr_12rem_16rem]">
                  <div>
                    <p className="font-semibold">
                      {i.label} <Badge tone={tone[it.state]}>{TI_STATE_LABEL[it.state]}</Badge>
                    </p>
                    <p className="text-sm text-muted">{i.hint}</p>
                    {i.key === "kim" && kimAddress ? <p className="mt-1 text-sm">Hinterlegte KIM-Adresse: <code>{kimAddress}</code></p> : null}
                  </div>
                  <Field label="Stand">
                    <Select name={`state_${i.key}`} defaultValue={it.state}>
                      {TI_ITEM_STATES.map((s) => <option key={s} value={s}>{TI_STATE_LABEL[s]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Notiz (z. B. Datum, Ansprechpartner)">
                    <Input name={`note_${i.key}`} defaultValue={it.note} maxLength={200} />
                  </Field>
                </div>
              );
            })}
            <Field label="TI-/KIM-Anbieter (Freitext)" className="max-w-md">
              <Input name="provider" defaultValue={ti.provider} maxLength={120} placeholder="z. B. Name des Gateway- bzw. KIM-Anbieters" />
            </Field>
            {ti.updatedAt ? <p className="text-xs text-muted">Zuletzt geändert: {dateTimeDe(new Date(ti.updatedAt))}</p> : null}
          </div>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle action={<Badge tone={kimMock ? "info" : kim?.status === "connected" ? "primary" : kim?.status === "error" ? "accent" : "neutral"}>{kimMock ? "Testmodus" : STATUS_LABEL[kim?.status ?? "disconnected"]}</Badge>}>KIM-Verbindung</CardTitle>
        {kimMock ? (
          <p className="mb-3 rounded-xl bg-info-soft p-3 text-sm text-info-soft-text">
            Testmodus: „KIM abrufen“ im Posteingang liefert zwei erfundene Beispielnachrichten, Antworten werden nur gespeichert, nicht versendet.
            Es besteht keine Verbindung zur TI.
          </p>
        ) : null}
        <p className="mb-2 text-sm">
          Zugangsdaten (KIM-Adresse, Benutzername, POP3S-/SMTPS-Host des Clientmoduls bzw. Gateways, Passwort) unter{" "}
          <Link className="underline" href="/einstellungen/schnittstellen">Einstellungen → Schnittstellen → KIM</Link>. Das Passwort wird verschlüsselt gespeichert.
        </p>
        <ul className="mb-3 list-disc pl-6 text-sm text-muted">
          <li>Abruf: manuell im Posteingang („KIM abrufen“) und automatisch alle 15 Minuten (Cron).</li>
          <li>Nachrichten werden nie automatisch einer Person zugeordnet – PodoHero schlägt nur vor (KVNR, Name, Geburtsdatum).</li>
          <li>Anhänge (z. B. PDF-Arztbriefe) werden nicht übernommen, nur ihre Namen. Antworten per KIM: nur Text.</li>
          <li>Das Clientmodul muss für den PodoHero-Server per TLS über einen öffentlichen Hostnamen erreichbar sein (z. B. TI-Gateway-Dienst); lokale Adressen im Praxisnetz sind aus Sicherheitsgründen gesperrt.</li>
        </ul>
        {lastSync?.lastSyncAt ? <p className="mb-2 text-xs text-muted">Zuletzt erfolgreich: {dateTimeDe(lastSync.lastSyncAt)}</p> : null}
        {lastSync?.lastError ? <p className="mb-2 text-sm text-danger">Letzter Fehler: {lastSync.lastError}</p> : null}
        <ActionForm action={testKimAction} submit="KIM-Verbindung testen" className="flex flex-col gap-2">
          <span className="text-sm text-muted">Meldet sich am KIM-Postfach an und zählt die Nachrichten – es wird nichts gelesen oder gelöscht.</span>
        </ActionForm>
      </Card>

      <Card>
        <CardTitle>eVerordnung (Heilmittel)</CardTitle>
        <p className="text-sm">
          Die Heilmittel-eVerordnung ist laut gematik geplant – <strong>Stand prüfen</strong>, sie ist noch nicht überall verfügbar. Sobald Sie
          Verordnungen als FHIR-Datei erhalten, können Sie sie unter <Link className="underline" href="/verordnungen/import">Verordnungen → eVerordnung importieren</Link> übernehmen.
        </p>
      </Card>
    </div>
  );
}
