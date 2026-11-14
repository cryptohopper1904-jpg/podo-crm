import { ActionForm } from "@/components/action-form";
import { Badge, Card, CardTitle, Checkbox, Field, Input, Select } from "@/components/ui";
import { requireAuth } from "@/lib/auth/session";
import { dateTimeDe } from "@/lib/format";
import { therapists } from "@/server/appointments";
import { FEED_WINDOW, listCalendarFeeds, MAX_FEEDS_PER_ORG } from "@/server/calendar-feeds";
import { createFeedAction, deleteFeedAction, syncFeedNowAction, updateFeedAction } from "./actions";

export const metadata = { title: "Kalender-Abo" };

const SOURCE_LABEL = { doctolib: "Doctolib", extern: "Extern" } as const;

export default async function CalendarFeedSettings() {
  const auth = await requireAuth("integrations.manage");
  const [feeds, team] = await Promise.all([listCalendarFeeds(auth), therapists(auth)]);

  const therapistSelect = (name: string, value: string | null) => (
    <Select name={name} defaultValue={value ?? ""}>
      <option value="">– keine Zuordnung –</option>
      {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
  const sourceSelect = (value: string) => (
    <Select name="source" defaultValue={value}>
      <option value="doctolib">Doctolib (über Docal.io / CalMedi gespiegelt)</option>
      <option value="extern">Extern (anderer Kalender)</option>
    </Select>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Kalender-Abo: Doctolib-Termine automatisch in PodoHero</CardTitle>
        <p className="mb-3 text-sm">
          Doctolib bietet keine offene Schnittstelle. Mit einem Synchronisationsdienst wie <strong>Docal.io</strong> oder <strong>CalMedi</strong> landen
          deine Doctolib-Buchungen in einem Google-Kalender. PodoHero liest diesen Kalender über die <strong>private iCal-Adresse</strong> etwa alle
          5 Minuten (nur lesend) und zeigt die Termine im Kalender und auf „Heute“ an – gekennzeichnet mit „aus Kalender-Abo“.
        </p>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Docal.io oder CalMedi einrichten und Doctolib mit einem (am besten eigenen) Google-Kalender verbinden.</li>
          <li>Google Kalender im Browser öffnen → Zahnrad <strong>Einstellungen</strong> → links unter „Einstellungen für meine Kalender“ den Kalender wählen.</li>
          <li>Ganz unten bei „Kalender integrieren“ die <strong>Privatadresse im iCal-Format</strong> kopieren (endet auf <code>basic.ics</code>).</li>
          <li>Adresse unten einfügen, Behandler:in wählen und speichern. Der erste Abruf startet sofort.</li>
        </ol>
        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Übernommen werden Termine von {FEED_WINDOW.pastDays} Tagen zurück bis {FEED_WINDOW.futureDays} Tage voraus. Absagen und Verschiebungen werden übernommen; ganztägige Einträge nicht.</li>
          <li>Termine werden <strong>nie automatisch</strong> einer Patient:in zugeordnet – im Kalender „Patient:in zuordnen“ wählen.</li>
          <li>Importierte Termine sind nur lesend: Absagen und Verschieben bitte in Doctolib. In PodoHero geänderte Termine werden nicht überschrieben.</li>
          <li>Überschneidungen mit PodoHero-Terminen derselben Behandler:in werden im Kalender und auf „Heute“ markiert.</li>
        </ul>
        <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn-soft-text">
          <strong>Datenschutz:</strong> Termine in Doctolib, im Sync-Dienst (Docal.io bzw. CalMedi) und im Google-Kalender enthalten Namen deiner
          Patient:innen und zeigen, dass sie podologisch behandelt werden. Das sind Gesundheitsdaten (Art. 9 DSGVO), die außerdem der Schweigepflicht
          (§ 203 StGB) unterliegen. Diese Anbieter sind deine eigenen Auftragsverarbeiter, unabhängig von PodoHero. Nutze dafür nur ein geschäftliches
          Google-Workspace-Konto, kein privates Google- oder Gmail-Konto, denn nur mit Workspace kannst du einen Auftragsverarbeitungsvertrag (AVV,
          Art. 28 DSGVO) abschließen. Schließe auch mit dem Sync-Dienst einen AVV und verpflichte beide Anbieter zur Verschwiegenheit (§ 203 Abs. 4
          StGB). Google verarbeitet Daten auch in den USA. Wähle, wenn deine Workspace-Edition das anbietet, die EU-Datenregion. Trage keine Diagnosen
          in Titel oder Beschreibung ein. Stimme den Einsatz im Zweifel mit deiner/deinem Datenschutzbeauftragten ab.
          Die private iCal-Adresse ist wie ein Passwort: Sie wird verschlüsselt gespeichert und nie wieder angezeigt. Wurde sie weitergegeben, in
          Google „Zurücksetzen“ wählen und die neue Adresse hier eintragen.
        </p>
      </Card>

      {feeds.map((f) => {
        const r = f.lastResult ?? {};
        const conflicts = (f.conflicts.local_change ?? 0) + (f.conflicts.overlap ?? 0);
        return (
          <Card key={f.id}>
            <CardTitle
              action={
                !f.active ? <Badge tone="neutral">pausiert</Badge> : f.lastError ? <Badge tone="accent">Fehler</Badge> : f.lastSyncAt ? <Badge tone="primary">aktiv</Badge> : <Badge tone="info">noch nicht abgerufen</Badge>
              }
            >
              {f.label}
            </CardTitle>
            <p className="mb-2 text-sm text-muted">
              Adresse: <code>{f.urlHint}</code> · Quelle: {SOURCE_LABEL[f.source as keyof typeof SOURCE_LABEL] ?? f.source}
            </p>
            {f.lastError ? <p className="mb-2 text-sm text-danger">Letzter Fehler: {f.lastError}{f.lastAttemptAt ? ` (${dateTimeDe(f.lastAttemptAt)})` : ""}</p> : null}
            {f.lastSyncAt ? (
              <p className="mb-2 text-[13px] text-muted">
                Zuletzt erfolgreich: {dateTimeDe(f.lastSyncAt)}
                {typeof r.events === "number" ? ` · ${r.events} Einträge, ${r.created ?? 0} neu, ${r.updated ?? 0} geändert, ${r.cancelled ?? 0} abgesagt` : ""}
                {r.rruleSkipped ? ` · ${r.rruleSkipped} Serien mit nicht unterstützter Regel übersprungen` : ""}
                {r.invalid ? ` · ${r.invalid} unlesbare Einträge` : ""}
              </p>
            ) : null}
            {conflicts ? (
              <p className="mb-3 text-sm">
                {f.conflicts.overlap ? <Badge tone="accent">{f.conflicts.overlap} Überschneidungen</Badge> : null}{" "}
                {f.conflicts.local_change ? <Badge tone="warn">{f.conflicts.local_change} in PodoHero geändert (Kalender-Änderungen nicht übernommen)</Badge> : null}
              </p>
            ) : null}
            <div className="mb-4">
              <ActionForm action={syncFeedNowAction} submit="Jetzt abrufen" className="flex flex-col gap-2">
                <input type="hidden" name="id" value={f.id} />
              </ActionForm>
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Bearbeiten</summary>
              <div className="mt-3">
                <ActionForm action={updateFeedAction}>
                  <input type="hidden" name="id" value={f.id} />
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Bezeichnung"><Input name="label" defaultValue={f.label} maxLength={80} required /></Field>
                    <Field label="Behandler:in (für neue Termine)">{therapistSelect("therapistId", f.therapistId)}</Field>
                    <Field label="Termine kennzeichnen als">{sourceSelect(f.source)}</Field>
                    <Field label="Neue iCal-Adresse" hint="leer lassen, um die gespeicherte Adresse zu behalten">
                      <Input name="url" type="password" autoComplete="off" placeholder="••••••••" />
                    </Field>
                  </div>
                  <Checkbox name="active" defaultChecked={f.active} label="Aktiv (automatischer Abruf alle 5 Minuten)" />
                </ActionForm>
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <ActionForm action={deleteFeedAction} submit="Kalender-Abo entfernen">
                  <input type="hidden" name="id" value={f.id} />
                  <Checkbox name="confirm" label="Ja, entfernen. Künftige, unveränderte Termine aus diesem Abo werden abgesagt (nicht gelöscht)." />
                </ActionForm>
              </div>
            </details>
          </Card>
        );
      })}

      {feeds.length < MAX_FEEDS_PER_ORG ? (
        <Card>
          <CardTitle>{feeds.length ? "Weiteres Kalender-Abo hinzufügen" : "Kalender-Abo hinzufügen"}</CardTitle>
          <ActionForm action={createFeedAction} submit="Speichern und abrufen">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Private iCal-Adresse" hint={<span className="break-all">https://calendar.google.com/calendar/ical/…/private-…/basic.ics</span>} className="sm:col-span-2">
                <Input name="url" type="password" autoComplete="off" required placeholder="https://…/basic.ics" />
              </Field>
              <Field label="Bezeichnung"><Input name="label" required maxLength={80} placeholder="z. B. Doctolib – Praxis Mitte" /></Field>
              <Field label="Behandler:in für importierte Termine">{therapistSelect("therapistId", null)}</Field>
              <Field label="Termine kennzeichnen als">{sourceSelect("doctolib")}</Field>
            </div>
            <Checkbox name="avv" label="Mit Google (geschäftliches Workspace-Konto) und dem Sync-Dienst (Docal.io/CalMedi) habe ich einen AVV abgeschlossen." />
          </ActionForm>
        </Card>
      ) : null}
    </div>
  );
}
